// The `.agent` file format — AgentMug's portable agent definition.
//
// One JSON file captures EVERYTHING needed to run an agent on any
// deployment target: cloud, desktop (Tauri shell), Docker, MCP server,
// CLI. The file IS the agent.
//
// Versioned via `$schema` so future format changes can be migrated
// rather than breaking existing agents in the wild.
//
// Design constraints:
//   - Pure JSON. No code, no executable content. Safe to share.
//   - Never contains secrets. The artifact declares which credentials
//     the agent needs (`tools[].requiresUserAuth`), the runtime asks
//     the user to supply them. The .agent file is publishable as-is.
//   - Self-contained for execution: a runtime needs nothing besides
//     this file + the credentials it declares to run the agent.
//   - Forward-compatible. Unknown fields are preserved by readers.

import type { TriggerDefinition } from "../triggers/types";
import type { EvaluationContract, SourceRequirement } from "../sources/types";
import { validateEvaluationContract, validateSourceRequirements } from "../sources/validation";

/**
 * Schema URL is the canonical version marker. A v2 format would use
 * a different URL. Readers MUST verify the schema before parsing.
 *
 * Rebrand note: the project was renamed from AgentLit → AgentMug.
 * New exports use AGENT_FILE_SCHEMA_V1. Old `.agent` files in the
 * wild reference AGENT_FILE_SCHEMA_V1_LEGACY_AGENTLIT — parseAgentFile
 * accepts both for backwards compat so existing files keep working.
 */
export const AGENT_FILE_SCHEMA_V1 = "https://agentmug.com/schemas/agent.v1.json";

export const AGENT_FILE_SCHEMA_V1_LEGACY_AGENTLIT = "https://agentlit.dahshanlabs.com/schemas/agent.v1.json";

const ACCEPTED_SCHEMAS = new Set([AGENT_FILE_SCHEMA_V1, AGENT_FILE_SCHEMA_V1_LEGACY_AGENTLIT]);

/**
 * Rich description of a tool the agent is permitted to use. Distinct
 * from raw tool IDs so the dashboard / runtime can render a meaningful
 * "this agent needs X" UI without re-reading a central catalog.
 *
 * Four kinds today:
 *   - "builtin": the runtime knows how to execute it natively (e.g.
 *     create_reminder, fetch_url). No user credentials required.
 *   - "mcp": delegates to an MCP server. The user typically connects
 *     their own credentials (Gmail, Calendar, GitHub, etc.) so the
 *     tokens stay with the user, not the platform.
 *   - "webhook": calls an arbitrary HTTP endpoint. May or may not
 *     require user auth depending on the target.
 *   - "nango": proxied through self-hosted Nango. The agent declares
 *     the provider + endpoint + method; Nango injects the user's
 *     OAuth token at call time. Routes through the operator's configured
 *     Nango integrations — a provider works only once the operator has
 *     configured it — with no per-provider code on the runtime side.
 */
export type ToolReference = BuiltinToolReference | McpToolReference | WebhookToolReference | NangoToolReference;

export type BuiltinToolReference = {
  kind: "builtin";
  name: string;
  description?: string;
};

export type McpToolReference = {
  kind: "mcp";
  /** Tool name as exposed to the LLM (e.g. "gmail.send"). */
  name: string;
  /** npm package or URL of the MCP server. */
  server: string;
  /** OAuth/permission scopes the server will request, e.g. ["gmail.send"]. */
  scopes?: string[];
  /**
   * If true, the runtime MUST resolve user credentials before invoking
   * the tool. The dashboard and desktop runtime both honor this gate.
   */
  requiresUserAuth: boolean;
  /** Provider key the credentials should be looked up under, e.g. "google". */
  provider?: string;
  description?: string;
};

export type WebhookToolReference = {
  kind: "webhook";
  name: string;
  url: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  requiresUserAuth?: boolean;
  description?: string;
};

export type NangoToolReference = {
  kind: "nango";
  /** Tool name as exposed to the LLM (e.g. "outlook.list_messages"). */
  name: string;
  /**
   * Nango integration key — matches what the AgentMug operator
   * configured in the Nango admin UI (e.g. "microsoft-outlook",
   * "notion", "linear"). Also acts as the credential provider id
   * for `getRequiredCredentials`.
   */
  provider: string;
  /**
   * Path relative to the provider's API base URL (which Nango
   * already knows about). Example: "/me/messages" for Microsoft
   * Graph, or "/v1/pages" for Notion.
   */
  endpoint: string;
  /** Defaults to GET. */
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** OAuth scopes the agent will exercise. Surfaced in the Connect UI. */
  scopes?: string[];
  /**
   * Always true in practice — Nango is only useful for authenticated
   * APIs. Kept on the type for symmetry with MCP / webhook kinds.
   */
  requiresUserAuth: boolean;
  description?: string;
};

/**
 * Shape of what the agent produces. Lets runtimes (and human readers)
 * know upfront whether to expect plain text, structured JSON, or a
 * side-effect-only run (e.g. an agent that just writes a reminder and
 * has nothing meaningful to say).
 */
export type AgentOutputSpec = {
  /** How the response is shaped. "void" = the agent acts and stays silent. */
  shape: "text" | "json" | "void";
  /** Optional JSON Schema for `shape: "json"`. */
  schema?: Record<string, unknown>;
  /** Short, plain-language description of what the user will see. */
  description?: string;
};

/**
 * A credential the agent declares it needs to execute. Derived from
 * tool references at export time; runtimes can render a "Required
 * Credentials" UI from this list without inspecting tool internals.
 */
export type CredentialRequirement = {
  /** Stable provider id, e.g. "google", "github", "slack". */
  provider: string;
  /** Scopes the agent will use. */
  scopes: string[];
  /** Display label, e.g. "Google (Gmail send + Calendar read)". */
  label: string;
  /** Which tool(s) drove the requirement — for traceable UI. */
  forTools: string[];
};

/**
 * A user-supplied parameter the agent needs at run time.
 *
 * This solves the "REPLACE_WITH_YOUR_EMAIL hack" — instead of asking
 * the user to hand-edit the system prompt, the agent declares the
 * config it needs (target email, calendar id, project name, etc.),
 * the runtime asks the user via a form on fork, and substitutes the
 * values into the system prompt as `{{params.<name>}}` placeholders
 * before sending it to the LLM.
 *
 * Non-developers don't write code — they fill in a form. This is the
 * mechanism that makes that possible.
 */
