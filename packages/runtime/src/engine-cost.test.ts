import assert from "node:assert/strict";
import test from "node:test";
import { conservativeProviderCallCostCents } from "./engine.ts";
import { usageCostDelta } from "./usage-cost.ts";

test("resume cost excludes prior primary-model usage", () => {
  const resumed = usageCostDelta(
    {
      inputTokens: 1_100,
      outputTokens: 550,
      cacheReadTokens: 210,
      cacheCreationTokens: 120,
    },
    {
      inputTokens: 1_000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheCreationTokens: 100,
    },
  );
  const currentSegment = usageCostDelta(
    {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheCreationTokens: 20,
    },
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
  );
  const cumulative = usageCostDelta(
    {
      inputTokens: 1_100,
      outputTokens: 550,
      cacheReadTokens: 210,
      cacheCreationTokens: 120,
    },
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
  );

  assert.deepEqual(resumed, currentSegment);
  assert.ok(cumulative.inputTokens > resumed.inputTokens);
  assert.ok(cumulative.outputTokens > resumed.outputTokens);
});

test("counter regression never produces a negative retry charge", () => {
  assert.deepEqual(
    usageCostDelta(
      { inputTokens: 10, outputTokens: 5 },
      { inputTokens: 20, outputTokens: 8 },
    ),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
  );
});

test("pre-dispatch estimate accounts for high-density UTF-8 input", () => {
  const common = {
    model: "claude-sonnet-5",
    messages: [],
    maxTokens: 1,
  };
  const ascii = conservativeProviderCallCostCents({
    ...common,
    system: "a".repeat(500),
  });
  const unicode = conservativeProviderCallCostCents({
    ...common,
    system: "é".repeat(500),
  });
  assert.ok(unicode > ascii);
});

test("unknown model reservation uses the safety price ceiling", () => {
  const common = { system: "rule", messages: [], maxTokens: 2_000 };
  const catalog = conservativeProviderCallCostCents({
    ...common,
    model: "claude-sonnet-5",
  });
  const unknown = conservativeProviderCallCostCents({
    ...common,
    model: "custom/future-model",
  });
  assert.ok(unknown > catalog * 10);
});
