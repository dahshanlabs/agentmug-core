import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_FILE_SCHEMA_V1,
  AGENT_FILE_SCHEMA_V2,
  checkArtifactCompatibility,
  getCapabilityCapsules,
  parseAgentFile,
  parseAgentFileV1,
  type AgentFileV1,
} from "./agent-file";
import {
  EXECUTABLE_CAPABILITY_KIND,
  EXECUTABLE_CAPABILITY_POLICY,
  executableCapabilitySha256,
  type UnsignedAgentExecutableCapabilityV1,
} from "../capabilities/executable-capability";

function fileWithParameter(): AgentFileV1 {
  return {
    $schema: AGENT_FILE_SCHEMA_V1,
    id: "artifact-grounded-agent",
    name: "Artifact-grounded agent",
    description: "Uses a private source table without carrying its data.",
    version: "1.0.0",
    exportedAt: "2026-07-29T00:00:00.000Z",
    blueprint: {
      primaryModel: "claude-sonnet-4-6",
      systemPrompt: "Use the bound Source table 1 private knowledge.",
      tools: [],
    },
    parameters: [
      {
        name: "source_file_1",
        label: "Source table 1",
        type: "file",
        required: true,
        artifact: {
          kind: "table",
          accepts: [".csv", ".xlsx"],
          structure: ['Sheet "Invoices" columns: invoice_id, amount, due_date'],
        },
      },
    ],
    inputs: { accepts: ["text"] },
    outputs: { shape: "text" },
  };
}

test("parses a portable private file contract without a bound value", () => {
  const parsed = parseAgentFile(fileWithParameter());
  assert.equal(parsed.parameters?.[0]?.type, "file");
  assert.equal(JSON.stringify(parsed).includes("owner-invoices.xlsx"), false);
});

test("runtime placement survives export and prevents cloud ambiguity", () => {
  const value = fileWithParameter();
  value.execution = {
    target: "desktop",
    cloudRunnable: false,
    requiresUserPresence: true,
    reason: "This job controls a visible desktop session.",
  };
  const parsed = parseAgentFile(value);
  assert.deepEqual(parsed.execution, value.execution);
});

test("model choice and outcome proof policy survive portable export", () => {
  const value = fileWithParameter();
  value.blueprint.modelPolicy = {
    mode: "preferred",
    preferredModels: ["claude-sonnet-4-6", "local/qwen3"],
    requiredCapabilities: ["tool_use", "reasoning"],
    minimumContextTokens: 32_000,
    allowLocal: true,
  };
  value.blueprint.outcomeContract = {
    version: 1,
    intent: "create_worker",
    jobToBeDone: "Summarize private invoices without exporting their contents.",
  };
  value.blueprint.capabilityPlan = {
    version: 1,
    exactTaskTest: {
      statement: "Summarize one representative invoice set.",
      requiredEvidence: ["run receipt"],
    },
  };

  const parsed = parseAgentFile(value);
  assert.deepEqual(parsed.blueprint.modelPolicy, value.blueprint.modelPolicy);
  assert.deepEqual(
    parsed.blueprint.outcomeContract,
    value.blueprint.outcomeContract,
  );
  assert.deepEqual(
    parsed.blueprint.capabilityPlan,
    value.blueprint.capabilityPlan,
  );
});

test("rejects malformed portable model policy", () => {
  const value: any = fileWithParameter();
  value.blueprint.modelPolicy = {
    mode: "anything-goes",
    preferredModels: [""],
    allowLocal: "yes",
  };
  assert.throws(
    () => parseAgentFile(value),
    /blueprint\.modelPolicy(?:\.mode)? is invalid/,
  );
});

test("rejects malformed runtime placement", () => {
  const value: any = fileWithParameter();
  value.execution = { target: "magic-cloud", cloudRunnable: "yes" };
  assert.throws(() => parseAgentFile(value), /execution\.target is invalid/);
});

test("checks a recipient workbook before binding", () => {
  const parameter = fileWithParameter().parameters![0];
  const result = checkArtifactCompatibility(parameter, {
    filename: "my-invoices.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    kind: "table",
    structure: ['Sheet "Invoices" columns: invoice_id, amount, due_date'],
  });
  assert.equal(result.compatible, true);
  assert.deepEqual(result.missingStructure, []);
});

test("fails loud when required structure is absent", () => {
  const parameter = fileWithParameter().parameters![0];
  const result = checkArtifactCompatibility(parameter, {
    filename: "other.csv",
    mimeType: "text/csv",
    kind: "table",
    structure: ["Columns: customer, status"],
  });
  assert.equal(result.compatible, false);
  assert.equal(result.missingStructure.length, 1);
});