export type AgentParameter = {
  /** Internal id used in `{{params.<name>}}` substitution. */
  name: string;
  /** Display label shown next to the input. */
  label: string;
  /** Short description shown under the input. */
  description?: string;
  /**
   * Shape of the value:
   *   - "string":  single-line text (default for most cases)
   *   - "text":    multi-line text
   *   - "number":  numeric input
   *   - "boolean": checkbox / toggle
   *   - "email":   single-line, validated as an email address
   *   - "url":     single-line, validated as a URL
   *   - "select":  drop-down — `options` array also required
   *   - "file":    a private artifact binding. The schema travels with the
   *                .agent; the owner's file and stored value never do.
   */
  type: "string" | "text" | "number" | "boolean" | "email" | "url" | "select" | "file";
  /** Options for `type: "select"`. */
  options?: Array<{ value: string; label: string }>;
  /** Optional default value if the user doesn't override. */
  default?: string | number | boolean;
  /**
   * If true, the runtime MUST have a non-empty value for this
   * parameter before running. UI disables Run until satisfied.
   */
  required: boolean;
  /** Optional placeholder text shown in the input. */
  placeholder?: string;
  /**
   * Portable, secret-free compatibility contract for `type: "file"`.
   * `structure` may contain workflow-relevant schema such as sheet/column
   * names, but never sample rows, cell values, document text, or filenames.
   */
  artifact?: {
    kind: "document" | "table" | "image";
    /** Accepted extensions/MIME patterns, e.g. [".csv", ".xlsx", "text/csv"]. */
    accepts: string[];
    /** Optional structural requirements used for a pre-run compatibility check. */
    structure?: string[];
  };
};

export type ArtifactBindingCandidate = {
  mimeType?: string;
  filename?: string;
  kind?: "document" | "table" | "image";
  structure?: string[];
};

export type ArtifactCompatibility = {
  compatible: boolean;
  missingStructure: string[];
  message: string;
};

function structuralRequirementMatches(actualValue: string, expectedValue: string): boolean {
  const actual = actualValue.trim().toLowerCase().replace(/\s+/g, " ");
  const expected = expectedValue.trim().toLowerCase().replace(/\s+/g, " ");
  if (actual === expected) return true;
  if (!expected) return false;

  let offset = 0;
  while (offset <= actual.length - expected.length) {
    const index = actual.indexOf(expected, offset);
    if (index < 0) return false;
    const before = index > 0 ? actual[index - 1] : "";
    const after = index + expected.length < actual.length ? actual[index + expected.length] : "";
    const expectedStartsWithIdentifier = /^[a-z0-9_]/.test(expected);
    const expectedEndsWithIdentifier = /[a-z0-9_]$/.test(expected);
    const leftBoundary = !expectedStartsWithIdentifier || !before || !/[a-z0-9_]/.test(before);
    const rightBoundary = !expectedEndsWithIdentifier || !after || !/[a-z0-9_]/.test(after);
    if (leftBoundary && rightBoundary) return true;
    offset = index + 1;
  }
  return false;
}

/**
 * Read-only compatibility check shared by every host UI/SDK.
 * It deliberately compares structure, not private content: a recipient can
 * prove their workbook/document has the required shape without receiving the
 * author's rows, prose, filenames, memories, or credentials.
 */
export function checkArtifactCompatibility(
  parameter: AgentParameter,
  candidate: ArtifactBindingCandidate,
): ArtifactCompatibility {
  if (parameter.type !== "file" || !parameter.artifact) {
    return {
      compatible: false,
      missingStructure: [],
      message: "This parameter is not a portable file binding.",
    };
  }
  const expected = parameter.artifact;
  if (candidate.kind && candidate.kind !== expected.kind) {
    return {
      compatible: false,
      missingStructure: [],
      message: `Expected a ${expected.kind}, received a ${candidate.kind}.`,
    };
  }

  const filename = candidate.filename?.toLowerCase() ?? "";
  const mimeType = candidate.mimeType?.toLowerCase() ?? "";
  const accepts = expected.accepts.map((value) => value.toLowerCase());
  const formatMatches =
    accepts.length === 0 ||
    accepts.some((value) => {
      if (value.startsWith(".")) return filename.endsWith(value);
      if (value.endsWith("/*")) return mimeType.startsWith(value.slice(0, -1));
      return mimeType === value;
    });
  if (!formatMatches) {
    return {
      compatible: false,
      missingStructure: [],
      message: `Use one of: ${expected.accepts.join(", ")}.`,
    };
  }

  const actualStructure = (candidate.structure ?? []).map((line) => line.trim().toLowerCase());
  const missingStructure = (expected.structure ?? []).filter((line) => {
    const expectedLine = line.trim().toLowerCase();
    return !actualStructure.some((actual) => structuralRequirementMatches(actual, expectedLine));
  });
  if (missingStructure.length > 0) {
    return {
      compatible: false,
      missingStructure,
      message: `The file is readable, but ${missingStructure.length} required structural item${missingStructure.length === 1 ? " is" : "s are"} missing.`,
    };
  }
  return {
    compatible: true,
    missingStructure: [],
    message:
      expected.structure && expected.structure.length > 0
        ? "Format and structure match this agent's portable setup contract."
        : "Format matches this agent's portable setup contract.",
  };
}

/**
 * Redacted evidence that a capability passed its originating-task proof.
 * The private task fixture and its input/output never travel in an .agent file.
 * This receipt is informational provenance, not permission to execute or trust
 * imported code without the receiving runtime's own verification policy.
 */
export type AgentSkillProofAttestation = {
  version: 1;
  receiptId: string;
  status: "passed";
  capabilityKind: string;
  harnessId: string;
  sandboxId: string;
  contractMatched: true;
  criteriaPassed: number;
  criteriaTotal: number;
  judgeId: string;
  judgeModel: string;
  verifiedAt: string;
};

