/**
 * Portable source contracts.
 *
 * A `.agent` carries SourceRequirement values: roles, shape, permissions, and
 * verification policy. It never carries SourceBinding values. Bindings contain
 * the private local path/provider item/credential reference selected by the
 * person running the agent and live only in the host runtime.
 */

export const SOURCE_ROLES = [
  "knowledge",
  "brain",
  "working",
  "template",
  "inbox",
  "output",
] as const;
export type SourceRole = (typeof SOURCE_ROLES)[number];

export const SOURCE_KINDS = [
  "file",
  "folder",
  "workspace",
  "klypix",
  "provider",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SOURCE_CAPABILITIES = [
  "read",
  "list",
  "search",
  "cite",
  "sync",
  "watch",
  "write",
  "append",
  "create",
  "delete",
  "version",
] as const;
export type SourceCapability = (typeof SOURCE_CAPABILITIES)[number];

export type SourceAcceptContract = {
  /** File extensions including the leading dot, e.g. [".xlsx", ".csv"]. */
  extensions?: string[];
  /** Exact or wildcard MIME types, e.g. ["application/pdf", "image/*"]. */
  mediaTypes?: string[];
  /** Adapter-specific resource types, e.g. ["google-drive-folder"]. */
  providerTypes?: string[];
};

export type SourceStructureContract = {
  /**
   * Human-readable structural facts which MUST be present. These describe
   * shape, never private values (e.g. `Sheet "Invoices": invoice_id, due_date`).
   */
  required?: string[];
  /** Useful but non-blocking structure a host may surface during setup. */
  optional?: string[];
  /** Optional JSON Schema for adapters that can inspect structured resources. */
  schema?: Record<string, unknown>;
};

export type SourceFreshnessContract = {
  /**
   * snapshot: the explicitly bound revision is sufficient
   * on-run: refresh before each run
   * watch: keep synchronized as changes arrive
   */
  mode: "snapshot" | "on-run" | "watch";
  /** Maximum acceptable age of the inspected/synchronized source. */
  maxAgeSeconds?: number;
  /** Whether stale or unverifiable freshness blocks a run. */
  onStale: "fail" | "warn";
};

export type SourceTruthContract = {
  /** How strongly this source should influence a conclusion. */
  authority: "authoritative" | "supporting" | "reference" | "example";
  /** Higher values win when `conflictPolicy` uses authority. Range: 0..100. */
  priority?: number;
  conflictPolicy:
    | "fail"
    | "ask"
    | "prefer-authority"
    | "prefer-newer";
  citations: "required" | "preferred" | "none";
};

export type SourceAccessContract = {
  /**
   * Operations the agent needs, not everything the provider account can do.
   * A host MUST prove all of them before it reports the source ready.
   */
  capabilities: SourceCapability[];
  /**
   * Portable write boundaries such as `Sheet "Summary": B2:H40` or
   * `folder: /Drafts`. They are declarative policy, never private locators.
   */
  boundaries?: string[];
};

export type SourceApprovalMode =
  | "not-required"
  | "on-bind"
  | "every-run"
  | "every-action";

export type SourceApprovalContract = {
  read?: SourceApprovalMode;
  write?: SourceApprovalMode;
  /** Delete or overwrite must either be forbidden or individually approved. */
  destructive?: "forbidden" | "every-action";
};

export type SourceSharingContract = {
  /**
   * rebind: recipients select their own equivalent source (the safe default)
   * exclude: the requirement is private to the owner
   * snapshot: a separately approved, sanitized snapshot may be packaged
   *
   * This field is policy only. Source bytes/IDs still never live here.
   */
  strategy: "rebind" | "exclude" | "snapshot";
  derivedKnowledge?: "exclude" | "approved-only" | "include";
  recipientMayOverride?: boolean;
};

/**
 * The secret-free source contract that travels in a `.agent`.
 */
export type SourceRequirement = {
  /** Portable role id referenced by prompts/evals, e.g. "invoice_workbook". */
  id: string;
  label: string;
  description?: string;
  role: SourceRole;
  kind: SourceKind;
  required: boolean;
  accepts?: SourceAcceptContract;
  structure?: SourceStructureContract;
  freshness?: SourceFreshnessContract;
  truth?: SourceTruthContract;
  access: SourceAccessContract;
  approval?: SourceApprovalContract;
  sharing?: SourceSharingContract;
};

export type SourceRevision = {
  /** Provider/local revision identifier. Runtime-private unless sanitized. */
  id?: string;
  /** How the runtime learned or computed `id`; receipts must not imply stronger proof. */
  idAttestation?: "host-computed" | "owner-client" | "source-adapter";
  etag?: string;
  modifiedAt?: string;
  contentHash?: string;
};

export type SourceBindingStatus =
  | "pending"
  | "ready"
  | "stale"
  | "revoked"
  | "error";

/**
 * RUNTIME-PRIVATE. Never serialize this value into `AgentFileV1`.
 *
 * `locator` can contain a local path, provider file id, tenant-specific URL,
 * or other private addressing material. `credentialRef` points to the host's
 * secret store; it is not itself a credential.
 */
export type SourceBinding = {
  id: string;
  sourceId: string;
  adapterId: string;
  kind: SourceKind;
  status: SourceBindingStatus;
  locator: Record<string, unknown>;
  credentialRef?: string;
  displayName?: string;
  providerType?: string;
  mediaType?: string;
  extension?: string;
  structure?: string[];
  capabilities: SourceCapability[];
  revision?: SourceRevision;
  lastSyncedAt?: string;
  metadata?: Record<string, unknown>;
};

/** Explicit name for consumers that want the privacy boundary in the type. */
export type PrivateSourceBinding = SourceBinding;

/**
 * Sanitized inspection result used by compatibility checks. A SourceBinding
 * is structurally compatible with this shape, but its private locator is
 * ignored by all validation helpers.
 */
export type SourceBindingCandidate = {
  id?: string;
  sourceId: string;
  adapterId: string;
  kind: SourceKind;
  status?: SourceBindingStatus;
  displayName?: string;
  providerType?: string;
  mediaType?: string;
  extension?: string;
  structure?: string[];
  capabilities: SourceCapability[];
  revision?: SourceRevision;
  lastSyncedAt?: string;
};

export type SourceAdapterCapabilities = {
  adapterId: string;
  kinds: SourceKind[];
  capabilities: SourceCapability[];
};

export type SourceRuntimeContext = {
  bindings: readonly SourceBindingCandidate[];
  adapters: readonly SourceAdapterCapabilities[];
  /** Deterministic clock for tests/CLI checks. Defaults to the current time. */
  now?: Date | string;
};

export type EvidenceLocation =
  | { kind: "page"; page: number }
  | { kind: "sheet"; sheet: string; range?: string }
  | { kind: "slide"; slide: number }
  | { kind: "section"; heading?: string; index?: number }
  | { kind: "path"; path: string; lineStart?: number; lineEnd?: number }
  | { kind: "record"; collection?: string; key: string }
  | { kind: "time"; startSeconds: number; endSeconds?: number }
  | { kind: "custom"; value: string };

export type EvidenceRef = {
  /** Portable SourceRequirement.id, not a provider/local binding id. */
  sourceId: string;
  /** Identifies one item inside a folder/workspace without making it portable. */
  artifact?: {
    id?: string;
    name?: string;
    relativePath?: string;
  };
  revision?: SourceRevision;
  location?: EvidenceLocation;
  title?: string;
  retrievedAt?: string;
};

export type EvidenceChunk = {
  id: string;
  content: string;
  evidence: EvidenceRef;
  mediaType?: string;
  score?: number;
  /** raw = directly extracted; derived = machine-inferred; curated = confirmed. */
  trust?: "raw" | "derived" | "curated";
  metadata?: Record<string, unknown>;
};

export const EVALUATION_CHECK_TYPES = [
  "source-ready",
  "freshness",
  "citation",
  "output-schema",
  "write-boundary",
  "invariant",
  "custom",
] as const;
export type EvaluationCheckType = (typeof EVALUATION_CHECK_TYPES)[number];

export type EvaluationCheck = {
  id: string;
  name: string;
  description?: string;
  type: EvaluationCheckType;
  phase: "bind" | "pre-run" | "post-run";
  severity: "error" | "warning";
  sourceIds?: string[];
  /** Declarative assertion/invariant. Never executable code. */
  assertion?: string;
  config?: Record<string, unknown>;
};

/**
 * Portable verify-before-deploy contract. Hosts may add private test inputs
 * outside the `.agent`; this block carries only safe, declarative checks.
 */
export type EvaluationContract = {
  version: 1;
  failurePolicy: "block" | "require-approval" | "warn";
  /** Optional aggregate threshold, 0..1. */
  minimumScore?: number;
  checks: EvaluationCheck[];
};

export type ReceiptApproval = {
  id: string;
  sourceId?: string;
  action: string;
  decision: "approved" | "rejected";
  decidedAt: string;
  decidedBy?: string;
};

export type ReceiptSourceRead = {
  sourceId: string;
  revision?: SourceRevision;
  evidence: EvidenceRef[];
  chunkCount: number;
};

export type ReceiptSourceWrite = {
  sourceId: string;
  operation: "write" | "append" | "create" | "delete";
  status: "applied" | "rejected" | "failed";
  target?: EvidenceRef;
  beforeHash?: string;
  afterHash?: string;
  diffSummary?: string;
  approvalId?: string;
};

export type ReceiptEvaluation = {
  checkId: string;
  status: "passed" | "failed" | "skipped";
  score?: number;
  message?: string;
  evidence?: EvidenceRef[];
};

/**
 * A machine-checkable citation resolved from a `[cite:<chunkId>]` marker in
 * the model's output. Every field except `chunkId` is copied from the run's
 * OWN admitted evidence and bindings — never parsed from model text — so a
 * citation cannot name a source, revision, or location the run was not
 * admitted to read. An unknown marker id fails the run instead of resolving.
 *
 * A citation validates traceability to supplied evidence. It does not, and
 * cannot, validate that the conclusion drawn from that evidence is correct.
 */
export type StructuredCitation = {
  /** Portable SourceRequirement.id this citation resolves to. */
  sourceRequirementId: string;
  /** This owner's binding that satisfied the requirement, when bound. */
  bindingId: string | null;
  /** Admitted revision identity (id/etag/contentHash) from the evidence. */
  revision: string | null;
  /** Structured location inside the source, from the admitted chunk. */
  location: EvidenceLocation | null;
  /** Human-readable location label, e.g. "page 2". */
  locationLabel: string;
  /** The admitted evidence chunk the model referenced. */
  chunkId: string;
};

/**
 * Structured proof of what a run read, changed, approved, and verified.
 */
export type RunReceipt = {
  version: 1;
  id: string;
  runId: string;
  agentId: string;
  agentVersion?: string;
  status: "succeeded" | "failed" | "cancelled" | "paused";
  startedAt: string;
  completedAt?: string;
  reads: ReceiptSourceRead[];
  writes: ReceiptSourceWrite[];
  approvals: ReceiptApproval[];
  evaluations: ReceiptEvaluation[];
  /**
   * Structured citations resolved from the output's `[cite:<chunkId>]`
   * markers against this run's admitted evidence. Present on succeeded
   * receipts of citation-bearing runs; additive — older readers ignore it.
   */
  citations?: StructuredCitation[];
  output?: {
    mediaType?: string;
    contentHash?: string;
    evidence?: EvidenceRef[];
  };
  error?: { code?: string; message: string };
  metadata?: Record<string, unknown>;
};
