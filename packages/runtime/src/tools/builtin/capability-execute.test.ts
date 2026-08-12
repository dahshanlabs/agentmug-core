import assert from "node:assert/strict";
import test from "node:test";
import {
  EXECUTABLE_CAPABILITY_KIND,
  EXECUTABLE_CAPABILITY_POLICY,
  executableCapabilitySha256,
  type AgentExecutableCapabilityV1,
  type UnsignedAgentExecutableCapabilityV1,
} from "../../capabilities/executable-capability";
import {
  CapabilityExecuteExecutor,
  type CapabilityExecutionSandbox,
} from "./capability-execute";
import type { ToolExecutionContext } from "../registry";

const context: ToolExecutionContext = {
  runId: "run-b",
  agentId: "agent-1",
  userId: "user-1",
  recursionDepth: 0,
};

async function fixture() {
  const unsigned: UnsignedAgentExecutableCapabilityV1 = {
    version: 1,
    kind: EXECUTABLE_CAPABILITY_KIND,
    language: "python",
    entrypoint: "run",
    policy: EXECUTABLE_CAPABILITY_POLICY,
    source:
      "def run(payload):\n    return {'needs_approval': float(payload['amount']) > float(payload['limit'])}",
    contract: {
      inputSchema: {
        type: "object",
        properties: {
          amount: { type: "number" },
          limit: { type: "number" },
        },
        required: ["amount", "limit"],
      },
      outputSchema: {
        type: "object",
        properties: { needs_approval: { type: "boolean" } },
        required: ["needs_approval"],
      },
    },
    permissions: { network: false, secrets: [], filesystemWrites: false },
  };
  const digest = await executableCapabilitySha256(unsigned);
  const executable: AgentExecutableCapabilityV1 = { ...unsigned, digest };
  const skill = {
    name: "expense_policy_checker",
    trigger: "when reviewing an expense",
    recipe:
      "Call capability.execute with the current amount and approval limit.",
    verified: true,
    proof: {
      version: 2,
      receiptId: "proof-a",
      status: "passed",
      capabilityKind: "portable_python_skill_v1",
      harnessId: "portable-python-v2",
      sandboxId: "test-sandbox",
      contractMatched: true,
      criteriaPassed: 2,
      criteriaTotal: 2,
      judgeId: "test-judge",
      judgeModel: "test-model",
      verifiedAt: "2026-08-09T00:00:00.000Z",
      artifactDigest: digest,
      reusableInputVerified: true,
    } as const,
    executable,
  };
  return { executable, skill };
}

test("A-built capability executes a different B payload, never the proof fixture", async () => {
  const { executable, skill } = await fixture();
  const seen: unknown[] = [];
  const sandbox: CapabilityExecutionSandbox = {
    id: "capturing-no-network-sandbox",
    async execute(input) {
      seen.push(input.payload);
      const payload = input.payload as { amount: number; limit: number };
      return { needs_approval: payload.amount > payload.limit };
    },
  };
  const executor = new CapabilityExecuteExecutor({
    skills: [skill],
    sandbox,
    trustedArtifactDigests: [executable.digest],
  });

  // Build proof A was amount=120/limit=100. Runtime request B is deliberately
  // different and is the only payload the sandbox receives.
  const payloadB = { amount: 90, limit: 250 };
  const result = await executor.execute(
    { name: skill.name, payload: payloadB },
    context,
  );
  assert.deepEqual(seen, [payloadB]);
  assert.deepEqual(result.output, { needs_approval: false });
  assert.equal(executable.source.includes("120"), false);
});

test("unsigned or imported proof cannot authorize its own artifact", async () => {
  const { skill } = await fixture();
  let sandboxCalls = 0;
  const executor = new CapabilityExecuteExecutor({
    skills: [skill],
    sandbox: {
      id: "must-not-run",
      async execute() {
        sandboxCalls += 1;
        return {};
      },
    },
  });
  await assert.rejects(
    () =>
      executor.execute(
        { name: skill.name, payload: { amount: 1, limit: 2 } },
        context,
      ),
    /locally re-verified/,
  );
  assert.equal(sandboxCalls, 0);
});

test("a v2 capsule is discoverable but remains quarantined without host-owned trust", async () => {
  const { executable, skill } = await fixture();
  let sandboxCalls = 0;
  const executor = new CapabilityExecuteExecutor({
    capabilityCapsules: [
      {
        version: 1,
        name: skill.name,
        proof: skill.proof,
        artifact: executable,
      },
    ],
    sandbox: {
      id: "must-not-run",
      async execute() {
        sandboxCalls += 1;
        return { needs_approval: false };
      },
    },
  });
  await assert.rejects(
    () =>
      executor.execute(
        { name: skill.name, payload: { amount: 1, limit: 2 } },
        context,
      ),
    /locally re-verified/,
  );
  assert.equal(sandboxCalls, 0);
});

test("source tampering is caught by the digest before sandbox execution", async () => {
  const { executable, skill } = await fixture();
  const tampered = {
    ...skill,
    executable: {
      ...skill.executable,
      source: `${skill.executable.source}\n# changed after proof`,
    },
  };
  let sandboxCalls = 0;
  const executor = new CapabilityExecuteExecutor({
    skills: [tampered],
    trustedArtifactDigests: [executable.digest],
    sandbox: {
      id: "must-not-run",
      async execute() {
        sandboxCalls += 1;
        return {};
      },
    },
  });
  await assert.rejects(
    () =>
      executor.execute(
        { name: skill.name, payload: { amount: 1, limit: 2 } },
        context,
      ),
    /digest does not match/,
  );
  assert.equal(sandboxCalls, 0);
});

test("input and output schemas are enforced at the final sandbox boundary", async () => {
  const { executable, skill } = await fixture();
  let sandboxCalls = 0;
  const executor = new CapabilityExecuteExecutor({
    skills: [skill],
    trustedArtifactDigests: [executable.digest],
    sandbox: {
      id: "contract-sandbox",
      async execute() {
        sandboxCalls += 1;
        return { needs_approval: "not-a-boolean" };
      },
    },
  });
  await assert.rejects(
    () =>
      executor.execute(
        { name: skill.name, payload: { amount: "wrong", limit: 2 } },
        context,
      ),
    /input contract/,
  );
  assert.equal(sandboxCalls, 0);
  await assert.rejects(
    () =>
      executor.execute(
        { name: skill.name, payload: { amount: 1, limit: 2 } },
        context,
      ),
    /output contract/,
  );
  assert.equal(sandboxCalls, 1);
});