/** Validate and project only the public, bounded proof receipt fields. */
export function parseAgentSkillProofAttestation(raw: unknown): AgentSkillProofAttestation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Agent skill proof attestation must be an object");
  }
  const proof = raw as Partial<AgentSkillProofAttestation>;
  const validBoundedString = (value: unknown, max: number) =>
    typeof value === "string" && value.length > 0 && value.length <= max;
  const validCounts =
    Number.isInteger(proof.criteriaPassed) &&
    Number.isInteger(proof.criteriaTotal) &&
    Number(proof.criteriaTotal) > 0 &&
    proof.criteriaPassed === proof.criteriaTotal;
  if (
    proof.version !== 1 ||
    proof.status !== "passed" ||
    proof.contractMatched !== true ||
    !validBoundedString(proof.receiptId, 128) ||
    !validBoundedString(proof.capabilityKind, 64) ||
    !validBoundedString(proof.harnessId, 128) ||
    !validBoundedString(proof.sandboxId, 128) ||
    !validCounts ||
    !validBoundedString(proof.judgeId, 128) ||
    !validBoundedString(proof.judgeModel, 128) ||
    !validBoundedString(proof.verifiedAt, 64) ||
    Number.isNaN(Date.parse(String(proof.verifiedAt)))
  ) {
    throw new Error("Agent skill proof attestation is invalid");
  }
  return {
    version: 1,
    receiptId: proof.receiptId!,
    status: "passed",
    capabilityKind: proof.capabilityKind!,
    harnessId: proof.harnessId!,
    sandboxId: proof.sandboxId!,
    contractMatched: true,
    criteriaPassed: proof.criteriaPassed!,
    criteriaTotal: proof.criteriaTotal!,
    judgeId: proof.judgeId!,
    judgeModel: proof.judgeModel!,
    verifiedAt: proof.verifiedAt!,
  };
}

/**
 * A verified skill the agent learned — a reusable capability it can replay.
 * Procedures, not private data, so skills travel with a shared/published file.
 * The full recipe is plain text (the steps/tool-calls to follow), keeping the
 * "pure JSON, no executable content" guarantee intact.
 */
export type AgentSkill = {
  /** Identifier the agent calls use_skill with. */
  name: string;
  /** When to use it, e.g. "when the user asks to chase overdue invoices". */
  trigger: string;
  /** The replayable steps. */
  recipe: string;
  /** Whether it passed verification before it was kept. */
  verified?: boolean;
  /** Optional redacted originating-task proof receipt. */
  proof?: AgentSkillProofAttestation;
  /** Optional provenance pin. The embedded recipe remains authoritative. */
  librarySkillId?: string;
  librarySkillVersion?: number;
};

/**
 * A page from the agent's accumulated knowledge ("brain"). PRIVATE — present
 * only when the OWNER does a personal export (include=brain); never in a
 * shared/published file. On import these become the importing user's pages.
 */
export type AgentBrainPage = {
  slug: string;
  title: string;
  summary?: string;
  content: string;
  links?: string[];
  sources?: string[];
};

/**
 * A "Heads up" — one adaptation the agent's designer made because the literal
 * request couldn't be honored as written (e.g. "Apple Notes → Notion"). Shown
 * to the user BEFORE they run the agent so the divergence is honest and visible.
 *
 * Display-only: never affects execution. PUBLIC (unlike brain) — it travels in
 * every export so the heads-up that renders on the web Overview also renders on
 * desktop / CLI / any runtime. Mirrors the api-server `Caveat` (requested /
 * doing / why) — the three plain-language fields the user reads; the internal
 * `unavailableTools` grounding tag is intentionally NOT carried (it's a
 * generation-time verification detail, not user-facing).
 */
export type AgentCaveat = {
  /** What the user literally asked for, in their words. */
  requested: string;
  /** What the agent does instead. */
  doing: string;
  /** The one-line reason the literal ask wasn't possible. */
  why: string;
  /** Real alternative routes the user might prefer — a choice list rendered
   *  on the Heads-up card (at most one recommended). Optional + additive so
   *  older files/readers are unaffected. */
  options?: Array<{ label: string; detail: string; recommended?: boolean }>;
};

export type AgentExecutionPlacement = {
  /** Host class selected by the Creation Truth Gate. */
  target: "cloud" | "browser" | "desktop" | "self_hosted" | "hybrid";
  /** Whether the managed cloud may execute this file directly. */
  cloudRunnable: boolean;
  /** A visible user session is required (screen sharing/device control). */
  requiresUserPresence?: boolean;
  /** Plain-language placement reason, safe to show before a run. */
  reason?: string;
};

