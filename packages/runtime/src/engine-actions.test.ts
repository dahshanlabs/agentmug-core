import assert from "node:assert/strict";
import test from "node:test";
import type {
  LlmClient,
  LlmStreamEvent,
  LlmStreamParams,
} from "./adapters/llm";
import { actionResult, type RunActionReceipt } from "./actions/types";
import { runAgent, type EngineEvent } from "./engine";
import { AGENT_FILE_SCHEMA_V1, type AgentFileV1 } from "./format/agent-file";
import { createInMemoryAdapters } from "./quickstart";
import { noSourcePlan } from "./sources/execution-plan";
import { InMemoryToolRegistry } from "./tools/registry";

class EffectLlm implements LlmClient {
  private call = 0;
  readonly systems: string[] = [];
  async *streamMessage(params: LlmStreamParams): AsyncIterable<LlmStreamEvent> {
    this.systems.push(params.system);
    this.call += 1;
    if (this.call === 1) {
      yield {
        type: "message_complete",
        stopReason: "tool_use",
        content: [
          { type: "tool_use", id: "send-1", name: "test.send", input: {} },
        ],
      };
      return;
    }
    yield {
      type: "text_delta",
      text: "The provider accepted it; delivery is pending.",
    };
    yield {
      type: "message_complete",
      stopReason: "end_turn",
      content: [
        {
          type: "text",
          text: "The provider accepted it; delivery is pending.",
        },
      ],
    };
  }
}

class NoToolLlm implements LlmClient {
  async *streamMessage(): AsyncIterable<LlmStreamEvent> {
    yield { type: "text_delta", text: "Done." };
    yield {
      type: "message_complete",
      stopReason: "end_turn",
      content: [{ type: "text", text: "Done." }],
    };
  }
}

class ReadLlm implements LlmClient {
  private call = 0;
  async *streamMessage(): AsyncIterable<LlmStreamEvent> {
    this.call += 1;
    if (this.call === 1) {
      yield {
        type: "message_complete",
        stopReason: "tool_use",
        content: [
          { type: "tool_use", id: "read-1", name: "test.read", input: {} },
        ],
      };
      return;
    }
    yield { type: "text_delta", text: "I found one item." };
    yield {
      type: "message_complete",
      stopReason: "end_turn",
      content: [{ type: "text", text: "I found one item." }],
    };
  }
}

class BilledThenDisconnectedLlm implements LlmClient {
  private call = 0;

  async *streamMessage(): AsyncIterable<LlmStreamEvent> {
    this.call += 1;
    if (this.call === 1) {
      yield { type: "input_tokens", count: 1_000 };
      yield { type: "output_tokens", count: 100 };
      yield {
        type: "message_complete",
        stopReason: "tool_use",
        content: [
          { type: "tool_use", id: "read-usage", name: "test.read", input: {} },
        ],
      };
      return;
    }

    // These are provider-reported, billable totals received before the stream
    // disconnects. A failure must not erase either this partial call or the
    // completed first call from the run's accounting receipt.
    yield { type: "input_tokens", count: 500 };
    yield { type: "output_tokens", count: 50 };
    yield { type: "cache_read_tokens", count: 1_000 };
    yield { type: "cache_creation_tokens", count: 200 };
    yield { type: "text_delta", text: "Partial answer" };
    throw new Error("provider stream disconnected");
  }
}

class EstimatedUsageLlm implements LlmClient {
  async *streamMessage(): AsyncIterable<LlmStreamEvent> {
    yield { type: "input_tokens", count: 12, usage: "estimated" };
    yield { type: "output_tokens", count: 8, usage: "estimated" };
    yield { type: "text_delta", text: "Estimated usage." };
    yield {
      type: "message_complete",
      stopReason: "end_turn",
      content: [{ type: "text", text: "Estimated usage." }],
    };
  }
}

function agentFile(): AgentFileV1 {
  return {
    $schema: AGENT_FILE_SCHEMA_V1,
    id: "action-engine-test",
    name: "Action engine test",
    description: "Tests honest action outcomes.",
    version: "1.0.0",
    exportedAt: "2026-08-02T00:00:00.000Z",
    blueprint: {
      primaryModel: "claude-sonnet-4-6",
      systemPrompt: "Use the tool once.",
      tools: [],
    },
    inputs: { accepts: ["text"] },
    sources: [],
  };
}

