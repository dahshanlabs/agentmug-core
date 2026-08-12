// OpenAI LlmClient — second provider alongside Anthropic.
//
// The engine talks to LlmClient; the abstraction in llm.ts is shaped
// around Anthropic's tool_use / tool_result content blocks. OpenAI's
// chat-completions API uses a different shape — function tool_calls
// on the assistant message + role:"tool" replies for results. This
// adapter translates at the SDK boundary so the engine doesn't care.
//
// Streaming notes:
//   - OpenAI streams text deltas the same way as Anthropic (chunked
//     content). We yield text_delta events as they arrive.
//   - Tool calls are streamed in pieces — `id` arrives on chunk 1,
//     `function.name` on chunk 2, `function.arguments` over many
//     chunks. We accumulate by `tool_calls[].index` and emit them
//     as tool_use content blocks at finalization.
//   - Token usage arrives in the final chunk via stream_options:
//     { include_usage: true }.

import OpenAI from "openai";
import type {
  LlmClient,
  LlmContentBlock,
  LlmMessage,
  LlmStreamEvent,
  LlmStreamParams,
  LlmToolDefinition,
} from "./llm";
import { encodeToolName, decodeToolName } from "./tool-name-codec";
import { normalizeExplicitToolPropertyTypes } from "./tool-schema-compat";

export type OpenAiLlmClientOptions = {
  apiKey: string;
  /** Optional base URL — useful for Azure OpenAI / OpenRouter proxies,
   *  OpenAI-compatible vendors, and local endpoints (Ollama, LM Studio). */
  baseURL?: string;
  /** Set to true when running in a browser/webview shell. */
  dangerouslyAllowBrowser?: boolean;
  /**
   * Custom fetch implementation. On desktop (Tauri webview) the global
   * fetch is CORS-bound; passing the Tauri native-HTTP fetch here routes
   * the request through the Rust process, bypassing CORS (required for
   * every OpenAI-compatible vendor + local endpoints, which don't send
   * permissive browser CORS headers).
   */
  fetch?: typeof fetch;
  /**
   * Force plain `max_tokens` even for a model id that matches the
   * reasoning heuristic (o1/o3/o4/gpt-5). Set for custom / local
   * endpoints where a model happens to be named e.g. "gpt-5-local" but
   * speaks the standard chat-completions dialect (accepts max_tokens,
   * rejects max_completion_tokens).
   */
  forcePlainMaxTokens?: boolean;
  /**
   * For user-supplied OpenAI-compatible endpoints, retry once with the other
   * token-limit parameter only when the provider returns a 400 explicitly
   * identifying the attempted parameter as unsupported. This accommodates
   * both local servers (`max_tokens`) and reasoning-model gateways
   * (`max_completion_tokens`) without retrying auth, quota, or model errors.
   */
  autoNegotiateMaxTokens?: boolean;
};

export class OpenAiLlmClient implements LlmClient {
  private client: OpenAI;
  private forcePlainMaxTokens: boolean;
  private autoNegotiateMaxTokens: boolean;

