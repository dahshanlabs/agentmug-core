import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createBridgeRequestHandlers,
  invokeAgent,
  type AgentInvocationResult,
  type AgentManifest,
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
