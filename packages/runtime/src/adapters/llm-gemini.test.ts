// Native Gemini request-contract regression. The test runner replaces
// @google/genai with a capturing in-memory client, so this is network-free.

import assert from "node:assert/strict";
import { GeminiLlmClient } from "./llm-gemini";
import type { LlmStreamEvent, LlmStreamParams } from "./llm";

type CapturedRequest = {
  contents?: Array<{
    role?: string;
    parts?: Array<{
      functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
      functionResponse?: { id?: string; name?: string; response?: unknown };
    }>;
  }>;
  config?: {
    tools?: Array<{
      functionDeclarations?: Array<{
        parameters?: Record<string, unknown>;
      }>;
    }>;
  };
};

declare global {
  var __geminiTestRequests: CapturedRequest[];
  var __geminiTestResponses: unknown[];
}

const params: LlmStreamParams = {
  model: "gemini-3.5-flash",
  system: "Use tools when needed.",
  messages: [{ role: "user", content: "Weather in Riyadh?" }],
  maxTokens: 100,
  tools: [
    {
      name: "weather",
      description: "Get weather",
      inputSchema: {
        type: "object",
        properties: {
          units: { enum: ["metric", "imperial"] },
        },
      },
    },
  ],
};

globalThis.__geminiTestRequests = [];
globalThis.__geminiTestResponses = [
  {
    candidates: [
      {
        content: {
          parts: [
            {
              functionCall: {
                id: "call_weather_1",
                name: "weather",
                args: { units: "metric" },
              },
            },
          ],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 },
  },
  {
    text: "Sunny",
    candidates: [{ content: { parts: [{ text: "Sunny" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 2 },
  },
];

const client = new GeminiLlmClient({ apiKey: "test-key" });
const firstEvents: LlmStreamEvent[] = [];
for await (const event of client.streamMessage(params)) firstEvents.push(event);

const completed = firstEvents.find((event) => event.type === "message_complete");
assert.ok(completed && completed.type === "message_complete");
const toolUse = completed.content.find((block) => block.type === "tool_use");
assert.ok(toolUse && toolUse.type === "tool_use");
assert.equal(toolUse.id, "call_weather_1");
assert.equal(toolUse.name, "weather");

const firstRequest = globalThis.__geminiTestRequests[0];
const sentParameters = firstRequest?.config?.tools?.[0]?.functionDeclarations?.[0]
  ?.parameters;
const sentProperties = sentParameters?.properties as
  | Record<string, Record<string, unknown>>
  | undefined;
assert.equal(sentProperties?.units?.type, "string");
const sourceProperties = params.tools?.[0]?.inputSchema.properties as
  | Record<string, Record<string, unknown>>
  | undefined;
assert.ok(!("type" in (sourceProperties?.units ?? {})));

const followUp: LlmStreamParams = {
  ...params,
  messages: [
    ...params.messages,
    { role: "assistant", content: completed.content },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: '{"temperature":32}',
        },
      ],
    },
  ],
};
for await (const _ of client.streamMessage(followUp)) void _;

const secondRequest = globalThis.__geminiTestRequests[1];
const functionResponse = secondRequest?.contents
  ?.flatMap((content) => content.parts ?? [])
  .find((part) => part.functionResponse)?.functionResponse;
assert.equal(functionResponse?.id, "call_weather_1");
assert.equal(
  functionResponse?.name,
  "weather",
  "Gemini tool results must replay the original function name",
);

console.log("  ✓ native Gemini preserves tool schema, call id, and function name");