test("does not satisfy a required structural token with a substring collision", () => {
  const parameter = fileWithParameter().parameters![0];
  parameter.artifact!.structure = ["amount"];
  const result = checkArtifactCompatibility(parameter, {
    filename: "other.csv",
    mimeType: "text/csv",
    kind: "table",
    structure: ["discount_amount"],
  });
  assert.equal(result.compatible, false);
  assert.deepEqual(result.missingStructure, ["amount"]);

  const safeSuperset = checkArtifactCompatibility(parameter, {
    filename: "other.csv",
    mimeType: "text/csv",
    kind: "table",
    structure: ["Columns: invoice_id, amount, due_date"],
  });
  assert.equal(safeSuperset.compatible, true);
});

test("rejects file defaults so private bindings cannot travel", () => {
  const value = fileWithParameter();
  value.parameters![0].default = "owner-document-id";
  assert.throws(
    () => parseAgentFile(value),
    /cannot carry a default file binding/,
  );
});

test("preserves a complete reusable-skill provenance pin", () => {
  const value = fileWithParameter();
  value.blueprint.skills = [
    {
      name: "invoice_follow_up",
      trigger: "when an invoice is overdue",
      recipe: "Confirm the amount, then schedule a reminder.",
      verified: true,
      librarySkillId: "skill-123",
      librarySkillVersion: 4,
    },
  ];
  const parsed = parseAgentFile(value);
  assert.equal(parsed.blueprint.skills?.[0]?.librarySkillId, "skill-123");
  assert.equal(parsed.blueprint.skills?.[0]?.librarySkillVersion, 4);
});

test("preserves a redacted task-proof attestation without private fixture evidence", () => {
  const value = fileWithParameter();
  value.blueprint.skills = [
    {
      name: "invoice_follow_up",
      trigger: "when an invoice is overdue",
      recipe: "Confirm the amount, then schedule a reminder.",
      verified: true,
      proof: {
        version: 1,
        receiptId: "proof-receipt-123",
        status: "passed",
        capabilityKind: "python_transform",
        harnessId: "portable-python-v2",
        sandboxId: "e2b-code-interpreter",
        contractMatched: true,
        criteriaPassed: 2,
        criteriaTotal: 2,
        judgeId: "independent-task-proof-v1",
        judgeModel: "claude-sonnet-4-6",
        verifiedAt: "2026-08-03T00:00:00.000Z",
      },
    },
  ];

  const parsed = parseAgentFile(value);
  assert.deepEqual(
    parsed.blueprint.skills?.[0]?.proof,
    value.blueprint.skills[0]?.proof,
  );
  assert.equal(JSON.stringify(parsed).includes("taskFingerprint"), false);
  assert.equal(JSON.stringify(parsed).includes("expectedOutput"), false);
});

test("v2 preserves a digest-pinned capsule while v1 remains code-free", async () => {
  const unsigned: UnsignedAgentExecutableCapabilityV1 = {
    version: 1,
    kind: EXECUTABLE_CAPABILITY_KIND,
    language: "python",
    entrypoint: "run",
    policy: EXECUTABLE_CAPABILITY_POLICY,
    source:
      "def run(payload):\n    return {'total': payload['quantity'] * payload['price']}",
    contract: {
      inputSchema: {
        type: "object",
        properties: {
          quantity: { type: "number" },
          price: { type: "number" },
        },
        required: ["quantity", "price"],
      },
      outputSchema: {
        type: "object",
        properties: { total: { type: "number" } },
        required: ["total"],
      },
    },
    permissions: {
      network: false,
      secrets: [],
      filesystemWrites: false,
    },
  };
  const digest = await executableCapabilitySha256(unsigned);
  const value = fileWithParameter();
  const proof = {
    version: 2 as const,
    receiptId: "proof-receipt-reuse-123",
    status: "passed" as const,
    capabilityKind: "portable_python_skill_v1",
    harnessId: "portable-python-v2",
    sandboxId: "e2b-code-interpreter",
    contractMatched: true as const,
    criteriaPassed: 2,
    criteriaTotal: 2,
    judgeId: "independent-task-proof-v1",
    judgeModel: "claude-sonnet-4-6",
    verifiedAt: "2026-08-09T00:00:00.000Z",
    artifactDigest: digest,
    reusableInputVerified: true as const,
  };
  value.blueprint.tools = ["capability.execute"];
  value.blueprint.skills = [
    {
      name: "invoice_total",
      trigger: "when the user asks to total an invoice line",
      recipe:
        "Call capability.execute with invoice_total and the current quantity and price.",
      verified: true,
      proof,
    },
  ];

  const parsed = parseAgentFile(
    JSON.parse(
      JSON.stringify({
        ...value,
        $schema: AGENT_FILE_SCHEMA_V2,
        capabilityCapsules: [
          {
            version: 1,
            name: "invoice_total",
            proof,
            artifact: { ...unsigned, digest },
          },
        ],
      }),
    ) as unknown,
  );
  assert.equal(getCapabilityCapsules(parsed)[0]?.artifact.digest, digest);
  assert.equal("executable" in parsed.blueprint.skills![0]!, false);
  assert.throws(() => parseAgentFileV1(parsed), /accepts agent\.v1 only/);
  assert.equal(JSON.stringify(parsed).includes("sampleInput"), false);
  assert.equal(JSON.stringify(parsed).includes('quantity":2'), false);
});

