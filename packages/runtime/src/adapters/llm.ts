// LLM client interface and the default Anthropic implementation.
//
// The interface is what the engine depends on. The Anthropic wrapper
// is bundled here because the SDK is portable across every deployment
// target (cloud, desktop, Docker). Other LLM providers can ship as
// separate implementations of LlmClient without touching the engine.

import Anthropic from "@anthropic-ai/sdk";
import { encodeToolName, decodeToolName } from "./tool-name-codec";

export type LlmTextBlock = { type: "text"; text: string };

export type LlmToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type LlmToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
};

/**
 * Inline image content block — wraps base64-encoded image data so the
 * agent can see what the user uploaded. Phase 15 vision input.
 * Provider clients (AnthropicLlmClient, OpenAiLlmClient) translate
 * this to their native image block shape at send time.
 */
export type LlmImageBlock = {
  type: "image";
  /** Base64-encoded image bytes (no data:... prefix). */
  data: string;
  /** Standard MIME — image/png | image/jpeg | image/webp | image/gif. */
  mediaType: string;
};

/**
 * Extended-thinking block (Anthropic). The `signature` is REQUIRED to be
 * preserved and replayed verbatim on later turns — when thinking is on and the
 * assistant also calls a tool, Anthropic rejects the follow-up unless the
 * original thinking block (with its signature) is present in the assistant
 * message. So we keep it round-trippable, not stringified away.
 */
export type LlmThinkingBlock = {
  type: "thinking";
  thinking: string;
  signature?: string;
};

/** Redacted-thinking block (Anthropic) — opaque, but must also round-trip. */
export type LlmRedactedThinkingBlock = {
  type: "redacted_thinking";
  data: string;
};

export type LlmContentBlock =
  | LlmTextBlock
  | LlmToolUseBlock
  | LlmToolResultBlock
  | LlmImageBlock
  | LlmThinkingBlock
  | LlmRedactedThinkingBlock;

export type LlmMessage = {
  role: "user" | "assistant";
  content: string | LlmContentBlock[];
};

export type LlmToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type LlmStreamParams = {
  model: string;
  maxTokens: number;
  system: string;
  messages: LlmMessage[];
  tools?: LlmToolDefinition[];
  /**
   * Optional abort signal. When the host aborts a run (e.g. the
   * desktop Cmd+. interrupt), the engine forwards this to the LLM
   * client so the underlying SDK fetch is cancelled mid-stream
   * rather than running to completion before abort lands.
   */
  signal?: AbortSignal;
  /**
   * Optional Anthropic extended thinking. When set, the model reasons in a
   * visible "thinking" block before answering (budget_tokens caps that
   * reasoning). Non-Anthropic clients ignore it. The caller must ensure
   * maxTokens > budget_tokens (max_tokens covers thinking + output).
   */
  thinking?: { type: "enabled"; budget_tokens: number };
};

export type LlmStreamEvent =
  | { type: "text_delta"; text: string }
  // Streamed extended-thinking text (Anthropic). Lets the UI show the
  // model's reasoning in real time, separate from the final answer.
  | { type: "thinking_delta"; text: string }
  | { type: "input_tokens"; count: number }
  | { type: "output_tokens"; count: number }
  // Prompt-caching usage (Anthropic). cache_read = tokens served from the
  // cache (~0.1x input price); cache_creation = tokens written to the cache
  // (~1.25x input price). Providers without caching simply never emit these.
  | { type: "cache_read_tokens"; count: number }
  | { type: "cache_creation_tokens"; count: number }
  | {
      type: "message_complete";
      stopReason: string;
      content: LlmContentBlock[];
    };

export interface LlmClient {
  streamMessage(params: LlmStreamParams): AsyncIterable<LlmStreamEvent>;
}

export type AnthropicLlmClientOptions = {
  apiKey: string;
  baseURL?: string;
  /**
   * Set to true when running the runtime inside a browser/webview
   * (e.g. the AgentMug Desktop Tauri shell). The Anthropic SDK
   * normally refuses to run in a browser to prevent leaking keys
   * baked into web apps; in a desktop shell the "browser" is local
   * to the user's machine and the key is user-supplied, so the
   * warning doesn't apply.
   */
  dangerouslyAllowBrowser?: boolean;
  /**
   * Custom fetch implementation. On desktop (Tauri webview) the global
   * fetch is CORS-bound; passing the Tauri native-HTTP fetch here routes
   * the request through the Rust process, bypassing CORS. Node callers
   * (CLI, cloud) leave this undefined and use the default fetch.
   */
  fetch?: typeof fetch;
};

export class AnthropicLlmClient implements LlmClient {
  private client: Anthropic;

