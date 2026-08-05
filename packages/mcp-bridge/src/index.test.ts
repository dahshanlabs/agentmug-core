import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createBridgeRequestHandlers,
  invokeAgent,
  runReliabilityCheck,
  type AgentInvocationResult,
  type AgentManifest,
  type ReliabilityRunSummary,
} from "./index";

function manifest(
  name: string,
  sources: AgentManifest["sources"],
): AgentManifest {
  return {
    id: "agent-1",
    name,
    description: "A grounded test agent",
    architecture: "single",
    model: "test-model",
    endpoint: "https://agentmug.example/api/external/agents/agent-1",
    tool: {
      name: "grounded_agent",
      description: "Answers from private sources",
      input_schema: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      },
    },
    sources,
  };
}

const readySources: NonNullable<AgentManifest["sources"]> = {
  ready: true,
  requirements: [
    {
      id: "ledger",
      role: "primary",
      kind: "document",
      label: "Current ledger",
      required: true,
    },
    {
      id: "policy",
      role: "policy",
      kind: "document",
      label: "Approval policy",
      required: true,
    },
  ],
  missing: [],
  stale: [],
};

const completedReliabilityRun: ReliabilityRunSummary = {
  id: "eval-1",
  agentId: "agent-1",
  trigger: "external",
  status: "completed",
  blueprintVersion: 3,
  aggregateScore: 92,
  passRate: 0.8,
  casesRun: 5,
  durationMs: 1200,
  startedAt: "2026-08-04T10:00:00.000Z",
  completedAt: "2026-08-04T10:00:01.200Z",
  createdAt: "2026-08-04T10:00:00.000Z",
};

const reliability: NonNullable<AgentManifest["reliability"]> = {
  safeSimulation: true,
  caseCount: 5,
  canRun: true,
  latestRun: completedReliabilityRun,
  history: [completedReliabilityRun],
  privacy: "Private regression cases stay in AgentMug.",
};

test("every MCP request refreshes readiness and a newly blocked source prevents invocation", async () => {
  const refreshed = [
    manifest("Revision one", readySources),
    manifest("Revision two", readySources),
    manifest("Revision three", {
      ...readySources,
      ready: false,
      stale: ["policy"],
    }),
    // Fail closed even if a malformed upstream summary says ready while also
    // reporting concrete required-source blockers.
    manifest("Revision four", {
      ...readySources,
      ready: true,
      missing: ["ledger"],
      stale: ["policy"],
    }),
    manifest("Revision five", readySources),
  ];
  let loads = 0;
  let invocations = 0;
  const successfulRun: AgentInvocationResult = {
    runId: "run-1",
    status: "completed",
    output: "Grounded answer",
    text: "Grounded answer",
    toolCalls: [],
    totalTokens: 12,
    costCents: 1,
    latencyMs: 5,
  };
  const handlers = createBridgeRequestHandlers({
    initialManifest: manifest("Initial", readySources),
    loadManifest: async () => {
      const next = refreshed[loads];
      loads += 1;
      assert.ok(next, "each request must consume a fresh manifest");
      return next;
    },
    invoke: async () => {
      invocations += 1;
      return successfulRun;
    },
  });

  const tools = await handlers.listTools();
  assert.match(tools.tools[0]?.description ?? "", /sources are ready/i);

  const resources = await handlers.listResources();
  assert.equal(resources.resources[0]?.name, "Revision two source contract");

  const sourceUri = "agentmug://agents/agent-1/source-contract";
  const sourceContract = await handlers.readResource(sourceUri);
  const parsedContract = JSON.parse(
    sourceContract.contents[0]?.text ?? "{}",
  ) as {
    sourceContract?: { stale?: string[] };
  };
  assert.deepEqual(parsedContract.sourceContract?.stale, ["policy"]);

  const blocked = await handlers.callTool("grounded_agent", {
    message: "Use my ledger",
  });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0]?.text ?? "", /ledger/);
  assert.match(blocked.content[0]?.text ?? "", /policy/);
  assert.equal(invocations, 0, "blocked readiness must fail before invocation");

  const allowed = await handlers.callTool("grounded_agent", {
    message: "Use my ledger",
  });
  assert.equal(allowed.isError, false);
  assert.equal(invocations, 1);
  assert.equal(loads, 5, "all five requests must refresh the manifest");
});

