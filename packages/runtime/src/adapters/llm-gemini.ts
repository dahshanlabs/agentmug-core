// Gemini LLM client.
//
// Third provider behind Anthropic + OpenAI. Same interface
// (LlmClient.streamMessage) so the engine, executors, observability
// stack — all of it — are oblivious to which LLM is actually
// answering. Routed by model id prefix in llm-multi.ts.
//
// Gemini's API shape (the "Google GenAI" SDK, v2+):
//   - `contents` is a list of `{ role: "user" | "model", parts: Part[] }`
//   - Each Part is text / inlineData (vision) / functionCall (tool
//     use) / functionResponse (tool result)
//   - System prompt rides separately as `config.systemInstruction`
//   - Tool definitions: `config.tools = [{ functionDeclarations: [...] }]`
//
// Mapping from our LlmContentBlock to Gemini parts:
//   text       → { text }
//   tool_use   → { functionCall: { name, args } }     (assistant turn)
//   tool_result→ { functionResponse: { name, response } } (user turn)
//   image      → { inlineData: { mimeType, data } }
//
// Streaming: Gemini yields chunks with delta text + finish reason.
// Tool calls arrive as part of the final chunk's content. Token
// usage is in `usageMetadata` on each chunk; we sum the last value.

import type {
  LlmClient,
  LlmStreamParams,
  LlmStreamEvent,
  LlmContentBlock,
  LlmToolDefinition,
} from "./llm";
import { normalizeExplicitToolPropertyTypes } from "./tool-schema-compat";

export type GeminiLlmClientOptions = {
  apiKey: string;
  /** Optional override of the Gemini base URL (proxy / regional). */
  baseURL?: string;
};

// Minimal type aliases — the @google/genai SDK exposes deep nested
// types and we only need a handful of fields. Avoids dragging a heavy
// generic surface through our runtime types.
type GenAiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args?: Record<string, unknown>; id?: string } }
  | { functionResponse: { name: string; response: unknown; id?: string } };

type GenAiContent = { role: "user" | "model"; parts: GenAiPart[] };

type GenAiStreamChunk = {
  text?: string;
  candidates?: Array<{
    content?: { parts?: GenAiPart[] };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
};

export class GeminiLlmClient implements LlmClient {
  private readonly apiKey: string;
  private readonly baseURL?: string;

  constructor(options: GeminiLlmClientOptions) {
    this.apiKey = options.apiKey;
    this.baseURL = options.baseURL;
  }

  async *streamMessage(params: LlmStreamParams): AsyncIterable<LlmStreamEvent> {
    // Dynamic import — Gemini SDK is lazy-loaded so the bundle
    // doesn't drag it in when only Anthropic/OpenAI keys are set.
    const mod = await import("@google/genai");
    const GoogleGenAI = (mod as unknown as { GoogleGenAI: new (cfg: object) => unknown })
      .GoogleGenAI;
    const ai = new GoogleGenAI(
      this.baseURL
        ? { apiKey: this.apiKey, httpOptions: { baseUrl: this.baseURL } }
        : { apiKey: this.apiKey },
    ) as unknown as {
      models: {
        generateContentStream(req: {
          model: string;
          contents: GenAiContent[];
          config?: {
            systemInstruction?: string;
            maxOutputTokens?: number;
            tools?: Array<{ functionDeclarations: unknown[] }>;
          };
        }): Promise<AsyncIterable<GenAiStreamChunk>>;
      };
    };

    const toolCallNames = collectToolCallNames(params.messages);
    const contents = params.messages.map((message) =>
      toGenAiContent(message, toolCallNames),
    );
    const sdkTools = params.tools && params.tools.length > 0
      ? [{ functionDeclarations: params.tools.map(toGenAiFunctionDeclaration) }]
      : undefined;

    const stream = await ai.models.generateContentStream({
      model: params.model,
      contents,
      config: {
        systemInstruction: params.system,
        maxOutputTokens: params.maxTokens,
        ...(sdkTools ? { tools: sdkTools } : {}),
      },
    });

    let textAcc = "";
    const toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
    let finishReason = "STOP";
    let inputTokens = 0;
    let outputTokens = 0;
    let inputTokensEmitted = false;

    for await (const chunk of stream) {
      // Cooperative abort: the @google/genai stream wrapper here
      // doesn't expose a fetch-level signal, so we bail iteration the
      // moment the run is aborted rather than draining the stream.
      if (params.signal?.aborted) {
        throw new DOMException("Run aborted", "AbortError");
      }
      // Text delta — Gemini surfaces concatenated text on each chunk;
      // we compute the delta by stripping the cumulative prefix.
      if (chunk.text) {
        const deltaText = chunk.text.startsWith(textAcc)
          ? chunk.text.slice(textAcc.length)
          : chunk.text;
        if (deltaText) {
          textAcc += deltaText;
          yield { type: "text_delta", text: deltaText };
        }
      }

      // Tool calls only appear once per chunk on the candidate's
      // parts list. Collect them; we emit as content blocks at end.
      for (const cand of chunk.candidates ?? []) {
        if (cand.finishReason) finishReason = cand.finishReason;
        for (const part of cand.content?.parts ?? []) {
          if ("functionCall" in part) {
            const id =
              part.functionCall.id ?? `gemini_${toolCalls.length}_${Date.now()}`;
            toolCalls.push({
              id,
              name: part.functionCall.name,
              args: (part.functionCall.args ?? {}) as Record<string, unknown>,
            });
          }
        }
      }

      // Token usage on the last chunk is authoritative; we keep
      // overwriting and emit at the very end.
      if (chunk.usageMetadata) {
        inputTokens = chunk.usageMetadata.promptTokenCount ?? inputTokens;
        outputTokens = chunk.usageMetadata.candidatesTokenCount ?? outputTokens;
        if (!inputTokensEmitted && inputTokens > 0) {
          yield { type: "input_tokens", count: inputTokens };
          inputTokensEmitted = true;
        }
      }
    }

    if (outputTokens > 0) {
      yield { type: "output_tokens", count: outputTokens };
    }

    // Build the final content blocks: text (if any) + tool_use (per call).
    const content: LlmContentBlock[] = [];
    if (textAcc) content.push({ type: "text", text: textAcc });
    for (const tc of toolCalls) {
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.name,
        input: tc.args,
      });
    }

    yield {
      type: "message_complete",
      stopReason: mapStopReason(finishReason, toolCalls.length > 0),
      content,
    };
  }
}