  constructor(options: AnthropicLlmClientOptions) {
    this.client = new Anthropic({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      dangerouslyAllowBrowser: options.dangerouslyAllowBrowser,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  async *streamMessage(
    params: LlmStreamParams,
  ): AsyncIterable<LlmStreamEvent> {
    const sdkMessages = params.messages.map(toSdkMessage);
    const sdkTools = params.tools?.map(toSdkTool);
    // Prompt caching. The system prompt and tool schemas are identical across
    // every turn of a run (and across back-to-back runs of the same agent),
    // yet were re-sent and re-billed at full input price each turn — a 16-turn
    // loop paid for the frozen prefix ~16x. Mark a cache breakpoint at the end
    // of the system block and on the last tool so Anthropic caches that prefix
    // (turn 1 writes at ~1.25x; turns 2-16 read at ~0.1x). cache_control is
    // ignored when the prefix is below the model's minimum, so this is safe.
    if (sdkTools && sdkTools.length > 0) {
      const last = sdkTools[sdkTools.length - 1];
      sdkTools[sdkTools.length - 1] = {
        ...last,
        cache_control: { type: "ephemeral" },
      };
    }
    const sdkSystem: Anthropic.MessageCreateParams["system"] = params.system
      ? [{ type: "text", text: params.system, cache_control: { type: "ephemeral" } }]
      : params.system;

    const stream = this.client.messages.stream(
      {
        model: params.model,
        max_tokens: params.maxTokens,
        system: sdkSystem,
        messages: sdkMessages,
        ...(sdkTools && sdkTools.length > 0 ? { tools: sdkTools } : {}),
        // Extended thinking — when the agent opts in. budget_tokens caps the
        // reasoning; the engine guarantees max_tokens > budget_tokens.
        ...(params.thinking ? { thinking: params.thinking } : {}),
      },
      // Forward the abort signal to the SDK fetch so an in-flight
      // generation cancels immediately on abort (not at next turn).
      params.signal ? { signal: params.signal } : undefined,
    );

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        yield { type: "text_delta", text: event.delta.text };
      } else if (
        event.type === "content_block_delta" &&
        event.delta.type === "thinking_delta"
      ) {
        yield { type: "thinking_delta", text: event.delta.thinking };
      } else if (event.type === "message_start" && event.message.usage) {
        const usage = event.message.usage;
        yield { type: "input_tokens", count: usage.input_tokens };
        if (usage.cache_read_input_tokens) {
          yield { type: "cache_read_tokens", count: usage.cache_read_input_tokens };
        }
        if (usage.cache_creation_input_tokens) {
          yield { type: "cache_creation_tokens", count: usage.cache_creation_input_tokens };
        }
      } else if (event.type === "message_delta" && event.usage) {
        yield {
          type: "output_tokens",
          count: event.usage.output_tokens,
        };
      }
    }

    const final = await stream.finalMessage();
    yield {
      type: "message_complete",
      stopReason: final.stop_reason ?? "end_turn",
      content: final.content.map(fromSdkBlock),
    };
  }
}

function toSdkMessage(message: LlmMessage): Anthropic.MessageParam {
  if (typeof message.content === "string") {
    return { role: message.role, content: message.content };
  }
  return {
    role: message.role,
    content: message.content.map(toSdkBlock),
  };
}

function toSdkBlock(
  block: LlmContentBlock,
):
  | Anthropic.TextBlockParam
  | Anthropic.ToolUseBlockParam
  | Anthropic.ToolResultBlockParam
  | Anthropic.ImageBlockParam
  | Anthropic.ThinkingBlockParam
  | Anthropic.RedactedThinkingBlockParam {
  if (block.type === "text") {
    return { type: "text", text: block.text };
  }
  if (block.type === "thinking") {
    // Replay verbatim, signature included — Anthropic validates it.
    return { type: "thinking", thinking: block.thinking, signature: block.signature ?? "" };
  }
  if (block.type === "redacted_thinking") {
    return { type: "redacted_thinking", data: block.data };
  }
  if (block.type === "tool_use") {
    return {
      type: "tool_use",
      id: block.id,
      // Must match the encoded name declared in the tools array.
      name: encodeToolName(block.name),
      input: block.input,
    };
  }
  if (block.type === "image") {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type:
          block.mediaType as "image/png" | "image/jpeg" | "image/webp" | "image/gif",
        data: block.data,
      },
    };
  }
  return {
    type: "tool_result",
    tool_use_id: block.tool_use_id,
    content: block.content,
  };
}

function toSdkTool(tool: LlmToolDefinition): Anthropic.Tool {
  return {
    // Anthropic rejects dots in tool names (^[a-zA-Z0-9_-]{1,128}$); encode
    // them for the wire and decode in fromSdkBlock when the model calls back.
    name: encodeToolName(tool.name),
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool["input_schema"],
  };
}

function fromSdkBlock(
  block: Anthropic.ContentBlock,
): LlmContentBlock {
  if (block.type === "text") {
    return { type: "text", text: block.text };
  }
  if (block.type === "tool_use") {
    return {
      type: "tool_use",
      id: block.id,
      // Restore the dotted name the engine's registry is keyed on.
      name: decodeToolName(block.name),
      input: (block.input ?? {}) as Record<string, unknown>,
    };
  }
  // Extended thinking — preserve verbatim (signature included) so it can be
  // replayed on tool-use turns. This is what the audit flagged as "dropped".
  if (block.type === "thinking") {
    return { type: "thinking", thinking: block.thinking, signature: block.signature };
  }
  if (block.type === "redacted_thinking") {
    return { type: "redacted_thinking", data: block.data };
  }
  // Defensive: any other block type (server_tool_use, etc.) is normalized to
  // text so the engine can still record something.
  return { type: "text", text: JSON.stringify(block) };
}