test("an incomplete SSE stream rejects the run without exposing partial output", async () => {
  const privatePartial = "PRIVATE-PARTIAL-OUTPUT";
  let fetches = 0;
  const fetchImpl = (async () => {
    fetches += 1;
    return new Response(
      `data: ${JSON.stringify({
        type: "token",
        content: privatePartial,
      })}`,
      {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      },
    );
  }) as typeof fetch;

  let failure: Error | undefined;
  try {
    await invokeAgent(
      {
        invokeUrl:
          "https://agentmug.example/api/external/agents/agent-1/invoke",
        streamUrl:
          "https://agentmug.example/api/external/agents/agent-1/invoke/stream",
        apiKey: "test-key",
      },
      { message: "hello" },
      fetchImpl,
    );
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }

  assert.ok(failure, "a stream without a terminal done event must fail");
  assert.match(failure.message, /without a terminal run status/i);
  assert.match(failure.message, /partial output was discarded/i);
  assert.doesNotMatch(failure.message, new RegExp(privatePartial));
  assert.equal(fetches, 1);
});

test("a terminal done event is accepted even when it is the final unterminated line", async () => {
  const fetchImpl = (async () =>
    new Response(
      `data: ${JSON.stringify({
        type: "token",
        content: "Grounded ",
      })}\n` +
        `data: ${JSON.stringify({
          type: "done",
          runId: "run-final",
          status: "completed",
          output: "Grounded answer",
        })}`,
      {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      },
    )) as typeof fetch;

  const result = await invokeAgent(
    {
      invokeUrl: "https://agentmug.example/api/external/agents/agent-1/invoke",
      streamUrl:
        "https://agentmug.example/api/external/agents/agent-1/invoke/stream",
      apiKey: "test-key",
    },
    { message: "hello" },
    fetchImpl,
  );

  assert.equal(result.runId, "run-final");
  assert.equal(result.output, "Grounded answer");
});

test("MCP exposes reliability summaries and delegates an explicit safe check without private cases", async () => {
  const initial = { ...manifest("Reliable worker", readySources), reliability };
  let checks = 0;
  const handlers = createBridgeRequestHandlers({
    initialManifest: initial,
    loadManifest: async () => initial,
    invoke: async () => {
      throw new Error(
        "the worker tool should not run during a reliability check",
      );
    },
    runReliability: async () => {
      checks += 1;
      return completedReliabilityRun;
    },
  });

  const tools = await handlers.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    ["grounded_agent", "grounded_agent_safe_check"],
  );

  const resources = await handlers.listResources();
  const reliabilityResource = resources.resources.find((resource) =>
    resource.uri.endsWith("/reliability"),
  );
  assert.ok(reliabilityResource);
  const read = await handlers.readResource(reliabilityResource.uri);
  const text = read.contents[0]?.text ?? "";
  assert.match(text, /92/);
  assert.doesNotMatch(text, /private input|expected output|assertion/i);

  const checked = await handlers.callTool("grounded_agent_safe_check", {});
  assert.equal(checked.isError, false);
  assert.equal(checks, 1);
  assert.match(checked.content[0]?.text ?? "", /safe simulation/i);
  assert.equal(checked.structuredContent?.safeSimulation, true);
});

test("reliability HTTP responses are bounded and strip unexpected detailed results", async () => {
  const responseWithPrivateDetails = {
    ...completedReliabilityRun,
    results: [
      {
        input: "PRIVATE INPUT",
        expectedOutput: "PRIVATE EXPECTATION",
      },
    ],
  };
  const fetchImpl = (async () =>
    new Response(JSON.stringify(responseWithPrivateDetails), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  const result = await runReliabilityCheck(
    "https://agentmug.example/api/external/agents/agent-1/reliability/check",
    "am_agent_test",
    fetchImpl,
  );
  assert.equal(result.aggregateScore, 92);
  assert.equal("results" in result, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});
