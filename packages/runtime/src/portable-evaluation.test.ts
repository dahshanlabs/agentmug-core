import assert from "node:assert/strict";
import test from "node:test";

import type {
  LlmClient,
  LlmStreamEvent,
  LlmStreamParams,
} from "./adapters/llm";
import { buildAgentFile } from "./format/agent-file";
import { quickRun } from "./quickstart";

class StaticLlm implements LlmClient {
  calls = 0;

  constructor(private readonly answer: string) {}

  async *streamMessage(
    _params: LlmStreamParams,
  ): AsyncIterable<LlmStreamEvent> {
    this.calls += 1;
    yield { type: "input_tokens", count: 10 };
    yield { type: "output_tokens", count: 5 };
    yield { type: "text_delta", text: this.answer };
    yield {
      type: "message_complete",
      stopReason: "end_turn",
      content: [{ type: "text", text: this.answer }],
    };
  }
}

function evaluationAgent(outputSchema: Record<string, unknown>) {
  return buildAgentFile({
    id: "portable-evaluation-agent",
    name: "Portable evaluation agent",
    description: "Returns a structured answer.",
    version: "1.0.0",
    exportedAt: "2026-08-04T00:00:00.000Z",
    blueprint: {
      primaryModel: "test-model",
      systemPrompt: "Return JSON.",
      tools: [],
    },
    inputs: { accepts: ["text"] },
    evaluation: {
      version: 1,
      failurePolicy: "block",
      minimumScore: 1,
      checks: [
        {
          id: "json-contract",
          name: "Output follows the JSON contract",
          type: "output-schema",
          phase: "post-run",
          severity: "error",
          config: { schema: outputSchema },
        },
      ],
    },
  });
}

test("a valid portable output-schema check is recorded in the actual run receipt", async () => {
  const llm = new StaticLlm('{"status":"ready","count":2}');
  const result = await quickRun({
    agentFile: evaluationAgent({
      type: "object",
      required: ["status", "count"],
      additionalProperties: false,
      properties: {
        status: { const: "ready" },
        count: { type: "integer", minimum: 0 },
      },
    }),
    userInput: "run",
    llm,
  });

  assert.equal(result.status, "completed");
  assert.equal(llm.calls, 1);
  assert.equal(
    result.receipt?.evaluations.find((item) => item.checkId === "json-contract")
      ?.status,
    "passed",
  );
  assert.equal(
    result.receipt?.evaluations.find(
      (item) => item.checkId === "contract:minimum-score",
    )?.status,
    "passed",
  );
});

test("an invalid portable output-schema check blocks the result and records failure", async () => {
  const llm = new StaticLlm('{"status":"wrong"}');
  const result = await quickRun({
    agentFile: evaluationAgent({
      type: "object",
      required: ["status", "count"],
      properties: {
        status: { const: "ready" },
        count: { type: "integer" },
      },
    }),
    userInput: "run",
    llm,
  });

  assert.equal(result.status, "failed");
  assert.match(result.output, /portable checks blocked/i);
  assert.equal(
    result.receipt?.evaluations.find((item) => item.checkId === "json-contract")
      ?.status,
    "failed",
  );
});

test("a prose-only blocking check is skipped honestly and stops before model spend", async () => {
  const file = evaluationAgent({ type: "object" });
  file.evaluation = {
    version: 1,
    failurePolicy: "block",
    checks: [
      {
        id: "owner-policy",
        name: "Owner policy remains satisfied",
        type: "invariant",
        phase: "pre-run",
        severity: "error",
        assertion: "The answer respects our current private policy.",
      },
    ],
  };
  const llm = new StaticLlm("should not run");
  const result = await quickRun({
    agentFile: file,
    userInput: "run",
    llm,
  });

  assert.equal(result.status, "failed");
  assert.equal(llm.calls, 0);
  assert.equal(result.receipt?.evaluations[0]?.status, "skipped");
  assert.match(result.output, /owner-policy/);
});