function toGenAiContent(
  msg: { role: "user" | "assistant"; content: string | LlmContentBlock[] },
  toolCallNames: ReadonlyMap<string, string>,
): GenAiContent {
  // Gemini uses "model" instead of "assistant".
  const role: GenAiContent["role"] = msg.role === "assistant" ? "model" : "user";

  if (typeof msg.content === "string") {
    return { role, parts: [{ text: msg.content }] };
  }

  const parts: GenAiPart[] = [];
  for (const block of msg.content) {
    if (block.type === "text") {
      parts.push({ text: block.text });
    } else if (block.type === "image") {
      parts.push({
        inlineData: { mimeType: block.mediaType, data: block.data },
      });
    } else if (block.type === "tool_use") {
      // Assistant-turn tool calls.
      parts.push({
        functionCall: {
          name: block.name,
          args: block.input ?? {},
          id: block.id,
        },
      });
    } else if (block.type === "tool_result") {
      // User-turn tool results. Gemini expects a `response` field
      // wrapping the actual result. We pass the JSON-decoded content
      // when possible, raw string otherwise.
      let response: unknown = block.content;
      try {
        response = JSON.parse(block.content);
      } catch {
        // Keep as string.
      }
      parts.push({
        functionResponse: {
          // Gemini requires both the original function name and matching call
          // id. Recover the name from the assistant tool_use in this stateless
          // conversation history instead of guessing from the opaque id.
          name: toolCallNames.get(block.tool_use_id) ?? "tool",
          response,
          id: block.tool_use_id,
        },
      });
    }
  }

  // If a turn ends up with no parts (shouldn't, but defensive), give
  // it an empty text part so Gemini doesn't reject the payload.
  if (parts.length === 0) {
    parts.push({ text: "" });
  }
  return { role, parts };
}

function toGenAiFunctionDeclaration(tool: LlmToolDefinition): unknown {
  return {
    name: tool.name,
    description: tool.description,
    parameters: normalizeExplicitToolPropertyTypes(tool.inputSchema),
  };
}

function collectToolCallNames(
  messages: Array<{ role: "user" | "assistant"; content: string | LlmContentBlock[] }>,
): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_use") names.set(block.id, block.name);
    }
  }
  return names;
}

function mapStopReason(geminiReason: string, hadToolCalls: boolean): string {
  // Gemini finish reasons: STOP, MAX_TOKENS, SAFETY, RECITATION, OTHER
  if (hadToolCalls) return "tool_use";
  switch (geminiReason.toUpperCase()) {
    case "STOP":
      return "end_turn";
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
    case "RECITATION":
      return "stop_sequence";
    default:
      return "end_turn";
  }
}
