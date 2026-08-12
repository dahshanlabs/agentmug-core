// Schema ↔ parser drift gate.
//
// The published JSON Schema (schemas/agent.v1.json, served at
// https://agentmug.com/schemas/agent.v1.json and shipped in this npm
// package) and parseAgentFile() are two descriptions of the same wire
// format. External authors — including coding agents generating .agent
// files against the schema — trust that a file the schema accepts will
// import, and a file it rejects won't. This suite makes that promise a
// red build instead of a hope:
//
//   1. Every file in the VALID corpus must pass BOTH parseAgentFile and
//      the schema. A schema that rejects a parser-valid file breaks
//      every external author generating against it.
//   2. Every file in the INVALID corpus must fail BOTH. A schema that
//      accepts parser-invalid garbage tells authors a broken file is
//      fine and moves the failure to import time.
//
// Checks the parser enforces across fields that draft 2020-12 cannot
// express (or can only express unreadably) are listed in
// PARSER_ONLY_CHECKS with a reason — additions there need a reason too.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  AGENT_FILE_SCHEMA_V1,
  AGENT_FILE_SCHEMA_V1_LEGACY_AGENTLIT,
  AGENT_FILE_SCHEMA_V2,
  buildAgentFile,
  buildAgentFileV2,
  parseAgentFile,
  type AgentFileV1,
  type BuildAgentFileInput,
} from "./agent-file";

const schemaPath = process.env.AGENT_SCHEMA_PATH ?? "schemas/agent.v1.json";
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const schemaV2Path =
  process.env.AGENT_SCHEMA_V2_PATH ?? "schemas/agent.v2.json";
const schemaV2 = JSON.parse(readFileSync(schemaV2Path, "utf8"));

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(schema);
const validate = ajv.getSchema(AGENT_FILE_SCHEMA_V1)!;
const validateV2 = ajv.compile(schemaV2);

function schemaErrors(): string {
  return (validate.errors ?? [])
    .map((e) => `${e.instancePath || "/"} ${e.message}`)
    .join("; ");
}

function minimalInput(): BuildAgentFileInput {
  return {
    id: "drift-minimal",
    name: "Drift minimal",
    description: "Smallest file the format accepts.",
    version: "1.0.0",
    exportedAt: "2026-08-06T00:00:00.000Z",
    blueprint: {
      primaryModel: "claude-sonnet-4-6",
      systemPrompt: "Help the user.",
      tools: [],
    },
    inputs: { accepts: ["text"] },
  };
}