export type AgentFileV1 = {
  /**
   * Schema URL — typed as `string` rather than `typeof
   * AGENT_FILE_SCHEMA_V1` so existing files exported under the legacy
   * AgentLit URL still typecheck. parseAgentFile() validates against
   * the accepted-schemas set at runtime.
   */
  $schema: string;
  /** Stable identifier within the source AgentMug instance. */
  id: string;
  /** Display name, e.g. "Voice Reminder Capture". */
  name: string;
  /** Short user-facing description. */
  description: string;
  /**
   * Optional single emoji used as the agent's avatar (e.g. "📧"). Travels
   * with the file so an imported/forked agent keeps its identity. Absent on
   * older files — readers fall back to deriving one from the name.
   */
  emoji?: string;
  /**
   * Semver-style version of the agent definition itself (not the
   * format). Incremented when the user edits the agent's blueprint.
   */
  version: string;
  /** ISO 8601 of when this file was generated. */
  exportedAt: string;
  /** Portable runtime placement; old files omit it and default to cloud. */
  execution?: AgentExecutionPlacement;
  blueprint: {
    /** e.g. "claude-sonnet-4-6" / "claude-opus-4-8" / "gpt-4o" / "gemini-2.0-flash".
     *  The runtime maps this prefix to the right LLM client. */
    primaryModel: string;
    /**
     * Portable model-selection policy. The host owns credentials and may use
     * another qualified cloud or local model unless the worker is explicitly
     * pinned. `primaryModel` remains the preferred legacy/default choice.
     */
    modelPolicy?: {
      mode: "host_choice" | "preferred" | "pinned";
      preferredModels?: string[];
      requiredCapabilities?: Array<
        "tool_use" | "vision" | "long_context" | "reasoning"
      >;
      minimumContextTokens?: number;
      allowLocal?: boolean;
    };
    /**
     * Optional per-agent output token cap. Omit for the runtime default
     * (8192). The engine clamps it to a sane range. Lets a long-form agent
     * request more headroom without any code change; travels with the file.
     */
    maxTokens?: number;
    /**
     * Optional Anthropic extended-thinking budget (tokens). When set, the
     * agent reasons in a visible thinking block before answering (budget caps
     * the reasoning; engine clamps it). Omit = thinking off. Ignored on
     * non-Anthropic models. Travels with the file.
     */
    extendedThinkingBudget?: number;
    /**
     * Per-agent guardrails. `sideEffectGate` opts the agent into the same-turn
     * prompt-injection backstop (off | confirm | refuse). Travels with the file
     * so the protection survives export / fork / off-cloud execution.
     */
    guardrails?: { sideEffectGate?: "off" | "confirm" | "refuse" } & Record<string, unknown>;
    /** Full system prompt verbatim. The runtime feeds this to the LLM. */
    systemPrompt: string;
    /**
     * Tools the agent is permitted to use. Accepts two shapes for
     * backwards compatibility:
     *   - legacy: `string[]` of tool IDs (resolved to builtin refs)
     *   - rich:   `ToolReference[]` with kind / scopes / provider / etc.
     *
     * Use `normalizeTools(file)` to read this without caring which
     * shape it was authored in.
     */
    tools: Array<string | ToolReference>;
    /**
     * Optional. Free-form pattern hints (e.g. "react", "chain_of_verification").
     */
    thinkingPatterns?: string[];
    /**
     * Optional. Architecture marker — "solo" / "orchestrator_workers" /
     * "pipeline" / "hierarchical". Currently only "solo" is wired end-to-end.
     */
    architecture?: string;
    /**
     * Optional. Verified skills the agent has learned — reusable capabilities
     * it replays via use_skill. Always travel with the file (procedures, not
     * private data); the cheap skill index also lives inside systemPrompt.
     */
    skills?: AgentSkill[];
    /**
     * Optional. The builder's "Heads up" adaptations — why this agent diverges
     * from the literal request. Blueprint-versioned (they change when the design
     * changes) and PUBLIC, so they travel with every export and render the same
     * heads-up on web Overview, desktop, and CLI. Empty/absent = honored exactly.
     */
    caveats?: AgentCaveat[];
    /** Secret-free outcome and creation evidence, portable across hosts. */
    outcomeContract?: Record<string, unknown>;
    capabilityPlan?: Record<string, unknown>;
  };
  /**
   * Optional user-supplied parameters. The runtime renders a form for
   * these on fork and substitutes their values into the system prompt
   * (and tool args, future work) as `{{params.<name>}}` at run time.
   *
   * Lets agents be self-configuring without code edits — the killer
   * UX gap that turns a developer-shaped runtime into a non-developer
   * product.
   */
  parameters?: AgentParameter[];
  /**
   * What inputs this agent accepts. Drives the runtime's UI: a desktop
   * shell with only "text" shows a text box; with "audio" added it
   * also offers a mic button.
   */
  inputs: {
    accepts: Array<"text" | "audio" | "image">;
    placeholder?: string;
    /** Optional JSON Schema for structured-text inputs. */
    schema?: Record<string, unknown>;
  };
  /**
   * Declared output contract. Optional for backwards compatibility,
   * but new exports always include it — the dashboard shows it as
   * "Expected output" before the user runs the agent so they know
   * what they're getting.
   */
  outputs?: AgentOutputSpec;
  /**
   * Triggers the agent supports on the target runtime. Phase 2 only
   * runs "manual"; others are declared so the runtime can fail loud
   * if it can't honor them.
   */
  triggers?: TriggerDefinition[];
  /**
   * Phase C — the CONNECTIVITY CONTRACT: what this agent needs from the world
   * to actually WORK (beyond tool credentials): whose identity it messages,
   * what sources it reads, and how it delivers. Requirements and role
   * REFERENCES only — never secrets, never literal phone numbers/addresses
   * (identities resolve at runtime against the importing user's own connected
   * accounts, the identity-grounding seam). A runtime that can't satisfy an
   * entry fails LOUD at check/run time, never silently.
   */
  connectivity?: ConnectivityContract;
  /**
   * Portable, secret-free artifact/source requirements. These declare what
   * evidence or working surfaces the agent needs and what it may do with them.
   * Private SourceBinding values live in the host runtime and MUST NOT appear
   * here. Optional so every pre-source-contract `.agent` remains valid.
   */
  sources?: SourceRequirement[];
  /**
   * Declarative verify-before-deploy checks. Private eval fixtures stay in the
   * host; only safe invariants and required checks travel with the agent.
   */
  evaluation?: EvaluationContract;
  /**
   * Free-form provenance metadata. Not consumed by the runtime; useful
   * for marketplace / debugging / attribution.
   */
  metadata?: {
    sourceUrl?: string;
    sourceUserId?: string;
    tags?: string[];
    pricing?: { kind: "free" } | { kind: "one-time"; amountUsd: number };
  };
  /**
   * Optional. The agent's accumulated knowledge ("brain") — structured pages
   * about the owner's world. PRIVATE: included only when the OWNER does a
   * personal export (include=brain), never in a shared/published file. On
   * import these become the importing user's own pages on the new agent.
   */
  brain?: AgentBrainPage[];
  /**
   * Optional. The agent's learned flat facts ("memory") — key/value pairs
   * about the owner. PRIVATE, same rule as brain: rides ONLY the personal
   * export (the owner's explicit choice), never a shared/published file —
   * so sharing publicly can't leak memories by construction. On import the
   * facts become the importing user's own memory on the new agent.
   */
  memory?: Array<{ key: string; value: string; importance?: number }>;
};

/**
 * Phase C connectivity contract. Each entry is a requirement + reference,
 * never a value: `to: "owner"` means "whoever runs this file" and resolves
 * per-runtime; `via` names the delivery tool whose provider must be
 * connected. Unknown channels/fields are preserved (forward-compatible).
 */
export type ConnectivityContract = {
  /** Identity roles the agent messages/reads as. `channel` is the transport
   *  ("whatsapp" | "sms" | "email" | …); `role: "owner"` = the running user. */
  identities?: Array<{ role: "owner"; channel: string }>;
  /** Sources the agent reads (provider + resource, e.g. gmail/inbox). */
  reads?: Array<{ provider: string; resource: string }>;
  /** How the agent delivers: channel + who + the tool that does it. */
  delivers?: Array<{ channel: string; to: "owner"; via: string }>;
};

/**
 * Input to {@link buildAgentFile} — everything in an AgentFileV1 except the
 * two fields the builder stamps for you: `$schema` (defaults to the current
 * v1 URL) and `exportedAt` (defaults to now; pass it explicitly for
 * deterministic output, e.g. tests or content-addressed exports).
 */
export type BuildAgentFileInput = Omit<AgentFileV1, "$schema" | "exportedAt"> & {
  $schema?: string;
  exportedAt?: string;
};

