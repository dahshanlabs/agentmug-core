// Routing + fetch-injection tests for the multi-provider LlmClient. Pure +
// no network: a capturing mock fetch records the outbound URL/body then throws
// a sentinel, so we can assert WHICH endpoint a model routed to and WHICH
// token param was sent, without a live provider.
// Run: `pnpm --filter @agentmug/runtime run test:llm-routing`.

import assert from "node:assert/strict";
import {
  detectProvider,
  MultiLlmClient,
  OPENAI_COMPAT_PROVIDERS,
  createMultiLlmClient,
} from "./llm-multi";
import type { LlmStreamEvent, LlmStreamParams } from "./llm";

type Test = { name: string; fn: () => void | Promise<void> };
const tests: Test[] = [];
const test = (name: string, fn: () => void | Promise<void>) =>
  tests.push({ name, fn });

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
const SSE_WITHOUT_USAGE =
  'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n' +
  'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
  "data: [DONE]\n\n";
const SSE_WITH_PARTIAL_USAGE =
  'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"a long provider response"},"finish_reason":null}]}\n\n' +
  'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
  'data: {"id":"1","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":1}}\n\n' +
  "data: [DONE]\n\n";

function capturingFetch(sse = SSE) {
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
    return new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

// Drive the stream to completion; the caller reads cap.calls[0] afterwards.
async function drain(client: MultiLlmClient, model: string) {
  await drainParams(client, PARAMS(model));
}

async function drainParams(client: MultiLlmClient, params: LlmStreamParams) {
  for await (const _ of client.streamMessage(params)) void _;
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
  assert.equal(detectProvider("kimi-k3"), "moonshot");
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
    custom: {
      baseURL: "http://localhost:11434/v1",
      models: ["llama3.1"],
      fetch: cap.fn,
    },
  });
  await drain(client, "local/anything");
  assert.ok(
    cap.calls[0]?.url.startsWith("http://localhost:11434/v1"),
    `routed to ${cap.calls[0]?.url}`,
  );
});

test("custom endpoint: an explicitly-listed model routes there", async () => {
  const cap = capturingFetch();
  const client = createMultiLlmClient({
    custom: {
      baseURL: "http://localhost:1234/v1",
      models: ["llama3.1"],
      fetch: cap.fn,
    },
  });
  await drain(client, "llama3.1");
  assert.ok(
    cap.calls[0]?.url.startsWith("http://localhost:1234/v1"),
    `routed to ${cap.calls[0]?.url}`,
  );
});