/** Exercises every optional block and every union arm the parser knows. */
function kitchenSink(): AgentFileV1 {
  return buildAgentFile({
    ...minimalInput(),
    id: "drift-kitchen-sink",
    name: "Drift kitchen sink",
    emoji: "🧪",
    execution: {
      target: "hybrid",
      cloudRunnable: true,
      requiresUserPresence: false,
      reason: "Cloud for schedules, desktop for local files.",
    },
    blueprint: {
      primaryModel: "claude-sonnet-4-6",
      modelPolicy: {
        mode: "preferred",
        preferredModels: ["claude-sonnet-4-6", "local/qwen3"],
        requiredCapabilities: ["tool_use", "reasoning"],
        minimumContextTokens: 32_000,
        allowLocal: true,
      },
      systemPrompt: "Follow up on invoices using {{params.tone}}.",
      tools: [
        "web.search",
        {
          kind: "builtin",
          name: "email.send",
          description: "Owner-addressed email.",
        },
        {
          kind: "mcp",
          name: "github.create_issue",
          server: "@modelcontextprotocol/server-github",
          provider: "github",
          requiresUserAuth: true,
          scopes: ["repo"],
          description: "Files issues with the user's GitHub token.",
        },
        {
          kind: "webhook",
          name: "crm.upsert",
          url: "https://example.com/hooks/crm",
          method: "POST",
          requiresUserAuth: false,
        },
        {
          kind: "nango",
          name: "outlook.list_messages",
          provider: "microsoft-outlook",
          endpoint: "/me/messages",
          method: "GET",
          scopes: ["Mail.Read"],
          requiresUserAuth: true,
        },
      ],
      maxTokens: 4_096,
      extendedThinkingBudget: 8_192,
      thinkingPatterns: ["plan-then-act"],
      architecture: "single",
      skills: [
        {
          name: "invoice_follow_up",
          trigger: "when an invoice is overdue",
          recipe: "Confirm the amount, then schedule a reminder.",
          verified: true,
          librarySkillId: "skill-123",
          librarySkillVersion: 4,
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
      ],
      caveats: [
        {
          requested: "Read my Apple Notes",
          doing: "Reads Notion pages instead",
          why: "No Apple Notes connector exists yet.",
          options: [
            {
              label: "Use Notion",
              detail: "Connect Notion below.",
              recommended: true,
            },
            { label: "Skip notes", detail: "Run without note context." },
          ],
        },
      ],
      outcomeContract: {
        version: 1,
        intent: "create_worker",
        jobToBeDone: "Chase overdue invoices weekly.",
      },
      capabilityPlan: {
        version: 1,
        exactTaskTest: {
          statement: "Summarize one representative invoice set.",
          requiredEvidence: ["run receipt"],
        },
      },
      guardrails: { sideEffectGate: "confirm", futureUnknownKnob: true },
    },
    parameters: [
      {
        name: "tone",
        label: "Tone",
        type: "select",
        required: true,
        options: [
          { value: "friendly", label: "Friendly" },
          { value: "firm", label: "Firm" },
        ],
      },
      {
        name: "cc_email",
        label: "CC address",
        type: "email",
        required: false,
        placeholder: "you@example.com",
      },
      { name: "report_url", label: "Report URL", type: "url", required: false },
      {
        name: "max_reminders",
        label: "Max reminders",
        type: "number",
        required: false,
        default: 3,
      },
      {
        name: "include_paid",
        label: "Include paid",
        type: "boolean",
        required: false,
        default: false,
      },
      { name: "notes", label: "Notes", type: "text", required: false },
      {
        name: "prefix",
        label: "Subject prefix",
        type: "string",
        required: false,
        default: "[AR]",
      },
      {
        name: "source_file_1",
        label: "Invoice workbook",
        type: "file",
        required: true,
        artifact: {
          kind: "table",
          accepts: [".csv", ".xlsx"],
          structure: ['Sheet "Invoices" columns: invoice_id, amount, due_date'],
        },
      },
    ],
    inputs: { accepts: ["text", "image"] },
    outputs: {
      shape: "json",
      schema: { type: "object", properties: { sent: { type: "number" } } },
      description: "Count of reminders sent.",
    },
    triggers: [
      { type: "manual" },
      {
        type: "schedule",
        cron: "0 9 * * 1",
        prompt: "Chase every overdue invoice.",
        timezone: "Asia/Riyadh",
        label: "Monday chase",
      },
      { type: "webhook", path: "/hooks/invoice-paid" },
      { type: "api", endpoint: "/api/agents/drift-kitchen-sink/invoke" },
    ],
    connectivity: {
      identities: [{ role: "owner", channel: "email" }],
      reads: [{ provider: "microsoft-outlook", resource: "mail" }],
      delivers: [
        { channel: "whatsapp", via: "twilio.send_whatsapp", to: "owner" },
      ],
    },
    sources: [
      {
        id: "invoice_workbook",
        label: "Invoice workbook",
        role: "working",
        kind: "file",
        required: true,
        accepts: {
          extensions: [".xlsx"],
          mediaTypes: [
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          ],
        },
        structure: {
          required: ['Sheet "Invoices": invoice_id, amount, due_date'],
        },
        freshness: { mode: "on-run", maxAgeSeconds: 3_600, onStale: "fail" },
        truth: {
          authority: "authoritative",
          priority: 100,
          conflictPolicy: "fail",
          citations: "required",
        },
        access: {
          capabilities: ["read", "cite", "sync", "write", "version"],
          boundaries: ['Sheet "Invoices": last_reminder, reminder_count'],
        },
        approval: { write: "every-action", destructive: "forbidden" },
        sharing: { strategy: "rebind", derivedKnowledge: "exclude" },
      },
    ],
    evaluation: {
      version: 1,
      failurePolicy: "require-approval",
      minimumScore: 0.8,
      checks: [
        {
          id: "workbook-ready",
          name: "Workbook bound and fresh",
          type: "source-ready",
          phase: "pre-run",
          severity: "error",
          sourceIds: ["invoice_workbook"],
        },
        {
          id: "cites-rows",
          name: "Cites invoice rows",
          type: "citation",
          phase: "post-run",
          severity: "warning",
          assertion: "Every amount mentioned cites an invoice row.",
        },
      ],
    },
    metadata: {
      sourceUrl: "https://agentmug.com/a/drift-kitchen-sink",
      sourceUserId: "user_123",
      tags: ["finance", "demo"],
      pricing: { kind: "one-time", amountUsd: 9 },
    },
    brain: [
      {
        slug: "billing-policy",
        title: "Billing policy",
        summary: "How we chase invoices.",
        content: "Net 30, one reminder per week.",
        links: ["payment-terms"],
        sources: ["invoice_workbook"],
      },
    ],
    memory: [{ key: "preferred_signoff", value: "Best, A.", importance: 3 }],
  });
}

type ValidCase = { label: string; file: AgentFileV1 };

const VALID_CORPUS: ValidCase[] = [
  { label: "minimal", file: buildAgentFile(minimalInput()) },
  {
    label: "legacy agentlit $schema url",
    file: buildAgentFile({
      ...minimalInput(),
      $schema: AGENT_FILE_SCHEMA_V1_LEGACY_AGENTLIT,
    }),
  },
  { label: "kitchen sink", file: kitchenSink() },
  {
    label: "unknown trigger type tolerated (forward compat)",
    file: parseAgentFile({
      ...buildAgentFile(minimalInput()),
      triggers: [{ type: "x-future-trigger", anything: true }],
    }),
  },
  {
    label: "connectivity entries carry unknown extra fields (forward compat)",
    file: parseAgentFile({
      ...buildAgentFile(minimalInput()),
      connectivity: {
        delivers: [{ channel: "email", via: "email.send", futureField: "ok" }],
      },
    }),
  },
  {
    label: "void output, audio input",
    file: buildAgentFile({
      ...minimalInput(),
      inputs: { accepts: ["text", "audio"] },
      outputs: { shape: "void", description: "Acts silently." },
    }),
  },
];

test("schema $id matches the parser's canonical AGENT_FILE_SCHEMA_V1", () => {
  assert.equal(schema.$id, AGENT_FILE_SCHEMA_V1);
});

test("v2 schema accepts only the explicit capsule boundary and v1 rejects those bytes", () => {
  const digest = `sha256:${"a".repeat(64)}` as const;
  const file = buildAgentFileV2({
    ...minimalInput(),
    blueprint: {
      ...minimalInput().blueprint,
      tools: ["capability.execute"],
      skills: [
        {
          name: "deterministic_total",
          trigger: "when totaling values",
          recipe: "Call capability.execute with current values.",
          verified: true,
        },
      ],
    },
    capabilityCapsules: [
      {
        version: 1,
        name: "deterministic_total",
        proof: {
          version: 2,
          receiptId: "proof-v2",
          status: "passed",
          capabilityKind: "portable_python_skill_v1",
          harnessId: "portable-python-v2",
          sandboxId: "proof-sandbox",
          contractMatched: true,
          criteriaPassed: 2,
          criteriaTotal: 2,
          judgeId: "reuse-judge",
          judgeModel: "claude-sonnet-4-6",
          verifiedAt: "2026-08-10T00:00:00.000Z",
          artifactDigest: digest,
          reusableInputVerified: true,
        },
        artifact: {
          version: 1,
          kind: "portable_python_v1",
          language: "python",
          entrypoint: "run",
          policy: "deterministic-transform-v1",
          source: "def run(payload):\n    return payload",
          digest,
          contract: { inputSchema: {}, outputSchema: {} },
          permissions: {
            network: false,
            secrets: [],
            filesystemWrites: false,
          },
        },
      },
    ],
  });
  assert.equal(schemaV2.$id, AGENT_FILE_SCHEMA_V2);
  assert.equal(validateV2(structuredClone(file)), true);
  assert.equal(validate(structuredClone(file)), false);
  assert.equal(validateV2(buildAgentFile(minimalInput())), false);
});

for (const { label, file } of VALID_CORPUS) {
  test(`valid corpus / ${label}: parser and schema both accept`, () => {
    assert.doesNotThrow(() => parseAgentFile(structuredClone(file)));
    assert.equal(
      validate(structuredClone(file)),
      true,
      `published schema rejected a parser-valid file — external authors generating against the schema would produce files we accept but told them are invalid. Errors: ${schemaErrors()}`,
    );
  });
}

// Cross-field rules draft 2020-12 cannot express readably. Each entry skips
// ONLY the schema-rejects assertion (the parser assertion always runs).
const PARSER_ONLY_CHECKS = new Set<string>([
  // Uniqueness of parameters[].name across array items has no clean 2020-12
  // encoding (uniqueItems compares whole objects, not one property).
  "duplicate parameter name",
]);

type InvalidCase = { label: string; mutate: (f: Record<string, any>) => void };

const INVALID_CORPUS: InvalidCase[] = [
  {
    label: "unsupported $schema url",
    mutate: (f) => {
      f.$schema = "https://example.com/other.json";
    },
  },
  {
    label: "missing name",
    mutate: (f) => {
      delete f.name;
    },
  },
  {
    label: "empty version",
    mutate: (f) => {
      f.version = "";
    },
  },
  {
    label: "missing blueprint",
    mutate: (f) => {
      delete f.blueprint;
    },
  },
  {
    label: "blueprint missing systemPrompt",
    mutate: (f) => {
      delete f.blueprint.systemPrompt;
    },
  },
  {
    label: "empty string tool id",
    mutate: (f) => {
      f.blueprint.tools = [""];
    },
  },
  {
    label: "unknown tool kind",
    mutate: (f) => {
      f.blueprint.tools = [{ kind: "magic", name: "x" }];
    },
  },
  {
    label: "v1 skill carries executable content",
    mutate: (f) => {
      f.blueprint.skills = [
        {
          name: "unsafe",
          trigger: "always",
          recipe: "Run it.",
          executable: { source: "print('unsafe')" },
        },
      ];
    },
  },
  {
    label: "tool object missing name",
    mutate: (f) => {
      f.blueprint.tools = [{ kind: "builtin" }];
    },
  },
  {
    label: "nango tool missing provider",
    mutate: (f) => {
      f.blueprint.tools = [
        { kind: "nango", name: "x.y", endpoint: "/x", requiresUserAuth: true },
      ];
    },
  },
  {
    label: "inputs.accepts empty",
    mutate: (f) => {
      f.inputs = { accepts: [] };
    },
  },
  {
    label: "unknown input type",
    mutate: (f) => {
      f.inputs = { accepts: ["video"] };
    },
  },
  {
    label: "unknown outputs.shape",
    mutate: (f) => {
      f.outputs = { shape: "xml" };
    },
  },
  {
    label: "modelPolicy bad mode",
    mutate: (f) => {
      f.blueprint.modelPolicy = { mode: "anything-goes" };
    },
  },
  {
    label: "modelPolicy bad capability",
    mutate: (f) => {
      f.blueprint.modelPolicy = {
        mode: "preferred",
        requiredCapabilities: ["telepathy"],
      };
    },
  },
  {
    label: "execution bad target",
    mutate: (f) => {
      f.execution = { target: "magic-cloud", cloudRunnable: true };
    },
  },
  {
    label: "execution cloudRunnable not boolean",
    mutate: (f) => {
      f.execution = { target: "cloud", cloudRunnable: "yes" };
    },
  },
  {
    label: "schedule trigger missing cron",
    mutate: (f) => {
      f.triggers = [{ type: "schedule" }];
    },
  },
  {
    label: "webhook trigger missing path",
    mutate: (f) => {
      f.triggers = [{ type: "webhook" }];
    },
  },
  {
    label: "trigger missing type",
    mutate: (f) => {
      f.triggers = [{ cron: "0 9 * * 1" }];
    },
  },
  {
    label: "parameter bad type",
    mutate: (f) => {
      f.parameters = [{ name: "x", label: "X", type: "date", required: true }];
    },
  },
  {
    label: "parameter name not snake_case",
    mutate: (f) => {
      f.parameters = [
        { name: "9bad", label: "X", type: "string", required: true },
      ];
    },
  },
  {
    label: "duplicate parameter name",
    mutate: (f) => {
      f.parameters = [
        { name: "x", label: "X", type: "string", required: true },
        { name: "x", label: "X again", type: "string", required: true },
      ];
    },
  },
  {
    label: "select parameter without options",
    mutate: (f) => {
      f.parameters = [
        { name: "x", label: "X", type: "select", required: true },
      ];
    },
  },
  {
    label: "file parameter with default binding",
    mutate: (f) => {
      f.parameters = [
        {
          name: "doc",
          label: "Doc",
          type: "file",
          required: true,
          artifact: { kind: "document", accepts: [".pdf"] },
          default: "owner-doc-id",
        },
      ];
    },
  },
  {
    label: "file parameter missing artifact",
    mutate: (f) => {
      f.parameters = [
        { name: "doc", label: "Doc", type: "file", required: true },
      ];
    },
  },
  {
    label: "caveat missing why",
    mutate: (f) => {
      f.blueprint.caveats = [{ requested: "X", doing: "Y" }];
    },
  },
  {
    label: "skill missing recipe",
    mutate: (f) => {
      f.blueprint.skills = [{ name: "s", trigger: "t" }];
    },
  },
  {
    label: "skill one-sided library pin",
    mutate: (f) => {
      f.blueprint.skills = [
        { name: "s", trigger: "t", recipe: "r", librarySkillId: "skill-1" },
      ];
    },
  },
  {
    label: "memory fact missing value",
    mutate: (f) => {
      f.memory = [{ key: "k" }];
    },
  },
  {
    label: "brain page missing title",
    mutate: (f) => {
      f.brain = [{ slug: "s", content: "c" }];
    },
  },
  {
    label: "evaluation bad failurePolicy",
    mutate: (f) => {
      f.evaluation = { version: 1, failurePolicy: "ignore", checks: [] };
    },
  },
];

for (const { label, mutate } of INVALID_CORPUS) {
  test(`invalid corpus / ${label}: parser and schema both reject`, () => {
    const file: Record<string, any> = structuredClone(
      buildAgentFile(minimalInput()),
    ) as any;
    mutate(file);
    assert.throws(
      () => parseAgentFile(structuredClone(file)),
      `parser accepted '${label}' — the invalid corpus is stale, update or remove the case`,
    );
    if (PARSER_ONLY_CHECKS.has(label)) return;
    assert.equal(
      validate(structuredClone(file)),
      false,
      `published schema accepted a file the parser rejects ('${label}') — external authors validating against the schema would be told a broken file is fine`,
    );
  });
}