/**
 * Canonical `.agent` WRITER — the missing half of the format. Until now the
 * runtime could `parseAgentFile()` (read) but every producer hand-assembled
 * the AgentFileV1 literal (the cloud had two such sites that had already
 * drifted). `buildAgentFile()` is the single source of truth: it stamps the
 * schema + timestamp, drops `undefined` optionals so the JSON stays clean,
 * and VALIDATES the result by round-tripping through `parseAgentFile` — so it
 * can only ever emit a file the runtime can read back. This is what lets a
 * portable consumer (CLI/desktop) WRITE agents: a Manager's `create_agent`,
 * `save_skill` persisting a learned skill, fork/export, etc.
 */
/**
 * The accepted-input contract for an agent, derived from the run model's REAL
 * capability — the single source of truth so every surface (cloud /spec + .agent
 * export, desktop, CLI, and the portable Manager's create_agent / import) agrees
 * on what an agent will take, and the chips never disagree with the affordances.
 * Text + audio are always offered (audio via the runtime's transcription); image
 * is added only when the model can actually see it.
 */
export function acceptedInputsFor(primaryModel: string): Array<"text" | "audio" | "image"> {
  const accepts: Array<"text" | "audio" | "image"> = ["text", "audio"];
  if (modelIsVisionCapable(primaryModel)) accepts.push("image");
  return accepts;
}

/** Whether a model can ingest images. All current Claude (3.x/4.x), GPT-4o/4.1/
 *  4-turbo, and Gemini 1.5/2.x are vision-capable; unknown / text-only / small
 *  local models are not — don't claim vision we can't deliver. */
export function modelIsVisionCapable(model: string): boolean {
  const m = (model ?? "").toLowerCase();
  if (/claude/.test(m)) return true;
  if (/gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-4-vision/.test(m)) return true;
  if (/gemini/.test(m)) return true;
  return false;
}