test("queued effect is pending, not a successful tool completion", async () => {
  const file = agentFile();
  const { persistence, tracing } = createInMemoryAdapters(file);
  const actions: RunActionReceipt[] = [];
  const ordering: string[] = [];
  persistence.saveRunAction = async (receipt) => {
    ordering.push(`persist:${receipt.status}`);
    actions.push(receipt);
  };
  const tools = new InMemoryToolRegistry();
  tools.register(
    {
      type: "inline",
      name: "test.send",
      description: "Send a test message.",
      inputSchema: { type: "object", properties: {} },
      effect: {
        provider: "test",
        operation: "message.deliver",
        requiredProof: "delivered",
        verification: "callback",
      },
    },
    {
      async execute() {
        ordering.push("execute");
        return actionResult(
          { status: "queued" },
          {
            status: "pending",
            proof: "accepted",
            providerStatus: "queued",
            message: "Queued; awaiting delivery confirmation.",
          },
        );
      },
    },
  );
  const events: EngineEvent[] = [];
  const llm = new EffectLlm();
  const result = await runAgent({
    agentId: file.id,
    userId: "test-user",
    userInput: "Send it.",
    adapters: { persistence, tracing, llm },
    tools,
    sources: noSourcePlan(),
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(ordering.slice(0, 2), ["persist:pending", "execute"]);
  assert.equal(result.status, "completed");
  assert.equal(result.outcomeStatus, "pending");
  assert.equal(result.receipt?.actions?.[0]?.proof, "accepted");
  const completion = events.find(
    (event): event is Extract<EngineEvent, { type: "tool_complete" }> =>
      event.type === "tool_complete",
  );
  assert.equal(completion?.ok, false);
  assert.equal(completion?.action?.status, "pending");
  assert.equal(actions.at(-1)?.providerStatus, "queued");
  assert.match(
    llm.systems[0] ?? "",
    /queued.*NOT proof of delivery\/completion/i,
  );
  assert.match(
    llm.systems[0] ?? "",
    /phone number mentioned in chat.*NOT an account-linked or verified delivery identity/i,
  );
});

test("declared effects without a proof envelope fail closed as unknown", async () => {
  const file = agentFile();
  const { persistence, tracing } = createInMemoryAdapters(file);
  const actions: RunActionReceipt[] = [];
  persistence.saveRunAction = async (receipt) => {
    actions.push(receipt);
  };
  const tools = new InMemoryToolRegistry();
  tools.register(
    {
      type: "inline",
      name: "test.send",
      description: "A legacy sender that has not adopted proof metadata yet.",
      inputSchema: { type: "object", properties: {} },
      effect: {
        provider: "test",
        operation: "message.deliver",
        requiredProof: "delivered",
        verification: "unavailable",
      },
    },
    {
      async execute() {
        return { status: "sent" };
      },
    },
  );

  const result = await runAgent({
    agentId: file.id,
    userId: "test-user",
    userInput: "Send it.",
    adapters: { persistence, tracing, llm: new EffectLlm() },
    tools,
    sources: noSourcePlan(),
    onEvent: () => undefined,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.outcomeStatus, "unknown");
  assert.equal(actions.at(-1)?.status, "unknown");
  assert.match(actions.at(-1)?.message ?? "", /without verifiable evidence/i);
});

test("a promised capability omitted by the model prevents a green outcome", async () => {
  const file = agentFile();
  file.blueprint.capabilityPlan = {
    version: 1,
    resolutions: [
      {
        requirementId: "deliver-result",
        requirement: "Deliver the result through the test provider",
        status: "supported",
        path: "execute",
        operationId: "test.send:deliver",
        tool: "test.send",
        effect: "communicate",
        critical: true,
      },
    ],
  };
  const { persistence, tracing } = createInMemoryAdapters(file);
  const saved: RunActionReceipt[] = [];
  persistence.saveRunAction = async (receipt) => {
    saved.push(receipt);
  };
  const tools = new InMemoryToolRegistry();
  let executed = false;
  tools.register(
    {
      type: "inline",
      name: "test.send",
      description: "Send a test result.",
      inputSchema: { type: "object", properties: {} },
      effect: {
        provider: "test",
        operation: "message.deliver",
        requiredProof: "delivered",
        verification: "callback",
      },
    },
    {
      async execute() {
        executed = true;
        return { ok: true };
      },
    },
  );

  const result = await runAgent({
    agentId: file.id,
    userId: "test-user",
    userInput: "Deliver it.",
    adapters: { persistence, tracing, llm: new NoToolLlm() },
    tools,
    sources: noSourcePlan(),
    onEvent: () => undefined,
  });

  assert.equal(executed, false);
  assert.equal(result.status, "completed");
  assert.equal(result.outcomeStatus, "pending");
  assert.equal(result.receipt?.actions?.length, 1);
  assert.equal(result.receipt?.actions?.[0]?.status, "pending");
  assert.match(result.receipt?.actions?.[0]?.message ?? "", /has not run/i);
  assert.equal(saved[0]?.metadata?.requirementId, "deliver-result");
});

test("a promised read is proved by invoking the exact registered operation", async () => {
  const file = agentFile();
  file.blueprint.capabilityPlan = {
    version: 1,
    resolutions: [
      {
        requirementId: "list-items",
        requirement: "List the scheduled items",
        status: "supported",
        path: "execute",
        operationId: "test.read:list",
        tool: "test.read",
        effect: "read",
        critical: true,
      },
    ],
  };
  const { persistence, tracing } = createInMemoryAdapters(file);
  const tools = new InMemoryToolRegistry();
  tools.register(
    {
      type: "inline",
      name: "test.read",
      description: "List test items.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      async execute() {
        return { items: ["one"] };
      },
    },
  );

  const result = await runAgent({
    agentId: file.id,
    userId: "test-user",
    userInput: "List them.",
    adapters: { persistence, tracing, llm: new ReadLlm() },
    tools,
    sources: noSourcePlan(),
    onEvent: () => undefined,
  });

  assert.equal(result.outcomeStatus, "succeeded");
  assert.equal(result.receipt?.actions?.[0]?.status, "succeeded");
  assert.equal(result.receipt?.actions?.[0]?.proof, "postcondition_verified");
  assert.equal(
    result.receipt?.actions?.[0]?.metadata?.actualToolCallId,
    "read-1",
  );
});

test("failed runs retain completed and partial-call usage in memory and persistence", async () => {
  const file = agentFile();
  const { persistence, tracing } = createInMemoryAdapters(file);
  const tools = new InMemoryToolRegistry();
  tools.register(
    {
      type: "inline",
      name: "test.read",
      description: "Read a test item before the next model turn.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      async execute() {
        return { item: "one" };
      },
    },
  );

  const result = await runAgent({
    agentId: file.id,
    userId: "test-user",
    userInput: "Read it, then answer.",
    adapters: {
      persistence,
      tracing,
      llm: new BilledThenDisconnectedLlm(),
    },
    tools,
    sources: noSourcePlan(),
    onEvent: () => undefined,
  });

  // Sonnet: input 1,500*3 + output 150*15 + cache-read 1,000*3*0.1
  // + cache-create 200*3*1.25 = 7,800 USD-millionths = 0.78 cents.
  assert.equal(result.status, "failed");
  assert.match(result.output, /provider stream disconnected/i);
  assert.equal(result.totalTokens, 2_850);
  assert.ok(Math.abs(result.costCents - 0.78) < 1e-12);
  assert.equal(result.llmCalls, 2);
  assert.ok(result.latencyMs >= 0);

  const persisted = persistence
    .listRuns()
    .find((candidate) => candidate.id === result.runId);
  assert.equal(persisted?.totalTokens, result.totalTokens);
  assert.equal(persisted?.costCents, result.costCents);
  assert.equal(persisted?.latencyMs, result.latencyMs);
  assert.equal(persisted?.llmCalls, result.llmCalls);
});

test("estimated compatible-endpoint usage is never finalized as exact", async () => {
  const file = agentFile();
  const { persistence, tracing } = createInMemoryAdapters(file);
  const result = await runAgent({
    agentId: file.id,
    userId: "test-user",
    userInput: "Answer.",
    adapters: { persistence, tracing, llm: new EstimatedUsageLlm() },
    tools: new InMemoryToolRegistry(),
    sources: noSourcePlan(),
    onEvent: () => undefined,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.attemptUsageExact, false);
  // The engine carries the conservative call ceiling forward, rather than
  // treating a provider's synthetic token estimate as an exact receipt.
  assert.ok((result.attemptCostCents ?? 0) > 0);
});