test("v1 rejects executable content even when hidden under a forward-compatible skill", async () => {
  const unsigned: UnsignedAgentExecutableCapabilityV1 = {
    version: 1,
    kind: EXECUTABLE_CAPABILITY_KIND,
    language: "python",
    entrypoint: "run",
    policy: EXECUTABLE_CAPABILITY_POLICY,
    source: "def run(payload):\n    return payload",
    contract: { inputSchema: {}, outputSchema: {} },
    permissions: { network: false, secrets: [], filesystemWrites: false },
  };
  const digest = await executableCapabilitySha256(unsigned);
  const value: any = fileWithParameter();
  value.blueprint.skills = [
    {
      name: "unsafe_import",
      trigger: "always",
      recipe: "Run it.",
      verified: true,
      executable: { ...unsigned, digest },
    },
  ];
  assert.throws(
    () => parseAgentFile(value),
    /cannot contain executable content/,
  );
});

test("v2 capsule cannot self-authorize without reusable proof", async () => {
  const unsigned: UnsignedAgentExecutableCapabilityV1 = {
    version: 1,
    kind: EXECUTABLE_CAPABILITY_KIND,
    language: "python",
    entrypoint: "run",
    policy: EXECUTABLE_CAPABILITY_POLICY,
    source: "def run(payload):\n    return payload",
    contract: { inputSchema: {}, outputSchema: {} },
    permissions: { network: false, secrets: [], filesystemWrites: false },
  };
  const digest = await executableCapabilitySha256(unsigned);
  const value: any = fileWithParameter();
  value.$schema = AGENT_FILE_SCHEMA_V2;
  value.blueprint.tools = ["capability.execute"];
  value.blueprint.skills = [
    {
      name: "unsafe_import",
      trigger: "always",
      recipe: "Run it.",
      verified: true,
    },
  ];
  value.capabilityCapsules = [
    {
      version: 1,
      name: "unsafe_import",
      artifact: { ...unsigned, digest },
    },
  ];
  assert.throws(() => parseAgentFile(value), /invalid proof or artifact/);
});

test("rejects malformed or incomplete task-proof attestations", () => {
  const value = fileWithParameter();
  value.blueprint.skills = [
    {
      name: "invoice_follow_up",
      trigger: "when an invoice is overdue",
      recipe: "Confirm the amount, then schedule a reminder.",
      proof: {
        version: 1,
        receiptId: "proof-receipt-123",
        status: "passed",
        capabilityKind: "python_transform",
        harnessId: "portable-python-v2",
        sandboxId: "e2b-code-interpreter",
        contractMatched: true,
        criteriaPassed: 1,
        criteriaTotal: 2,
        judgeId: "independent-task-proof-v1",
        judgeModel: "claude-sonnet-4-6",
        verifiedAt: "2026-08-03T00:00:00.000Z",
      },
    },
  ];

  assert.throws(() => parseAgentFile(value), /invalid proof attestation/);

  value.blueprint.skills[0]!.proof!.criteriaPassed = 2;
  value.blueprint.skills[0]!.proof!.sandboxId = "";
  assert.throws(() => parseAgentFile(value), /invalid proof attestation/);
});

test("rejects incomplete reusable-skill provenance pins", () => {
  const value = fileWithParameter();
  value.blueprint.skills = [
    {
      name: "invoice_follow_up",
      trigger: "when an invoice is overdue",
      recipe: "Confirm the amount, then schedule a reminder.",
      librarySkillId: "skill-123",
    },
  ];
  assert.throws(
    () => parseAgentFile(value),
    /needs both librarySkillId and librarySkillVersion/,
  );
});
