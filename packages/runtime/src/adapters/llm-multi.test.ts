// Routing + fetch-injection tests for the multi-provider LlmClient. Pure +
// no network: a capturing mock fetch records the outbound URL/body then throws
// a sentinel, so we can assert WHICH endpoint a model routed to and WHICH
// token param was sent, without a live provider.
// Run: `pnpm --filter @agentmug/runtime run test:llm-routing`.

import assert from "node:assert/strict";
import {
  detectProvider,
  MultiLlmClient,
  createMultiLlmClient,
} from "./llm-multi";
import type { LlmStreamParams } from "./llm";

type Test = { name: string; fn: () => void | Promise<void> };
const tests: Test[] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push({ name, fn });

const PARAMS = (model: string): LlmStreamParams => ({
  model,
  system: "s",
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 100,
});

// A minimal, valid OpenAI-style SSE stream so the SDK parses cleanly (a thrown
// fetch is retried by the SDK and masked as "Connection error", so we return a
// real 200 stream instead and read the captured request afterwards).
const SSE =
  'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n' +
  'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
  'data: {"id":"1","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n' +
  "data: [DONE]\n\n";

function capturingFetch() {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    let body: unknown = undefined;
    try {
      body = init?.body ? JSON.parse(init.body as string) : undefined;
    } catch {
      body = init?.body;
    }
    calls.push({ url, body });
    return new Response(SSE, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

// Drive the stream to completion; the caller reads cap.calls[0] afterwards.
async function drain(client: MultiLlmClient, model: string) {
  for await (const _ of client.streamMessage(PARAMS(model))) void _;
}

// ── detectProvider (pure) ───────────────────────────────────────────────
test("detectProvider maps every provider prefix", () => {
  assert.equal(detectProvider("claude-sonnet-4-6"), "anthropic");
  assert.equal(detectProvider("anthropic.claude-x"), "anthropic");
  assert.equal(detectProvider("gpt-4o"), "openai");
  assert.equal(detectProvider("gpt-5-mini"), "openai");
  assert.equal(detectProvider("o3"), "openai");
  assert.equal(detectProvider("o1-preview"), "openai");
  assert.equal(detectProvider("gemini-2.5-pro"), "gemini");
  assert.equal(detectProvider("deepseek-chat"), "deepseek");
  assert.equal(detectProvider("glm-4.6"), "zhipu");
  assert.equal(detectProvider("kimi-k2"), "moonshot");
  assert.equal(detectProvider("moonshot-v1"), "moonshot");
  assert.equal(detectProvider("qwen-max"), "qwen");
  assert.equal(detectProvider("minimax-m2"), "minimax");
  assert.equal(detectProvider("grok-4"), "xai");
  assert.equal(detectProvider("mistral-large-latest"), "mistral");
  assert.equal(detectProvider("codestral-latest"), "mistral");
  // slash-format → OpenRouter
  assert.equal(detectProvider("anthropic/claude-sonnet-4.5"), "openrouter");
  assert.equal(detectProvider("openai/gpt-4o"), "openrouter");
  // unknown → null (caller decides fallback)
  assert.equal(detectProvider("llama3.1"), null);
});

// ── custom / local endpoint routing + fetch injection ──────────────────
test("custom endpoint: local/ namespace routes to the custom baseURL", async () => {
  const cap = capturingFetch();
  const client = createMultiLlmClient({
    anthropic: { apiKey: "sk-a" },
    custom: { baseURL: "http://localhost:11434/v1", models: ["llama3.1"], fetch: cap.fn },
  });
  await drain(client, "local/anything");
  assert.ok(cap.calls[0]?.url.startsWith("http://localhost:11434/v1"), `routed to ${cap.calls[0]?.url}`);
});

test("custom endpoint: an explicitly-listed model routes there", async () => {
  const cap = capturingFetch();
  const client = createMultiLlmClient({
    custom: { baseURL: "http://localhost:1234/v1", models: ["llama3.1"], fetch: cap.fn },
  });
  await drain(client, "llama3.1");
  assert.ok(cap.calls[0]?.url.startsWith("http://localhost:1234/v1"), `routed to ${cap.calls[0]?.url}`);
});

test("custom endpoint: forcePlainMaxTokens sends max_tokens even for a gpt-5-named local model", async () => {
  const cap = capturingFetch();
  const client = createMultiLlmClient({
    custom: { baseURL: "http://localhost:1234/v1", models: ["gpt-5-local"], fetch: cap.fn },
  });
  await drain(client, "gpt-5-local");
  const body = cap.calls[0]?.body as Record<string, unknown>;
  assert.ok("max_tokens" in body, "should send max_tokens for a local model");
  assert.ok(!("max_completion_tokens" in body), "should NOT send max_completion_tokens");
});

test("fetch injection: an OpenAI-compat vendor uses the injected fetch + its baseURL", async () => {
  const cap = capturingFetch();
  const client = createMultiLlmClient({
    compat: { deepseek: { apiKey: "sk-d", baseURL: "https://api.deepseek.com", fetch: cap.fn } },
  });
  await drain(client, "deepseek-chat");
  assert.ok(cap.calls[0]?.url.startsWith("https://api.deepseek.com"), `routed to ${cap.calls[0]?.url}`);
});

test("real reasoning model still uses max_completion_tokens (no forcePlainMaxTokens)", async () => {
  const cap = capturingFetch();
  const client = createMultiLlmClient({
    openai: { apiKey: "sk-o", fetch: cap.fn },
  });
  await drain(client, "gpt-5-mini");
  const body = cap.calls[0]?.body as Record<string, unknown>;
  assert.ok("max_completion_tokens" in body, "gpt-5 should use max_completion_tokens");
});

test("unconfigured provider throws a clear error, not a wrong route", async () => {
  const client = createMultiLlmClient({ anthropic: { apiKey: "sk-a" } });
  await assert.rejects(
    () => drain(client, "deepseek-chat"),
    /DEEPSEEK_API_KEY is not configured/,
  );
});

test("geminiViaOpenAI: a gemini-* model routes to the Gemini OpenAI-compat endpoint via the injected fetch", async () => {
  const cap = capturingFetch();
  const client = createMultiLlmClient({
    geminiViaOpenAI: { apiKey: "AIza-x", fetch: cap.fn },
  });
  await drain(client, "gemini-2.5-pro");
  assert.ok(
    cap.calls[0]?.url.startsWith("https://generativelanguage.googleapis.com/v1beta/openai/"),
    `routed to ${cap.calls[0]?.url}`,
  );
});

// ── runner ───────────────────────────────────────────────────────────────
(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${t.name}\n    ${(err as Error).message}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  if (failed > 0) process.exit(1);
})();