  constructor(options: OpenAiLlmClientOptions) {
    this.forcePlainMaxTokens = options.forcePlainMaxTokens ?? false;
    this.autoNegotiateMaxTokens = options.autoNegotiateMaxTokens ?? false;
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      dangerouslyAllowBrowser: options.dangerouslyAllowBrowser,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  async *streamMessage(params: LlmStreamParams): AsyncIterable<LlmStreamEvent> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: params.system },
    ];
    for (const m of params.messages) {
      for (const expanded of toOpenAiMessages(m)) {
        messages.push(expanded);
      }
    }

    const isKimiK3 = params.model.toLowerCase() === "kimi-k3";
    const usesExplicitToolPropertyTypes = requiresExplicitToolPropertyTypes(
      params.model,
    );
    const tools = params.tools?.map((tool) =>
      toOpenAiTool(tool, usesExplicitToolPropertyTypes),
    );
    const isReasoning =
      !this.forcePlainMaxTokens && openAiUsesCompletionTokenLimit(params.model);

    const requestFor = (
      tokenParameter: TokenLimitParameter,
      includeUsage: boolean,
    ): OpenAI.Chat.ChatCompletionCreateParamsStreaming => ({
      model: params.model,
      messages,
      stream: true,
      ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
      ...(tokenParameter === "max_completion_tokens"
        ? { max_completion_tokens: params.maxTokens }
        : { max_tokens: params.maxTokens }),
      // K3 defaults to max effort. High preserves frontier execution quality
      // without letting routine tool turns spend their whole token budget on
      // hidden reasoning. Keep this stable across the conversation so prefix
      // caching remains valid.
      ...(isReasoning && params.reasoningEffort
        ? { reasoning_effort: params.reasoningEffort }
        : isKimiK3
          ? { reasoning_effort: "high" as const }
          : {}),
      ...(tools && tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
    });
    const requestOptions = params.signal
      ? { signal: params.signal }
      : undefined;
    let tokenParameter: TokenLimitParameter = isReasoning
      ? "max_completion_tokens"
      : "max_tokens";
    let includeUsage = true;
    let tokenParameterNegotiated = false;
    let streamOptionsNegotiated = false;
    const createStream = (parameter: TokenLimitParameter, usage: boolean) =>
      this.client.chat.completions.create(
        requestFor(parameter, usage),
        requestOptions,
      );
    let stream: Awaited<ReturnType<typeof createStream>>;
    for (;;) {
      try {
        stream = await createStream(tokenParameter, includeUsage);
        break;
      } catch (error) {
        if (
          this.autoNegotiateMaxTokens &&
          includeUsage &&
          !streamOptionsNegotiated &&
          isExplicitlyUnsupportedOpenAiParameterError(error, "stream_options")
        ) {
          includeUsage = false;
          streamOptionsNegotiated = true;
          continue;
        }
        if (
          this.autoNegotiateMaxTokens &&
          !tokenParameterNegotiated &&
          isExplicitlyUnsupportedOpenAiParameterError(error, tokenParameter)
        ) {
          tokenParameter =
            tokenParameter === "max_tokens"
              ? "max_completion_tokens"
              : "max_tokens";
          tokenParameterNegotiated = true;
          continue;
        }
        throw error;
      }
    }

    const toolCallsAcc = new Map<
      number,
      { id?: string; name?: string; arguments?: string }
    >();
    let reasoningAcc = "";
    let textAcc = "";
    let stopReason = "end_turn";
    let inputTokens = 0;
    let outputTokens = 0;
    let providerUsageReported = false;

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (choice) {
        const delta = choice.delta;
        // Kimi K3 (and some other OpenAI-compatible reasoning models) stream
        // this vendor extension. Preserve it separately from visible output:
        // K3 requires the complete assistant message, including
        // reasoning_content, to be replayed verbatim after tool calls.
        const reasoningDelta = (
          delta as typeof delta & { reasoning_content?: string | null }
        )?.reasoning_content;
        if (reasoningDelta) {
          reasoningAcc += reasoningDelta;
          yield { type: "thinking_delta", text: reasoningDelta };
        }
        if (delta?.content) {
          textAcc += delta.content;
          yield { type: "text_delta", text: delta.content };
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            const acc = toolCallsAcc.get(idx) ?? {};
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) {
              acc.name = (acc.name ?? "") + tc.function.name;
            }
            if (tc.function?.arguments) {
              acc.arguments = (acc.arguments ?? "") + tc.function.arguments;
            }
            toolCallsAcc.set(idx, acc);
          }
        }
        if (choice.finish_reason) {
          stopReason = mapStopReason(choice.finish_reason);
        }
      }
      if (
        chunk.usage &&
        Number.isSafeInteger(chunk.usage.prompt_tokens) &&
        chunk.usage.prompt_tokens > 0 &&
        Number.isSafeInteger(chunk.usage.completion_tokens) &&
        chunk.usage.completion_tokens > 0
      ) {
        // Compatibility gateways sometimes emit a truthy, partial usage
        // object or zero placeholders. A successful streamed completion
        // cannot have either, so only a complete positive pair is an exact
        // receipt. Otherwise the engine must retain its conservative floor.
        providerUsageReported = true;
        inputTokens = chunk.usage.prompt_tokens;
        outputTokens = chunk.usage.completion_tokens;
      }
    }

    const usage = providerUsageReported ? "exact" : "estimated";
    if (this.autoNegotiateMaxTokens && !providerUsageReported) {
      // Older compatible servers may stream correctly but omit usage. Retain
      // a bounded, deliberately conservative provider estimate instead of a
      // false zero receipt. Provider-reported usage still wins whenever sent.
      inputTokens = Math.max(
        1,
        Math.ceil(
          JSON.stringify({ system: params.system, messages, tools }).length / 3,
        ),
      );
      outputTokens = Math.max(1, Math.ceil(params.maxTokens));
    }

    if (inputTokens > 0) {
      yield { type: "input_tokens", count: inputTokens, usage };
    }
    if (outputTokens > 0) {
      yield { type: "output_tokens", count: outputTokens, usage };
    }

    const content: LlmContentBlock[] = [];
    if (reasoningAcc) {
      content.push({ type: "thinking", thinking: reasoningAcc });
    }
    if (textAcc) {
      content.push({ type: "text", text: textAcc });
    }
    for (const tc of toolCallsAcc.values()) {
      if (!tc.id || !tc.name) continue;
      let input: Record<string, unknown> = {};
      if (tc.arguments) {
        try {
          input = JSON.parse(tc.arguments) as Record<string, unknown>;
        } catch {
          // Malformed args from partial stream — store the raw string
          // so the executor at least sees what the model tried to call.
          input = { _raw: tc.arguments };
        }
      }
      // Restore the dotted name the engine's registry is keyed on.
      content.push({
        type: "tool_use",
        id: tc.id,
        name: decodeToolName(tc.name),
        input,
      });
    }

    yield { type: "message_complete", stopReason, content };
  }
}