export function buildAgentFile(input: BuildAgentFileInput): AgentFileV1 {
  const bp = input.blueprint;
  const file: AgentFileV1 = {
    $schema: input.$schema ?? AGENT_FILE_SCHEMA_V1,
    id: input.id,
    name: input.name,
    description: input.description,
    ...(input.emoji !== undefined ? { emoji: input.emoji } : {}),
    version: input.version,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    ...(input.execution ? { execution: input.execution } : {}),
    blueprint: {
      primaryModel: bp.primaryModel,
      ...(bp.modelPolicy ? { modelPolicy: bp.modelPolicy } : {}),
      systemPrompt: bp.systemPrompt,
      tools: bp.tools,
      ...(bp.maxTokens !== undefined ? { maxTokens: bp.maxTokens } : {}),
      ...(bp.extendedThinkingBudget !== undefined ? { extendedThinkingBudget: bp.extendedThinkingBudget } : {}),
      ...(bp.thinkingPatterns ? { thinkingPatterns: bp.thinkingPatterns } : {}),
      ...(bp.architecture ? { architecture: bp.architecture } : {}),
      ...(bp.skills ? { skills: bp.skills } : {}),
      ...(bp.caveats ? { caveats: bp.caveats } : {}),
      ...(bp.outcomeContract ? { outcomeContract: bp.outcomeContract } : {}),
      ...(bp.capabilityPlan ? { capabilityPlan: bp.capabilityPlan } : {}),
      ...(bp.guardrails ? { guardrails: bp.guardrails } : {}),
    },
    ...(input.parameters ? { parameters: input.parameters } : {}),
    inputs: input.inputs,
    ...(input.outputs ? { outputs: input.outputs } : {}),
    ...(input.triggers ? { triggers: input.triggers } : {}),
    ...(input.connectivity ? { connectivity: input.connectivity } : {}),
    ...(input.sources ? { sources: input.sources } : {}),
    ...(input.evaluation ? { evaluation: input.evaluation } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(input.brain ? { brain: input.brain } : {}),
    ...(input.memory ? { memory: input.memory } : {}),
  };
  // Fail loud if we somehow assembled something the parser rejects — the
  // whole point is that write→read always round-trips.
  return parseAgentFile(file);
}

/**
 * Serialize an AgentFileV1 to the canonical on-disk JSON string (2-space
 * indent + trailing newline). Pair with {@link buildAgentFile}:
 * `serializeAgentFile(buildAgentFile(input))`.
 */
export function serializeAgentFile(file: AgentFileV1): string {
  return JSON.stringify(file, null, 2) + "\n";
}

/**
 * Type guard for validating an unknown JSON value as a v1 agent file.
 * Returns the value typed as AgentFileV1 on success, or throws with a
 * specific reason on failure. Used by every runtime that loads agents.
 */
export function parseAgentFile(value: unknown): AgentFileV1 {
  if (typeof value !== "object" || value === null) {
    throw new Error("Agent file must be a JSON object");
  }
  const v = value as Partial<AgentFileV1>;
  if (typeof v.$schema !== "string" || !ACCEPTED_SCHEMAS.has(v.$schema)) {
    throw new Error(`Unsupported $schema: ${String(v.$schema)} (expected ${AGENT_FILE_SCHEMA_V1})`);
  }
  for (const key of ["id", "name", "description", "version", "exportedAt"] as const) {
    if (typeof v[key] !== "string" || !(v[key] as string).length) {
      throw new Error(`Agent file missing required field: ${key}`);
    }
  }
  // Optional avatar emoji — if present it must be a string. Lenient on
  // content (any emoji shape) so the field never blocks an otherwise-valid
  // import; the dashboard derives a fallback when it's absent.
  if (v.emoji !== undefined && typeof v.emoji !== "string") {
    throw new Error("Agent file emoji must be a string");
  }
  if (v.execution !== undefined) {
    const execution = v.execution as Partial<AgentExecutionPlacement>;
    const targets = ["cloud", "browser", "desktop", "self_hosted", "hybrid"];
    if (!targets.includes(String(execution.target))) {
      throw new Error("Agent file execution.target is invalid");
    }
    if (typeof execution.cloudRunnable !== "boolean") {
      throw new Error("Agent file execution.cloudRunnable must be boolean");
    }
    if (execution.requiresUserPresence !== undefined && typeof execution.requiresUserPresence !== "boolean") {
      throw new Error("Agent file execution.requiresUserPresence must be boolean");
    }
    if (execution.reason !== undefined && typeof execution.reason !== "string") {
      throw new Error("Agent file execution.reason must be a string");
    }
  }
  if (!v.blueprint || typeof v.blueprint !== "object") {
    throw new Error("Agent file missing blueprint");
  }
  if (
    typeof v.blueprint.primaryModel !== "string" ||
    typeof v.blueprint.systemPrompt !== "string" ||
    !Array.isArray(v.blueprint.tools)
  ) {
    throw new Error("Agent file blueprint missing primaryModel / systemPrompt / tools");
  }
  if (v.blueprint.modelPolicy !== undefined) {
    const policy = v.blueprint.modelPolicy;
    if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
      throw new Error("Agent file blueprint.modelPolicy must be an object");
    }
    if (!["host_choice", "preferred", "pinned"].includes(String(policy.mode))) {
      throw new Error("Agent file blueprint.modelPolicy.mode is invalid");
    }
    if (
      policy.preferredModels !== undefined &&
      (!Array.isArray(policy.preferredModels) ||
        policy.preferredModels.some((model) => typeof model !== "string" || !model.trim()))
    ) {
      throw new Error("Agent file blueprint.modelPolicy.preferredModels is invalid");
    }
    const allowedCapabilities = new Set(["tool_use", "vision", "long_context", "reasoning"]);
    if (
      policy.requiredCapabilities !== undefined &&
      (!Array.isArray(policy.requiredCapabilities) ||
        policy.requiredCapabilities.some((capability) => !allowedCapabilities.has(String(capability))))
    ) {
      throw new Error("Agent file blueprint.modelPolicy.requiredCapabilities is invalid");
    }
    if (
      policy.minimumContextTokens !== undefined &&
      (!Number.isInteger(policy.minimumContextTokens) || policy.minimumContextTokens < 1)
    ) {
      throw new Error("Agent file blueprint.modelPolicy.minimumContextTokens is invalid");
    }
    if (policy.allowLocal !== undefined && typeof policy.allowLocal !== "boolean") {
      throw new Error("Agent file blueprint.modelPolicy.allowLocal must be boolean");
    }
  }
  for (const key of ["outcomeContract", "capabilityPlan"] as const) {
    const portable = v.blueprint[key];
    if (portable !== undefined && (!portable || typeof portable !== "object" || Array.isArray(portable))) {
      throw new Error(`Agent file blueprint.${key} must be an object`);
    }
  }
  // Validate tools entries are either non-empty strings or valid refs.
  for (const t of v.blueprint.tools) {
    if (typeof t === "string") {
      if (!t.length) throw new Error("Agent file has empty tool id");
      continue;
    }
    if (typeof t !== "object" || t === null) {
      throw new Error("Agent file tool entry must be string or object");
    }
    const ref = t as Partial<ToolReference>;
    if (ref.kind !== "builtin" && ref.kind !== "mcp" && ref.kind !== "webhook" && ref.kind !== "nango") {
      throw new Error(`Agent file tool has unknown kind: ${String(ref.kind)}`);
    }
    if (typeof ref.name !== "string" || !ref.name.length) {
      throw new Error("Agent file tool missing name");
    }
    if (ref.kind === "nango") {
      const nango = ref as Partial<NangoToolReference>;
      if (typeof nango.provider !== "string" || !nango.provider.length) {
        throw new Error("Nango tool missing provider");
      }
      if (typeof nango.endpoint !== "string" || !nango.endpoint.length) {
        throw new Error("Nango tool missing endpoint");
      }
    }
  }
  if (!v.inputs || !Array.isArray(v.inputs.accepts) || v.inputs.accepts.length === 0) {
    throw new Error("Agent file inputs.accepts must be a non-empty array");
  }
  for (const inp of v.inputs.accepts) {
    if (inp !== "text" && inp !== "audio" && inp !== "image") {
      throw new Error(`Agent file has unknown input type: ${String(inp)}`);
    }
  }
  if (v.outputs !== undefined) {
    if (typeof v.outputs !== "object" || v.outputs === null) {
      throw new Error("Agent file outputs must be an object");
    }
    if (v.outputs.shape !== "text" && v.outputs.shape !== "json" && v.outputs.shape !== "void") {
      throw new Error(`Agent file outputs.shape unknown: ${String(v.outputs.shape)}`);
    }
  }
  if (v.parameters !== undefined) {
    if (!Array.isArray(v.parameters)) {
      throw new Error("Agent file parameters must be an array");
    }
    const seen = new Set<string>();
    for (const p of v.parameters) {
      if (typeof p !== "object" || p === null) {
        throw new Error("Agent file parameter must be an object");
      }
      const pp = p as Partial<AgentParameter>;
      if (typeof pp.name !== "string" || !pp.name.length) {
        throw new Error("Agent file parameter missing name");
      }
      if (!/^[a-z][a-z0-9_]*$/i.test(pp.name)) {
        throw new Error(`Agent file parameter name '${pp.name}' must be snake_case and start with a letter`);
      }
      if (seen.has(pp.name)) {
        throw new Error(`Agent file parameter '${pp.name}' declared twice`);
      }
      seen.add(pp.name);
      if (typeof pp.label !== "string" || !pp.label.length) {
        throw new Error(`Agent file parameter '${pp.name}' missing label`);
      }
      const VALID_TYPES = ["string", "text", "number", "boolean", "email", "url", "select", "file"] as const;
      if (!VALID_TYPES.includes(pp.type as (typeof VALID_TYPES)[number])) {
        throw new Error(`Agent file parameter '${pp.name}' has invalid type: ${String(pp.type)}`);
      }
      if (typeof pp.required !== "boolean") {
        throw new Error(`Agent file parameter '${pp.name}' missing required:boolean`);
      }
      if (pp.type === "select" && (!Array.isArray(pp.options) || pp.options.length === 0)) {
        throw new Error(`Agent file parameter '${pp.name}' is type=select but options[] is missing or empty`);
      }
      if (pp.type === "file") {
        if (!pp.artifact || typeof pp.artifact !== "object") {
          throw new Error(`Agent file parameter '${pp.name}' is type=file but artifact metadata is missing`);
        }
        if (pp.artifact.kind !== "document" && pp.artifact.kind !== "table" && pp.artifact.kind !== "image") {
          throw new Error(`Agent file parameter '${pp.name}' has an invalid artifact kind`);
        }
        if (
          !Array.isArray(pp.artifact.accepts) ||
          pp.artifact.accepts.length === 0 ||
          pp.artifact.accepts.some((value) => typeof value !== "string" || !value.trim())
        ) {
          throw new Error(`Agent file parameter '${pp.name}' must declare artifact.accepts[]`);
        }
        if (
          pp.artifact.structure !== undefined &&
          (!Array.isArray(pp.artifact.structure) || pp.artifact.structure.some((value) => typeof value !== "string"))
        ) {
          throw new Error(`Agent file parameter '${pp.name}' artifact.structure must be a string array`);
        }
        if (pp.default !== undefined) {
          throw new Error(`Agent file parameter '${pp.name}' type=file cannot carry a default file binding`);
        }
      }
    }
  }
  // Optional verified skills — validate shape if present (lenient otherwise).
  if (v.blueprint.skills !== undefined) {
    if (!Array.isArray(v.blueprint.skills)) {
      throw new Error("Agent file blueprint.skills must be an array");
    }
    for (const s of v.blueprint.skills) {
      const ss = s as Partial<AgentSkill>;
      if (typeof ss?.name !== "string" || !ss.name.length) {
        throw new Error("Agent file skill missing name");
      }
      if (typeof ss.trigger !== "string" || typeof ss.recipe !== "string") {
        throw new Error(`Agent file skill '${ss.name}' missing trigger/recipe`);
      }
      const hasLibraryId = ss.librarySkillId !== undefined;
      const hasLibraryVersion = ss.librarySkillVersion !== undefined;
      if (hasLibraryId !== hasLibraryVersion) {
        throw new Error(`Agent file skill '${ss.name}' needs both librarySkillId and librarySkillVersion`);
      }
      if (
        hasLibraryId &&
        (typeof ss.librarySkillId !== "string" ||
          !ss.librarySkillId.length ||
          !Number.isInteger(ss.librarySkillVersion) ||
          Number(ss.librarySkillVersion) < 1)
      ) {
        throw new Error(`Agent file skill '${ss.name}' has an invalid library version pin`);
      }
      if (ss.proof !== undefined) {
        try {
          parseAgentSkillProofAttestation(ss.proof);
        } catch {
          throw new Error(`Agent file skill '${ss.name}' has an invalid proof attestation`);
        }
      }
    }
  }
  // Optional caveats — validate shape if present (lenient: drop nothing here,
  // just ensure the array + each entry's three string fields are well-formed so
  // a renderer can trust them).
  if (v.blueprint.caveats !== undefined) {
    if (!Array.isArray(v.blueprint.caveats)) {
      throw new Error("Agent file blueprint.caveats must be an array");
    }
    for (const c of v.blueprint.caveats) {
      const cc = c as Partial<AgentCaveat>;
      if (typeof cc?.requested !== "string" || typeof cc.doing !== "string" || typeof cc.why !== "string") {
        throw new Error("Agent file caveat must have string requested / doing / why");
      }
    }
  }
  // Optional triggers — lenient: validate KNOWN shapes, tolerate unknown
  // trigger types (per the format contract they fail loud at EXECUTION on a
  // host that can't honor them, not at parse — an old runtime must still
  // load a newer file).
  if (v.triggers !== undefined) {
    if (!Array.isArray(v.triggers)) {
      throw new Error("Agent file triggers must be an array");
    }
    for (const t of v.triggers) {
      const tt = t as Partial<TriggerDefinition> & { type?: unknown };
      if (typeof tt?.type !== "string" || !tt.type.length) {
        throw new Error("Agent file trigger missing type");
      }
      if (tt.type === "schedule" && typeof (tt as { cron?: unknown }).cron !== "string") {
        throw new Error("Agent file schedule trigger missing cron");
      }
      if (tt.type === "webhook" && typeof (tt as { path?: unknown }).path !== "string") {
        throw new Error("Agent file webhook trigger missing path");
      }
    }
  }
  // Optional connectivity contract — lenient: each entry needs its reference
  // fields; unknown extra fields/channels pass through (forward-compatible).
  if (v.connectivity !== undefined) {
    const c = v.connectivity as Partial<ConnectivityContract>;
    if (typeof c !== "object" || c === null || Array.isArray(c)) {
      throw new Error("Agent file connectivity must be an object");
    }
    for (const d of c.delivers ?? []) {
      if (typeof d?.channel !== "string" || typeof d?.via !== "string") {
        throw new Error("Agent file connectivity.delivers entry needs channel + via");
      }
    }
    for (const r of c.reads ?? []) {
      if (typeof r?.provider !== "string" || typeof r?.resource !== "string") {
        throw new Error("Agent file connectivity.reads entry needs provider + resource");
      }
    }
    for (const i of c.identities ?? []) {
      if (typeof i?.channel !== "string") {
        throw new Error("Agent file connectivity.identities entry needs channel");
      }
    }
  }
  // Portable sources/evals are optional so legacy files still parse. When
  // present, malformed permissions or requirements fail before execution.
  if (v.sources !== undefined) {
    const sourceIssues = validateSourceRequirements(v.sources);
    if (sourceIssues.length > 0) {
      throw new Error(`Agent file sources invalid: ${sourceIssues[0].message}`);
    }
  }
  if (v.evaluation !== undefined) {
    const evaluationIssues = validateEvaluationContract(
      v.evaluation,
      (v.sources ?? []).map((source) => source.id),
    );
    if (evaluationIssues.length > 0) {
      throw new Error(evaluationIssues[0]);
    }
  }
  // Optional memory facts (personal exports only) — validate shape if present.
  if (v.memory !== undefined) {
    if (!Array.isArray(v.memory)) {
      throw new Error("Agent file memory must be an array");
    }
    for (const m of v.memory) {
      const mm = m as Partial<{ key: string; value: string }>;
      if (typeof mm?.key !== "string" || !mm.key.length) {
        throw new Error("Agent file memory fact missing key");
      }
      if (typeof mm.value !== "string") {
        throw new Error(`Agent file memory fact '${mm.key}' missing value`);
      }
    }
  }
  // Optional brain pages (personal exports only) — validate shape if present.
  if (v.brain !== undefined) {
    if (!Array.isArray(v.brain)) {
      throw new Error("Agent file brain must be an array");
    }
    for (const p of v.brain) {
      const pp = p as Partial<AgentBrainPage>;
      if (typeof pp?.title !== "string" || !pp.title.length) {
        throw new Error("Agent file brain page missing title");
      }
      if (typeof pp.content !== "string") {
        throw new Error(`Agent file brain page '${pp.title}' missing content`);
      }
    }
  }
  return v as AgentFileV1;
}

