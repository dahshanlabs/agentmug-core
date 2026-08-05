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
  async *streamMessage(
    params: LlmStreamParams,
  ): AsyncIterable<LlmStreamEvent> {
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