type TokenLimitParameter = "max_tokens" | "max_completion_tokens";

export function openAiUsesCompletionTokenLimit(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return (
    normalized === "o1" ||
    normalized === "o3" ||
    normalized === "o4" ||
    normalized.startsWith("o1-") ||
    normalized.startsWith("o3-") ||
    normalized.startsWith("o4-") ||
    normalized.startsWith("gpt-5") ||
    normalized === "kimi-k3"
  );
}

export function isExplicitlyUnsupportedOpenAiParameterError(
  error: unknown,
  attempted: string,
): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    status?: unknown;
    code?: unknown;
    param?: unknown;
    message?: unknown;
    error?: { code?: unknown; param?: unknown; message?: unknown };
  };
  if (candidate.status !== 400) return false;

  const code = String(
    candidate.code ?? candidate.error?.code ?? "",
  ).toLowerCase();
  const param = String(
    candidate.param ?? candidate.error?.param ?? "",
  ).toLowerCase();
  const message = String(
    candidate.message ?? candidate.error?.message ?? "",
  ).toLowerCase();
  const namesAttemptedParameter =
    param === attempted || message.includes(attempted);
  const declaresUnsupported =
    code === "unsupported_parameter" ||
    code === "unknown_parameter" ||
    /(?:unsupported|unknown|unrecognized|not supported|does not support|not allowed|invalid parameter)/.test(
      message,
    );
  return namesAttemptedParameter && declaresUnsupported;
}