/**
 * Substitute {{params.<name>}} placeholders in a template string with
 * values from the supplied parameter map. Used by the engine on the
 * system prompt before each run, but also useful for other surfaces
 * (e.g. previewing the resolved prompt in the dashboard).
 *
 * Unknown placeholders are left as-is so the LLM can see them and
 * surface the gap (instead of silently dropping them, which would
 * produce a wrong but plausible-looking output).
 */
export function substituteParameters(
  template: string,
  values: Record<string, string | number | boolean | undefined>,
): string {
  return template.replace(/\{\{\s*params\.([a-z][a-z0-9_]*)\s*\}\}/gi, (match, name: string) => {
    const v = values[name];
    if (v === undefined || v === null) return match;
    return String(v);
  });
}

/**
 * Detect which parameter placeholders a template string references.
 * Used at save time to warn authors if they introduce a `{{params.X}}`
 * without declaring X in the parameters[] list.
 */
export function extractReferencedParameters(template: string): string[] {
  const out = new Set<string>();
  const re = /\{\{\s*params\.([a-z][a-z0-9_]*)\s*\}\}/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(template)) !== null) {
    out.add(match[1]);
  }
  return Array.from(out);
}

/**
 * Normalize the legacy `tools: string[]` shape and the rich
 * `tools: ToolReference[]` shape into a single homogeneous list of
 * ToolReferences. Bare strings become `{ kind: "builtin", name }`.
 */