test("custom endpoint: retries gpt-5 with max_tokens only after an explicit unsupported-parameter 400", async () => {
  const cap = capturingFetch();
  const calls: typeof cap.calls = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    calls.push({ url: input.toString(), body });
    if ("max_completion_tokens" in body) {
      return new Response(
        JSON.stringify({
          error: {
            message:
              "Unsupported parameter: max_completion_tokens. Use max_tokens instead.",
            type: "invalid_request_error",
            param: "max_completion_tokens",
            code: "unsupported_parameter",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    return cap.fn(input, init);
  }) as typeof globalThis.fetch;
  const client = createMultiLlmClient({
    custom: {
      baseURL: "http://localhost:1234/v1",
      models: ["gpt-5-local"],
      fetch,
    },
  });
  await drain(client, "gpt-5-local");
  assert.equal(calls.length, 2);
  assert.ok("max_completion_tokens" in (calls[0]?.body as object));
  assert.ok("max_tokens" in (calls[1]?.body as object));
});

test("custom endpoint: retries an aliased reasoning model with max_completion_tokens", async () => {
  const cap = capturingFetch();
  const calls: typeof cap.calls = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    calls.push({ url: input.toString(), body });
    if ("max_tokens" in body) {
      return new Response(
        JSON.stringify({
          error: {
            message:
              "max_tokens is not supported by this model; use max_completion_tokens",
            type: "invalid_request_error",
            param: "max_tokens",
            code: "unsupported_parameter",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    return cap.fn(input, init);
  }) as typeof globalThis.fetch;
  const client = createMultiLlmClient({
    custom: {
      baseURL: "https://models.example.com/v1",
      models: ["company/reasoner"],
      fetch,
    },
  });
  await drain(client, "company/reasoner");
  assert.equal(calls.length, 2);
  assert.ok("max_tokens" in (calls[0]?.body as object));
  assert.ok("max_completion_tokens" in (calls[1]?.body as object));
});

test("custom endpoint: drops unsupported stream_options and emits a conservative usage estimate", async () => {
  const cap = capturingFetch(SSE_WITHOUT_USAGE);
  const calls: typeof cap.calls = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    calls.push({ url: input.toString(), body });
    if ("stream_options" in body) {
      return new Response(
        JSON.stringify({
          error: {
            message: "Unknown parameter: stream_options",
            type: "invalid_request_error",
            param: "stream_options",
            code: "unknown_parameter",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    return cap.fn(input, init);
  }) as typeof globalThis.fetch;
  const client = createMultiLlmClient({
    custom: {
      baseURL: "https://models.example.com/v1",
      models: ["local-chat"],
      fetch,
    },
  });
  const events: LlmStreamEvent[] = [];
  for await (const event of client.streamMessage(PARAMS("local-chat"))) {
    events.push(event);
  }
  assert.equal(calls.length, 2);
  assert.ok("stream_options" in (calls[0]?.body as object));
  assert.ok(!("stream_options" in (calls[1]?.body as object)));
  const inputUsage = events.find((event) => event.type === "input_tokens");
  const outputUsage = events.find((event) => event.type === "output_tokens");
  assert.ok(inputUsage && inputUsage.type === "input_tokens");
  assert.ok(outputUsage && outputUsage.type === "output_tokens");
  assert.ok(inputUsage.count > 0);
  assert.equal(outputUsage.count, 100);
  assert.equal(inputUsage.usage, "estimated");
  assert.equal(outputUsage.usage, "estimated");
});

test("custom endpoint: partial streamed usage never becomes an exact receipt", async () => {
  const cap = capturingFetch(SSE_WITH_PARTIAL_USAGE);
  const client = createMultiLlmClient({
    custom: {
      baseURL: "https://models.example.com/v1",
      models: ["local-chat"],
      fetch: cap.fn,
    },
  });
  const events: LlmStreamEvent[] = [];
  for await (const event of client.streamMessage(PARAMS("local-chat"))) {
    events.push(event);
  }
  const inputUsage = events.find((event) => event.type === "input_tokens");
  const outputUsage = events.find((event) => event.type === "output_tokens");
  assert.ok(inputUsage && inputUsage.type === "input_tokens");
  assert.ok(outputUsage && outputUsage.type === "output_tokens");
  assert.ok(inputUsage.count > 1);
  assert.equal(outputUsage.count, 100);
  assert.equal(inputUsage.usage, "estimated");
  assert.equal(outputUsage.usage, "estimated");
});

test("custom endpoint: never negotiates on an authentication failure", async () => {
  let calls = 0;
  const fetch = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        error: {
          message: "Invalid API key",
          type: "authentication_error",
          code: "invalid_api_key",
        },
      }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
  const client = createMultiLlmClient({
    custom: {
      baseURL: "https://models.example.com/v1",
      models: ["gpt-5-private"],
      fetch,
    },
  });
  await assert.rejects(() => drain(client, "gpt-5-private"));
  assert.equal(calls, 1);
});

test("fetch injection: an OpenAI-compat vendor uses the injected fetch + its baseURL", async () => {
  const cap = capturingFetch();
  const client = createMultiLlmClient({
    compat: {
      deepseek: {
        apiKey: "sk-d",
        baseURL: "https://api.deepseek.com",
        fetch: cap.fn,
      },
    },
  });
  await drain(client, "deepseek-chat");
  assert.equal(
    new URL(cap.calls[0]?.url ?? "").origin,
    "https://api.deepseek.com",
  );
});

test("every OpenAI-compatible provider preserves its endpoint and tool contract", async () => {
  for (const [provider, info] of Object.entries(OPENAI_COMPAT_PROVIDERS)) {
    const cap = capturingFetch();
    const client = createMultiLlmClient({
      compat: {
        [provider]: {
          apiKey: `sk-${provider}`,
          baseURL: info.baseURL,
          fetch: cap.fn,
        },
      },
    });
    const params: LlmStreamParams = {
      ...PARAMS(info.exampleModel ?? "vendor/model"),
      tools: [
        {
          name: "weather",
          description: "Get weather",
          inputSchema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      ],
    };
    await drainParams(client, params);

    const call = cap.calls[0];
    assert.ok(
      call?.url.startsWith(info.baseURL),
      `${provider} routed to ${call?.url}`,
    );
    const body = call?.body as Record<string, unknown>;
    assert.equal(
      body.model,
      params.model,
      `${provider} must receive the selected model id`,
    );
    assert.ok(
      Array.isArray(body.tools),
      `${provider} must receive tool declarations`,
    );
  }
});

test("real reasoning model still uses max_completion_tokens (no forcePlainMaxTokens)", async () => {
  const cap = capturingFetch();
  const client = createMultiLlmClient({
    openai: { apiKey: "sk-o", fetch: cap.fn },
  });
  await drain(client, "gpt-5-mini");
  const body = cap.calls[0]?.body as Record<string, unknown>;
  assert.ok(
    "max_completion_tokens" in body,
    "gpt-5 should use max_completion_tokens",
  );
});

test("Kimi K3 uses its reasoning protocol and replays reasoning_content after a tool call", async () => {
  const kimiSse =
    'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"reasoning_content":"check the weather"},"finish_reason":null}]}\n\n' +
    'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"weather","arguments":"{\\"city\\":\\"Riyadh\\"}"}}]},"finish_reason":null}]}\n\n' +
    'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
    'data: {"id":"1","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":8,"total_tokens":18}}\n\n' +
    "data: [DONE]\n\n";
  const cap = capturingFetch(kimiSse);
  const client = createMultiLlmClient({
    compat: { moonshot: { apiKey: "sk-k", fetch: cap.fn } },
  });
  const firstEvents: LlmStreamEvent[] = [];
  const firstParams: LlmStreamParams = {
    ...PARAMS("kimi-k3"),
    tools: [
      {
        name: "weather",
        description: "Get weather",
        inputSchema: {
          type: "object",
          properties: {
            city: { type: "string" },
            message: {
              type: "object",
              properties: {
                body: {
                  type: "object",
                  properties: {
                    contentType: { enum: ["Text", "HTML"] },
                  },
                },
              },
            },
          },
        },
      },
    ],
  };
  for await (const event of client.streamMessage(firstParams))
    firstEvents.push(event);
  const completed = firstEvents.find(
    (event) => event.type === "message_complete",
  );
  assert.ok(completed && completed.type === "message_complete");
  assert.equal(completed.content[0]?.type, "thinking");
  assert.equal(
    completed.content[0]?.type === "thinking"
      ? completed.content[0].thinking
      : "",
    "check the weather",
  );

  const toolUse = completed.content.find((block) => block.type === "tool_use");
  assert.ok(toolUse && toolUse.type === "tool_use");
  const followUp: LlmStreamParams = {
    ...firstParams,
    messages: [
      { role: "user", content: "What's the weather?" },
      { role: "assistant", content: completed.content },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: toolUse.id, content: "sunny" },
        ],
      },
    ],
  };
  for await (const _ of client.streamMessage(followUp)) void _;

  const firstBody = cap.calls[0]?.body as Record<string, unknown>;
  assert.ok(
    "max_completion_tokens" in firstBody,
    "K3 should use max_completion_tokens",
  );
  assert.ok(!("max_tokens" in firstBody), "K3 should not send max_tokens");
  assert.equal(firstBody.reasoning_effort, "high");
  const firstTools = firstBody.tools as Array<{
    function?: { parameters?: Record<string, unknown> };
  }>;
  const sentProperties = firstTools[0]?.function?.parameters?.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  const sentMessageProperties = sentProperties?.message?.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  const sentBodyProperties = sentMessageProperties?.body?.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  assert.equal(
    sentBodyProperties?.contentType?.type,
    "string",
    "K3 should repair nested enum-only properties before sending tools",
  );
  const sourceProperties = firstParams.tools?.[0]?.inputSchema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  const sourceMessageProperties = sourceProperties?.message?.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  const sourceBodyProperties = sourceMessageProperties?.body?.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  assert.ok(
    !("type" in (sourceBodyProperties?.contentType ?? {})),
    "K3 schema normalization must not mutate the shared source schema",
  );

  const secondBody = cap.calls[1]?.body as {
    messages?: Array<Record<string, unknown>>;
  };
  const assistant = secondBody.messages?.find(
    (message) => message.role === "assistant",
  );
  assert.equal(assistant?.reasoning_content, "check the weather");
  assert.ok(
    Array.isArray(assistant?.tool_calls),
    "tool calls must be replayed with reasoning",
  );
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
  await drainParams(client, {
    ...PARAMS("gemini-2.5-pro"),
    tools: [
      {
        name: "weather",
        description: "Get weather",
        inputSchema: {
          type: "object",
          properties: { units: { enum: ["metric", "imperial"] } },
        },
      },
    ],
  });
  assert.ok(
    cap.calls[0]?.url.startsWith(
      "https://generativelanguage.googleapis.com/v1beta/openai/",
    ),
    `routed to ${cap.calls[0]?.url}`,
  );
  const body = cap.calls[0]?.body as {
    tools?: Array<{
      function?: {
        parameters?: { properties?: Record<string, Record<string, unknown>> };
      };
    }>;
  };
  assert.equal(
    body.tools?.[0]?.function?.parameters?.properties?.units?.type,
    "string",
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