function toOpenAiTool(
  tool: LlmToolDefinition,
  usesExplicitToolPropertyTypes: boolean,
): OpenAI.Chat.ChatCompletionTool {
  return {
    type: "function",
    function: {
      // OpenAI rejects dots in function names (^[a-zA-Z0-9_-]{1,64}$); encode
      // them for the wire and decode when the model calls the tool back.
      name: encodeToolName(tool.name),
      description: tool.description,
      // Moonshot and Gemini validate schema nodes more strictly than standard
      // JSON Schema. Normalize a clone at the provider boundary so valid
      // enum-only schemas from Nango/MCP cannot reject the entire request.
      parameters: usesExplicitToolPropertyTypes
        ? normalizeExplicitToolPropertyTypes(tool.inputSchema)
        : tool.inputSchema,
    },
  };
}

function requiresExplicitToolPropertyTypes(model: string): boolean {
  const normalized = model.toLowerCase();
  return (
    normalized.startsWith("kimi-") ||
    normalized.startsWith("moonshot-") ||
    normalized.includes("/kimi-") ||
    normalized.includes("/moonshot") ||
    normalized.startsWith("gemini-") ||
    normalized.startsWith("google.") ||
    normalized.includes("/gemini-")
  );
}

/**
 * Expand a single LlmMessage into one or more OpenAI messages. The
 * mismatch we have to handle:
 *   - Anthropic puts tool_result blocks INSIDE the user message.
 *   - OpenAI requires each tool_result to be its own role:"tool"
 *     message with a tool_call_id, separate from any user text.
 * So a single user message containing N tool_result blocks + some
 * text becomes N "tool" messages + (optionally) one "user" message.
 */
function toOpenAiMessages(
  msg: LlmMessage,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  if (typeof msg.content === "string") {
    return [{ role: msg.role, content: msg.content }];
  }
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  const textParts: string[] = [];
  const imageParts: Array<{ data: string; mediaType: string }> = [];
  const thinkingParts: string[] = [];
  const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];
  const toolResults: { tool_call_id: string; content: string }[] = [];
  for (const block of msg.content) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "image") {
      imageParts.push({ data: block.data, mediaType: block.mediaType });
    } else if (block.type === "thinking") {
      thinkingParts.push(block.thinking);
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          // Must match the encoded name declared in the tools array.
          name: encodeToolName(block.name),
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    } else if (block.type === "tool_result") {
      toolResults.push({
        tool_call_id: block.tool_use_id,
        content: block.content,
      });
    }
  }
  if (msg.role === "assistant") {
    const assistantMsg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
      role: "assistant",
      content: textParts.join("") || null,
    };
    if (toolCalls.length > 0) {
      assistantMsg.tool_calls = toolCalls;
    }
    if (thinkingParts.length > 0) {
      // reasoning_content is an OpenAI-compatible vendor extension not yet in
      // the SDK's ChatCompletionAssistantMessageParam type.
      (
        assistantMsg as typeof assistantMsg & { reasoning_content: string }
      ).reasoning_content = thinkingParts.join("");
    }
    out.push(assistantMsg);
  } else {
    // user-role: emit tool results first (they reply to the prior
    // assistant turn), then any free-form user text after.
    for (const tr of toolResults) {
      out.push({
        role: "tool",
        tool_call_id: tr.tool_call_id,
        content: tr.content,
      });
    }
    if (textParts.length > 0 || imageParts.length > 0) {
      if (imageParts.length === 0) {
        out.push({ role: "user", content: textParts.join("") });
      } else {
        // Mixed text + image — OpenAI's vision API expects an array of
        // content parts. Order matters less than presence; we send text
        // first so the model has framing context before the images.
        const parts: OpenAI.Chat.ChatCompletionContentPart[] = [];
        if (textParts.length > 0)
          parts.push({ type: "text", text: textParts.join("") });
        for (const img of imageParts) {
          parts.push({
            type: "image_url",
            image_url: { url: `data:${img.mediaType};base64,${img.data}` },
          });
        }
        out.push({ role: "user", content: parts });
      }
    }
  }
  return out;
}

function mapStopReason(openaiReason: string): string {
  // Map OpenAI finish_reason to the Anthropic-shaped stopReason the
  // engine expects.
  switch (openaiReason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "stop_sequence";
    default:
      return "end_turn";
  }
}
