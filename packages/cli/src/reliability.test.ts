import assert from "node:assert/strict";
import { test } from "node:test";

import {
  evaluationCounts,
  formatCloudReliabilitySummary,
  type CloudReliabilitySummary,
} from "./reliability";

test("cloud reliability text is explicit about safety, privacy, and hosted scope", () => {
  const summary: CloudReliabilitySummary = {
    safeSimulation: true,
    caseCount: 3,
    canRun: true,
    latestRun: {
      id: "eval-1",
      agentId: "agent-1",
      trigger: "external",
      status: "completed",
      aggregateScore: 91.5,
      passRate: 2 / 3,
      casesRun: 3,
      startedAt: "2026-08-04T10:00:00.000Z",
      completedAt: "2026-08-04T10:00:02.000Z",
      createdAt: "2026-08-04T10:00:00.000Z",
    },
    history: [],
    privacy: "Private cases stay in AgentMug.",
  };
  const text = formatCloudReliabilitySummary(summary).join("\n");
  assert.match(text, /92%/);
  assert.match(text, /safe simulation/i);
  assert.match(text, /not a locally modified \.agent/i);
  assert.match(text, /private cases stay/i);
});

test("portable receipt evaluation counts preserve passed, failed, and skipped", () => {
  assert.deepEqual(
    evaluationCounts([
      { status: "passed" },
      { status: "passed" },
      { status: "failed" },
      { status: "skipped" },
    ]),
    { passed: 2, failed: 1, skipped: 1 },
  );
});