export function normalizeTools(file: AgentFileV1): ToolReference[] {
  return file.blueprint.tools.map((t) => (typeof t === "string" ? { kind: "builtin", name: t } : t));
}

/**
 * Derive the credential requirements the agent has, by walking its
 * tool references. Two MCP tools that need the same provider are
 * merged into one requirement with the union of their scopes.
 */
export function getRequiredCredentials(file: AgentFileV1): CredentialRequirement[] {
  const byProvider = new Map<string, CredentialRequirement>();
  for (const tool of normalizeTools(file)) {
    let provider: string | undefined;
    let scopes: string[] = [];
    if (tool.kind === "mcp" && tool.requiresUserAuth) {
      provider = tool.provider ?? tool.server;
      scopes = tool.scopes ?? [];
    } else if (tool.kind === "nango" && tool.requiresUserAuth) {
      provider = tool.provider;
      scopes = tool.scopes ?? [];
    } else {
      continue;
    }
    if (!provider) continue;
    const existing = byProvider.get(provider);
    if (existing) {
      for (const s of scopes) {
        if (!existing.scopes.includes(s)) existing.scopes.push(s);
      }
      if (!existing.forTools.includes(tool.name)) {
        existing.forTools.push(tool.name);
      }
    } else {
      byProvider.set(provider, {
        provider,
        scopes: [...scopes],
        label: humanProviderLabel(provider, scopes),
        forTools: [tool.name],
      });
    }
  }
  // Phase C: the connectivity contract's delivery channels also imply
  // credentials (e.g. delivers via twilio.send_whatsapp → a Twilio
  // connection), even when the tool list alone wouldn't surface them.
  // Key-provider prefixes only — email.send is zero-setup by design.
  const CHANNEL_PROVIDERS: Record<string, string> = {
    twilio: "twilio",
    telegram: "telegram",
    discord: "discord",
    slack: "slack",
  };
  for (const d of file.connectivity?.delivers ?? []) {
    const prefix = d.via.split(".")[0] ?? "";
    const provider = CHANNEL_PROVIDERS[prefix];
    if (!provider) continue;
    const existing = byProvider.get(provider);
    if (existing) {
      if (!existing.forTools.includes(d.via)) existing.forTools.push(d.via);
    } else {
      byProvider.set(provider, {
        provider,
        scopes: [],
        label: humanProviderLabel(provider, []),
        forTools: [d.via],
      });
    }
  }
  return Array.from(byProvider.values());
}

/**
 * Phase C — derive the connectivity contract MECHANICALLY from the toolset
 * (the authoritative source; an LLM pass may only ADD suggestions later,
 * flagged as such). Deterministic map of delivery/read tools → contract
 * entries; unknown tools contribute nothing. Returns undefined when the
 * toolset implies no connectivity (so exports omit the block entirely).
 */
export function deriveConnectivityFromTools(toolNames: string[]): ConnectivityContract | undefined {
  const delivers: NonNullable<ConnectivityContract["delivers"]> = [];
  const reads: NonNullable<ConnectivityContract["reads"]> = [];
  // Keys are the REAL tool ids as stored in blueprints — Nango-proxied tools
  // carry their raw "nango:<provider>:<op>" id (a wrong key here makes the
  // "truth file" silently under-report, the exact lie Phase C exists to kill).
  const DELIVERY: Record<string, string> = {
    "twilio.send_whatsapp": "whatsapp",
    "twilio.send_sms": "sms",
    "email.send": "email",
    "gmail.send": "email",
    "nango:outlook:send_mail": "email",
    "telegram.send_message": "telegram",
    "discord.send_message": "discord",
    "slack.send_message": "slack",
  };
  const READS: Record<string, { provider: string; resource: string }> = {
    "gmail.list_messages": { provider: "google", resource: "gmail-inbox" },
    "nango:outlook:list_messages": {
      provider: "microsoft-outlook",
      resource: "outlook-inbox",
    },
  };
  for (const name of toolNames) {
    const channel = DELIVERY[name];
    if (channel && !delivers.some((d) => d.via === name)) {
      delivers.push({ channel, to: "owner", via: name });
    }
    const read = READS[name];
    if (read && !reads.some((r) => r.resource === read.resource)) {
      reads.push({ ...read });
    }
  }
  if (delivers.length === 0 && reads.length === 0) return undefined;
  const identities = delivers.some((d) => d.channel === "whatsapp" || d.channel === "sms")
    ? [{ role: "owner" as const, channel: "phone" }]
    : undefined;
  return {
    ...(identities ? { identities } : {}),
    ...(reads.length ? { reads } : {}),
    ...(delivers.length ? { delivers } : {}),
  };
}

function humanProviderLabel(provider: string, scopes: string[]): string {
  const map: Record<string, string> = {
    google: "Google",
    github: "GitHub",
    slack: "Slack",
    notion: "Notion",
    linear: "Linear",
    "microsoft-outlook": "Microsoft Outlook",
    "microsoft-graph": "Microsoft 365",
    twitter: "Twitter / X",
    asana: "Asana",
    hubspot: "HubSpot",
    twilio: "Twilio",
    telegram: "Telegram",
  };
  const base = map[provider] ?? provider;
  if (scopes.length === 0) return base;
  return `${base} (${scopes.join(", ")})`;
}

/**
 * Build a sane default filename for a downloaded agent. Slugified name +
 * short id suffix to avoid collisions.
 */
export function suggestedFilename(agent: AgentFileV1): string {
  const slug = agent.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const idSuffix = agent.id.slice(0, 8);
  return `${slug || "agent"}-${idSuffix}.agent`;
}
