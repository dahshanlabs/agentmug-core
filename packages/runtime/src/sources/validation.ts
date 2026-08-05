import type {
  EvaluationContract,
  SourceAdapterCapabilities,
  SourceBindingCandidate,
  SourceCapability,
  SourceRequirement,
  SourceRuntimeContext,
} from "./types";
import {
  EVALUATION_CHECK_TYPES,
  SOURCE_CAPABILITIES,
  SOURCE_KINDS,
  SOURCE_ROLES,
} from "./types";

export type SourceContractIssueCode =
  | "invalid_contract"
  | "private_binding_in_contract"
  | "duplicate_source_id"
  | "missing_binding"
  | "duplicate_binding"
  | "binding_source_mismatch"
  | "binding_not_ready"
  | "kind_mismatch"
  | "type_mismatch"
  | "structure_missing"
  | "capability_missing"
  | "adapter_unavailable"
  | "adapter_kind_unsupported"
  | "adapter_capability_missing"
  | "freshness_unknown"
  | "source_stale";

export type SourceContractIssue = {
  code: SourceContractIssueCode;
  severity: "error" | "warning";
  message: string;
  sourceId?: string;
  capability?: SourceCapability;
};

export type SourceCompatibility = {
  compatible: boolean;
  issues: SourceContractIssue[];
  missingCapabilities: SourceCapability[];
  missingStructure: string[];
};

export type SourceReadinessItem = {
  requirement: SourceRequirement;
  binding?: SourceBindingCandidate;
  compatible: boolean;
  issues: SourceContractIssue[];
};

export type SourceReadinessReport = {
  ready: boolean;
  sources: SourceReadinessItem[];
  issues: SourceContractIssue[];
};

type SourceContractCarrier = { sources?: SourceRequirement[] };

function normalizeStructurePart(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Structure contracts are human-readable, but matching still needs field
 * boundaries. A candidate may safely expose extra comma-separated fields,
 * while similarly named fields (for example `discount_amount`) must never
 * satisfy a requirement for `amount`.
 */
function structureLineMatches(required: string, actual: string): boolean {
  const expected = normalizeStructurePart(required);
  const candidate = normalizeStructurePart(actual);
  if (!expected || !candidate) return false;

  const expectedColon = expected.indexOf(":");
  const candidateColon = candidate.indexOf(":");
  if (expectedColon < 0 || candidateColon < 0) {
    return expectedColon === candidateColon && expected === candidate;
  }

  const expectedQualifier = normalizeStructurePart(
    expected.slice(0, expectedColon),
  );
  const candidateQualifier = normalizeStructurePart(
    candidate.slice(0, candidateColon),
  );
  if (!expectedQualifier || expectedQualifier !== candidateQualifier) {
    return false;
  }

  const expectedItems = expected
    .slice(expectedColon + 1)
    .split(",")
    .map(normalizeStructurePart)
    .filter(Boolean);
  const candidateItems = new Set(
    candidate
      .slice(candidateColon + 1)
      .split(",")
      .map(normalizeStructurePart)
      .filter(Boolean),
  );
  return (
    expectedItems.length > 0 &&
    expectedItems.every((item) => candidateItems.has(item))
  );
}

const SOURCE_REQUIREMENT_FIELDS = new Set([
  "id",
  "label",
  "description",
  "role",
  "kind",
  "required",
  "accepts",
  "structure",
  "freshness",
  "truth",
  "access",
  "approval",
  "sharing",
]);

const PRIVATE_REQUIREMENT_FIELDS = new Set([
  "binding",
  "bindings",
  "bindingId",
  "sourceBinding",
  "sourceBindings",
  "sourceId",
  "adapterId",
  "status",
  "locator",
  "credentialRef",
  "displayName",
  "providerType",
  "mediaType",
  "extension",
  "capabilities",
  "revision",
  "lastSyncedAt",
  "metadata",
  "fileId",
  "folderId",
  "path",
  "url",
  "uri",
]);

const ACCEPTS_FIELDS = new Set(["extensions", "mediaTypes", "providerTypes"]);
const STRUCTURE_FIELDS = new Set(["required", "optional", "schema"]);
const FRESHNESS_FIELDS = new Set(["mode", "maxAgeSeconds", "onStale"]);
const TRUTH_FIELDS = new Set([
  "authority",
  "priority",
  "conflictPolicy",
  "citations",
]);
const ACCESS_FIELDS = new Set(["capabilities", "boundaries"]);
const APPROVAL_FIELDS = new Set(["read", "write", "destructive"]);
const SHARING_FIELDS = new Set([
  "strategy",
  "derivedKnowledge",
  "recipientMayOverride",
]);

const WRITE_CAPABILITIES = new Set<SourceCapability>([
  "write",
  "append",
  "create",
  "delete",
]);

const APPROVAL_MODES = new Set([
  "not-required",
  "on-bind",
  "every-run",
  "every-action",
]);

function issue(
  message: string,
  sourceId?: string,
  code: SourceContractIssueCode = "invalid_contract",
  severity: "error" | "warning" = "error",
): SourceContractIssue {
  return {
    code,
    severity,
    message,
    ...(sourceId ? { sourceId } : {}),
  };
}

function rejectUnknownRequirementFields(
  issues: SourceContractIssue[],
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  sourceId: string | undefined,
  section?: string,
): void {
  for (const field of Object.keys(value)) {
    if (allowed.has(field)) continue;
    const path = section ? `${section}.${field}` : field;
    const isPrivateBindingField = PRIVATE_REQUIREMENT_FIELDS.has(field);
    issues.push(
      issue(
        isPrivateBindingField
          ? `Source '${sourceId ?? "unknown"}' contains runtime-private field '${path}'. Bindings must not travel in a .agent.`
          : `Source '${sourceId ?? "unknown"}' contains unsupported field '${path}'. Source requirements are a closed portable schema.`,
        sourceId,
        isPrivateBindingField
          ? "private_binding_in_contract"
          : "invalid_contract",
      ),
    );
  }
}

function nonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.trim().length > 0)
  );
}

/**
 * Structural + safety validation for the portable part of a source contract.
 * The function returns every issue so builders can render a useful checklist.
 */
export function validateSourceRequirements(
  value: unknown,
): SourceContractIssue[] {
  if (!Array.isArray(value)) {
    return [issue("Agent file sources must be an array.")];
  }

  const issues: SourceContractIssue[] = [];
  if (value.length > 30) {
    issues.push(issue("An agent may declare at most 30 source requirements."));
  }
  const ids = new Set<string>();

  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      issues.push(issue("Each source requirement must be an object."));
      continue;
    }
    const source = raw as Record<string, unknown>;
    const sourceId =
      typeof source.id === "string" && source.id.length > 0
        ? source.id
        : undefined;

    if (!sourceId || !/^[a-z][a-z0-9._-]{0,79}$/.test(sourceId)) {
      issues.push(
        issue(
          "Source id must be a lowercase identifier (max 80 characters) starting with a letter and using only letters, numbers, '.', '_' or '-'.",
          sourceId,
        ),
      );
    } else if (ids.has(sourceId)) {
      issues.push(
        issue(
          `Source '${sourceId}' is declared more than once.`,
          sourceId,
          "duplicate_source_id",
        ),
      );
    } else {
      ids.add(sourceId);
    }

    if (typeof source.label !== "string" || !source.label.trim()) {
      issues.push(issue("Source requirement is missing a label.", sourceId));
    }
    if (!SOURCE_ROLES.includes(source.role as (typeof SOURCE_ROLES)[number])) {
      issues.push(
        issue(
          `Source '${sourceId ?? "unknown"}' has an unsupported role.`,
          sourceId,
        ),
      );
    }
    if (!SOURCE_KINDS.includes(source.kind as (typeof SOURCE_KINDS)[number])) {
      issues.push(
        issue(
          `Source '${sourceId ?? "unknown"}' has an unsupported kind.`,
          sourceId,
        ),
      );
    }
    if (typeof source.required !== "boolean") {
      issues.push(
        issue(
          `Source '${sourceId ?? "unknown"}' must declare required:boolean.`,
          sourceId,
        ),
      );
    }

    // SourceRequirement is a closed portable schema. parseAgentFile returns the
    // validated object, so merely ignoring unknown keys would let a misplaced
    // SourceBinding (sourceId, locator, revision, etc.) survive parse -> share.
    // Reject every undeclared key; known binding keys get the more specific
    // privacy issue used by builders and importers.
    rejectUnknownRequirementFields(
      issues,
      source,
      SOURCE_REQUIREMENT_FIELDS,
      sourceId,
    );

    if (source.accepts !== undefined) {
      if (
        !source.accepts ||
        typeof source.accepts !== "object" ||
        Array.isArray(source.accepts)
      ) {
        issues.push(
          issue(`Source '${sourceId}' accepts must be an object.`, sourceId),
        );
      } else {
        const accepts = source.accepts as Record<string, unknown>;
        rejectUnknownRequirementFields(
          issues,
          accepts,
          ACCEPTS_FIELDS,
          sourceId,
          "accepts",
        );
        for (const key of ["extensions", "mediaTypes", "providerTypes"]) {
          const values = accepts[key];
          if (values !== undefined && !nonEmptyStringArray(values)) {
            issues.push(
              issue(
                `Source '${sourceId}' accepts.${key} must be a non-empty string array.`,
                sourceId,
              ),
            );
          }
        }
        const declared = [
          accepts.extensions,
          accepts.mediaTypes,
          accepts.providerTypes,
        ].some((entry) => Array.isArray(entry) && entry.length > 0);
        if (!declared) {
          issues.push(
            issue(
              `Source '${sourceId}' accepts must declare at least one accepted type.`,
              sourceId,
            ),
          );
        }
      }
    }

    if (source.structure !== undefined) {
      if (
        !source.structure ||
        typeof source.structure !== "object" ||
        Array.isArray(source.structure)
      ) {
        issues.push(
          issue(`Source '${sourceId}' structure must be an object.`, sourceId),
        );
      } else {
        const structure = source.structure as Record<string, unknown>;
        rejectUnknownRequirementFields(
          issues,
          structure,
          STRUCTURE_FIELDS,
          sourceId,
          "structure",
        );
        for (const key of ["required", "optional"]) {
          if (
            structure[key] !== undefined &&
            !nonEmptyStringArray(structure[key])
          ) {
            issues.push(
              issue(
                `Source '${sourceId}' structure.${key} must be a non-empty string array.`,
                sourceId,
              ),
            );
          }
        }
        if (
          structure.schema !== undefined &&
          (!structure.schema ||
            typeof structure.schema !== "object" ||
            Array.isArray(structure.schema))
        ) {
          issues.push(
            issue(
              `Source '${sourceId}' structure.schema must be an object.`,
              sourceId,
            ),
          );
        }
      }
    }

    const access = source.access;
    let capabilities: SourceCapability[] = [];
    if (!access || typeof access !== "object" || Array.isArray(access)) {
      issues.push(
        issue(`Source '${sourceId}' is missing access policy.`, sourceId),
      );
    } else {
      const accessRecord = access as Record<string, unknown>;
      rejectUnknownRequirementFields(
        issues,
        accessRecord,
        ACCESS_FIELDS,
        sourceId,
        "access",
      );
      if (
        !Array.isArray(accessRecord.capabilities) ||
        accessRecord.capabilities.length === 0
      ) {
        issues.push(
          issue(
            `Source '${sourceId}' access.capabilities must be non-empty.`,
            sourceId,
          ),
        );
      } else {
        capabilities = accessRecord.capabilities.filter(
          (capability): capability is SourceCapability =>
            typeof capability === "string" &&
            SOURCE_CAPABILITIES.includes(
              capability as (typeof SOURCE_CAPABILITIES)[number],
            ),
        );
        if (capabilities.length !== accessRecord.capabilities.length) {
          issues.push(
            issue(
              `Source '${sourceId}' declares an unsupported access capability.`,
              sourceId,
            ),
          );
        }
        if (
          new Set(accessRecord.capabilities).size !==
          accessRecord.capabilities.length
        ) {
          issues.push(
            issue(
              `Source '${sourceId}' declares a capability more than once.`,
              sourceId,
            ),
          );
        }
      }
      if (
        accessRecord.boundaries !== undefined &&
        !nonEmptyStringArray(accessRecord.boundaries)
      ) {
        issues.push(
          issue(
            `Source '${sourceId}' access.boundaries must be a non-empty string array.`,
            sourceId,
          ),
        );
      }
    }

    if (
      source.role === "output" &&
      !capabilities.some((capability) => WRITE_CAPABILITIES.has(capability))
    ) {
      issues.push(
        issue(
          `Output source '${sourceId}' must declare a write capability.`,
          sourceId,
        ),
      );
    }

    if (source.freshness !== undefined) {
      if (
        !source.freshness ||
        typeof source.freshness !== "object" ||
        Array.isArray(source.freshness)
      ) {
        issues.push(
          issue(`Source '${sourceId}' freshness must be an object.`, sourceId),
        );
      } else {
        const freshness = source.freshness as Record<string, unknown>;
        rejectUnknownRequirementFields(
          issues,
          freshness,
          FRESHNESS_FIELDS,
          sourceId,
          "freshness",
        );
        if (!["snapshot", "on-run", "watch"].includes(String(freshness.mode))) {
          issues.push(
            issue(`Source '${sourceId}' freshness.mode is invalid.`, sourceId),
          );
        }
        if (!["fail", "warn"].includes(String(freshness.onStale))) {
          issues.push(
            issue(
              `Source '${sourceId}' freshness.onStale is invalid.`,
              sourceId,
            ),
          );
        }
        if (
          freshness.maxAgeSeconds !== undefined &&
          (typeof freshness.maxAgeSeconds !== "number" ||
            !Number.isFinite(freshness.maxAgeSeconds) ||
            freshness.maxAgeSeconds <= 0)
        ) {
          issues.push(
            issue(
              `Source '${sourceId}' freshness.maxAgeSeconds must be positive.`,
              sourceId,
            ),
          );
        }
        if (freshness.mode === "on-run" && !capabilities.includes("sync")) {
          issues.push(
            issue(
              `Source '${sourceId}' uses on-run freshness but does not require sync.`,
              sourceId,
            ),
          );
        }
        if (freshness.mode === "watch" && !capabilities.includes("watch")) {
          issues.push(
            issue(
              `Source '${sourceId}' uses watch freshness but does not require watch.`,
              sourceId,
            ),
          );
        }
      }
    }

    if (source.truth !== undefined) {
      if (
        !source.truth ||
        typeof source.truth !== "object" ||
        Array.isArray(source.truth)
      ) {
        issues.push(
          issue(`Source '${sourceId}' truth must be an object.`, sourceId),
        );
      } else {
        const truth = source.truth as Record<string, unknown>;
        rejectUnknownRequirementFields(
          issues,
          truth,
          TRUTH_FIELDS,
          sourceId,
          "truth",
        );
        if (
          !["authoritative", "supporting", "reference", "example"].includes(
            String(truth.authority),
          )
        ) {
          issues.push(
            issue(`Source '${sourceId}' truth.authority is invalid.`, sourceId),
          );
        }
        if (
          !["fail", "ask", "prefer-authority", "prefer-newer"].includes(
            String(truth.conflictPolicy),
          )
        ) {
          issues.push(
            issue(
              `Source '${sourceId}' truth.conflictPolicy is invalid.`,
              sourceId,
            ),
          );
        }
        if (
          !["required", "preferred", "none"].includes(String(truth.citations))
        ) {
          issues.push(
            issue(`Source '${sourceId}' truth.citations is invalid.`, sourceId),
          );
        }
        if (
          truth.priority !== undefined &&
          (typeof truth.priority !== "number" ||
            !Number.isFinite(truth.priority) ||
            truth.priority < 0 ||
            truth.priority > 100)
        ) {
          issues.push(
            issue(
              `Source '${sourceId}' truth.priority must be 0..100.`,
              sourceId,
            ),
          );
        }
        if (truth.citations === "required" && !capabilities.includes("cite")) {
          issues.push(
            issue(
              `Source '${sourceId}' requires citations but does not require cite capability.`,
              sourceId,
            ),
          );
        }
      }
    }

    if (source.approval !== undefined) {
      if (
        !source.approval ||
        typeof source.approval !== "object" ||
        Array.isArray(source.approval)
      ) {
        issues.push(
          issue(`Source '${sourceId}' approval must be an object.`, sourceId),
        );
      } else {
        const approval = source.approval as Record<string, unknown>;
        rejectUnknownRequirementFields(
          issues,
          approval,
          APPROVAL_FIELDS,
          sourceId,
          "approval",
        );
        for (const key of ["read", "write"]) {
          if (
            approval[key] !== undefined &&
            !APPROVAL_MODES.has(String(approval[key]))
          ) {
            issues.push(
              issue(
                `Source '${sourceId}' approval.${key} is invalid.`,
                sourceId,
              ),
            );
          }
        }
        if (
          approval.destructive !== undefined &&
          !["forbidden", "every-action"].includes(String(approval.destructive))
        ) {
          issues.push(
            issue(
              `Source '${sourceId}' approval.destructive is invalid.`,
              sourceId,
            ),
          );
        }
        if (
          capabilities.includes("delete") &&
          approval.destructive !== "every-action"
        ) {
          issues.push(
            issue(
              `Source '${sourceId}' delete access requires every-action approval.`,
              sourceId,
            ),
          );
        }
      }
    }
    if (
      capabilities.some((capability) => WRITE_CAPABILITIES.has(capability)) &&
      (!source.approval ||
        typeof source.approval !== "object" ||
        Array.isArray(source.approval) ||
        !(source.approval as Record<string, unknown>).write)
    ) {
      issues.push(
        issue(
          `Writable source '${sourceId}' must declare approval.write explicitly.`,
          sourceId,
        ),
      );
    }

    if (source.sharing !== undefined) {
      if (
        !source.sharing ||
        typeof source.sharing !== "object" ||
        Array.isArray(source.sharing)
      ) {
        issues.push(
          issue(`Source '${sourceId}' sharing must be an object.`, sourceId),
        );
      } else {
        const sharing = source.sharing as Record<string, unknown>;
        rejectUnknownRequirementFields(
          issues,
          sharing,
          SHARING_FIELDS,
          sourceId,
          "sharing",
        );
        if (
          !["rebind", "exclude", "snapshot"].includes(String(sharing.strategy))
        ) {
          issues.push(
            issue(
              `Source '${sourceId}' sharing.strategy is invalid.`,
              sourceId,
            ),
          );
        }
        if (
          sharing.derivedKnowledge !== undefined &&
          !["exclude", "approved-only", "include"].includes(
            String(sharing.derivedKnowledge),
          )
        ) {
          issues.push(
            issue(
              `Source '${sourceId}' sharing.derivedKnowledge is invalid.`,
              sourceId,
            ),
          );
        }
        if (
          sharing.recipientMayOverride !== undefined &&
          typeof sharing.recipientMayOverride !== "boolean"
        ) {
          issues.push(
            issue(
              `Source '${sourceId}' sharing.recipientMayOverride must be boolean.`,
              sourceId,
            ),
          );
        }
      }
    }
  }
  return issues;
}

/** Validate the optional portable evaluation contract. */
export function validateEvaluationContract(
  value: unknown,
  knownSourceIds?: readonly string[],
): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ["Agent file evaluation must be an object."];
  }
  const contract = value as Partial<EvaluationContract>;
  const issues: string[] = [];
  if (contract.version !== 1) {
    issues.push("Agent file evaluation.version must be 1.");
  }
  if (
    contract.failurePolicy !== "block" &&
    contract.failurePolicy !== "require-approval" &&
    contract.failurePolicy !== "warn"
  ) {
    issues.push("Agent file evaluation.failurePolicy is invalid.");
  }
  if (
    contract.minimumScore !== undefined &&
    (typeof contract.minimumScore !== "number" ||
      !Number.isFinite(contract.minimumScore) ||
      contract.minimumScore < 0 ||
      contract.minimumScore > 1)
  ) {
    issues.push("Agent file evaluation.minimumScore must be 0..1.");
  }
  if (!Array.isArray(contract.checks) || contract.checks.length === 0) {
    issues.push("Agent file evaluation.checks must be a non-empty array.");
    return issues;
  }
  if (contract.checks.length > 50) {
    issues.push("Agent file evaluation.checks can contain at most 50 checks.");
  }
  const ids = new Set<string>();
  for (const raw of contract.checks) {
    if (!raw || typeof raw !== "object") {
      issues.push("Agent file evaluation check must be an object.");
      continue;
    }
    const check = raw as Record<string, unknown>;
    const id = typeof check.id === "string" ? check.id : "";
    if (!id) issues.push("Agent file evaluation check missing id.");
    else if (id.length > 160)
      issues.push(`Agent file evaluation check id exceeds 160 characters.`);
    else if (ids.has(id))
      issues.push(`Agent file evaluation check '${id}' is declared twice.`);
    else ids.add(id);
    if (typeof check.name !== "string" || !check.name.trim()) {
      issues.push(`Agent file evaluation check '${id}' missing name.`);
    } else if (check.name.length > 280) {
      issues.push(`Agent file evaluation check '${id}' name is too long.`);
    }
    if (
      check.description !== undefined &&
      (typeof check.description !== "string" ||
        check.description.length > 4_000)
    ) {
      issues.push(
        `Agent file evaluation check '${id}' description is invalid.`,
      );
    }
    if (
      !EVALUATION_CHECK_TYPES.includes(
        check.type as (typeof EVALUATION_CHECK_TYPES)[number],
      )
    ) {
      issues.push(`Agent file evaluation check '${id}' has an invalid type.`);
    }
    if (!["bind", "pre-run", "post-run"].includes(String(check.phase))) {
      issues.push(`Agent file evaluation check '${id}' has an invalid phase.`);
    }
    if (!["error", "warning"].includes(String(check.severity))) {
      issues.push(
        `Agent file evaluation check '${id}' has an invalid severity.`,
      );
    }
    if (
      check.sourceIds !== undefined &&
      !nonEmptyStringArray(check.sourceIds)
    ) {
      issues.push(
        `Agent file evaluation check '${id}' sourceIds must be a string array.`,
      );
    } else if (Array.isArray(check.sourceIds) && check.sourceIds.length > 30) {
      issues.push(
        `Agent file evaluation check '${id}' has too many sourceIds.`,
      );
    } else if (Array.isArray(check.sourceIds) && knownSourceIds !== undefined) {
      for (const sourceId of check.sourceIds) {
        if (!knownSourceIds.includes(sourceId)) {
          issues.push(
            `Agent file evaluation check '${id}' references unknown source '${sourceId}'.`,
          );
        }
      }
    }
    if (
      (check.type === "custom" || check.type === "invariant") &&
      (typeof check.assertion !== "string" || !check.assertion.trim())
    ) {
      issues.push(`Agent file evaluation check '${id}' needs an assertion.`);
    }
    if (
      check.assertion !== undefined &&
      (typeof check.assertion !== "string" || check.assertion.length > 10_000)
    ) {
      issues.push(`Agent file evaluation check '${id}' assertion is invalid.`);
    }
    if (
      check.config !== undefined &&
      (!check.config ||
        typeof check.config !== "object" ||
        Array.isArray(check.config))
    ) {
      issues.push(
        `Agent file evaluation check '${id}' config must be an object.`,
      );
    } else if (
      check.config !== undefined &&
      JSON.stringify(check.config).length > 32_000
    ) {
      issues.push(`Agent file evaluation check '${id}' config is too large.`);
    }
    if (
      check.type === "output-schema" &&
      (!check.config ||
        typeof check.config !== "object" ||
        Array.isArray(check.config) ||
        !("schema" in check.config) ||
        !check.config.schema ||
        typeof check.config.schema !== "object" ||
        Array.isArray(check.config.schema))
    ) {
      issues.push(
        `Agent file evaluation check '${id}' output-schema needs config.schema.`,
      );
    }
  }
  return issues;
}

function normalizeExtension(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith(".") ? normalized : `.${normalized}`;
}

function mediaTypeMatches(actual: string, expected: string): boolean {
  const a = actual.trim().toLowerCase();
  const e = expected.trim().toLowerCase();
  return e.endsWith("/*") ? a.startsWith(e.slice(0, -1)) : a === e;
}

function sourceTimestamp(candidate: SourceBindingCandidate): Date | null {
  const raw = candidate.lastSyncedAt ?? candidate.revision?.modifiedAt;
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Compare one inspected private binding with one portable requirement. */
export function checkSourceCompatibility(
  requirement: SourceRequirement,
  candidate: SourceBindingCandidate,
  options: { now?: Date | string } = {},
): SourceCompatibility {
  const issues: SourceContractIssue[] = [];
  const missingCapabilities: SourceCapability[] = [];
  const missingStructure: string[] = [];

  if (candidate.sourceId !== requirement.id) {
    issues.push(
      issue(
        `Binding for '${candidate.sourceId}' cannot satisfy source '${requirement.id}'.`,
        requirement.id,
        "binding_source_mismatch",
      ),
    );
  }
  if (candidate.status && candidate.status !== "ready") {
    issues.push(
      issue(
        `Source '${requirement.label}' binding is ${candidate.status}.`,
        requirement.id,
        "binding_not_ready",
      ),
    );
  }
  if (candidate.kind !== requirement.kind) {
    issues.push(
      issue(
        `Source '${requirement.label}' expects kind '${requirement.kind}', received '${candidate.kind}'.`,
        requirement.id,
        "kind_mismatch",
      ),
    );
  }

  const accepts = requirement.accepts;
  if (accepts) {
    const extensionMatches =
      !!candidate.extension &&
      !!accepts.extensions?.some(
        (expected) =>
          normalizeExtension(expected) ===
          normalizeExtension(candidate.extension!),
      );
    const mediaMatches =
      !!candidate.mediaType &&
      !!accepts.mediaTypes?.some((expected) =>
        mediaTypeMatches(candidate.mediaType!, expected),
      );
    const hasFileTypes =
      (accepts.extensions?.length ?? 0) > 0 ||
      (accepts.mediaTypes?.length ?? 0) > 0;
    const providerMatches =
      !accepts.providerTypes?.length ||
      (!!candidate.providerType &&
        accepts.providerTypes.some(
          (expected) =>
            expected.toLowerCase() === candidate.providerType!.toLowerCase(),
        ));
    if (
      (hasFileTypes && !extensionMatches && !mediaMatches) ||
      !providerMatches
    ) {
      issues.push(
        issue(
          `Source '${requirement.label}' does not match its accepted type contract.`,
          requirement.id,
          "type_mismatch",
        ),
      );
    }
  }

  const actualStructure = candidate.structure ?? [];
  for (const expected of requirement.structure?.required ?? []) {
    if (
      !actualStructure.some((actual) => structureLineMatches(expected, actual))
    ) {
      missingStructure.push(expected);
    }
  }
  if (missingStructure.length > 0) {
    issues.push(
      issue(
        `Source '${requirement.label}' is missing ${missingStructure.length} required structural item${missingStructure.length === 1 ? "" : "s"}.`,
        requirement.id,
        "structure_missing",
      ),
    );
  }

  for (const capability of requirement.access.capabilities) {
    if (!candidate.capabilities.includes(capability)) {
      missingCapabilities.push(capability);
      issues.push({
        code: "capability_missing",
        severity: "error",
        message: `Source '${requirement.label}' is missing required capability '${capability}'.`,
        sourceId: requirement.id,
        capability,
      });
    }
  }

  const freshness = requirement.freshness;
  if (freshness?.maxAgeSeconds !== undefined) {
    const timestamp = sourceTimestamp(candidate);
    const severity = freshness.onStale === "fail" ? "error" : "warning";
    if (!timestamp) {
      issues.push(
        issue(
          `Source '${requirement.label}' freshness cannot be verified.`,
          requirement.id,
          "freshness_unknown",
          severity,
        ),
      );
    } else {
      const now =
        options.now instanceof Date
          ? options.now
          : new Date(options.now ?? Date.now());
      const ageSeconds = (now.getTime() - timestamp.getTime()) / 1000;
      if (ageSeconds > freshness.maxAgeSeconds) {
        issues.push(
          issue(
            `Source '${requirement.label}' is stale (${Math.floor(ageSeconds)}s old; maximum ${freshness.maxAgeSeconds}s).`,
            requirement.id,
            "source_stale",
            severity,
          ),
        );
      }
    }
  }

  return {
    compatible: !issues.some((entry) => entry.severity === "error"),
    issues,
    missingCapabilities,
    missingStructure,
  };
}

function checkAdapter(
  requirement: SourceRequirement,
  candidate: SourceBindingCandidate,
  adapters: readonly SourceAdapterCapabilities[],
): SourceContractIssue[] {
  const adapter = adapters.find(
    (item) => item.adapterId === candidate.adapterId,
  );
  if (!adapter) {
    return [
      issue(
        `Runtime does not provide source adapter '${candidate.adapterId}' for '${requirement.label}'.`,
        requirement.id,
        "adapter_unavailable",
      ),
    ];
  }
  const issues: SourceContractIssue[] = [];
  if (!adapter.kinds.includes(requirement.kind)) {
    issues.push(
      issue(
        `Adapter '${adapter.adapterId}' cannot bind source kind '${requirement.kind}'.`,
        requirement.id,
        "adapter_kind_unsupported",
      ),
    );
  }
  for (const capability of requirement.access.capabilities) {
    if (!adapter.capabilities.includes(capability)) {
      issues.push({
        code: "adapter_capability_missing",
        severity: "error",
        message: `Adapter '${adapter.adapterId}' cannot provide required capability '${capability}'.`,
        sourceId: requirement.id,
        capability,
      });
    }
  }
  return issues;
}

/**
 * Host-level preflight. Required sources, adapter availability, permissions,
 * structure, and freshness all block readiness instead of silently degrading.
 * A legacy AgentFileV1 with no `sources` remains ready.
 */
export function checkAgentSourceReadiness(
  agent: SourceContractCarrier,
  runtime: SourceRuntimeContext,
): SourceReadinessReport {
  if (!agent.sources || agent.sources.length === 0) {
    return { ready: true, sources: [], issues: [] };
  }

  const contractIssues = validateSourceRequirements(agent.sources);
  if (contractIssues.some((entry) => entry.severity === "error")) {
    return {
      ready: false,
      sources: agent.sources.map((requirement) => ({
        requirement,
        compatible: false,
        issues: contractIssues.filter(
          (entry) => !entry.sourceId || entry.sourceId === requirement.id,
        ),
      })),
      issues: contractIssues,
    };
  }
  const items: SourceReadinessItem[] = [];
  const allIssues = [...contractIssues];

  for (const requirement of agent.sources) {
    const matches = runtime.bindings.filter(
      (binding) => binding.sourceId === requirement.id,
    );
    if (matches.length === 0) {
      if (requirement.required) {
        const missing = issue(
          `Required source '${requirement.label}' is not bound.`,
          requirement.id,
          "missing_binding",
        );
        allIssues.push(missing);
        items.push({
          requirement,
          compatible: false,
          issues: [missing],
        });
      } else {
        items.push({ requirement, compatible: true, issues: [] });
      }
      continue;
    }

    const itemIssues: SourceContractIssue[] = [];
    if (matches.length > 1) {
      itemIssues.push(
        issue(
          `Source '${requirement.label}' has multiple bindings; exactly one is required.`,
          requirement.id,
          "duplicate_binding",
        ),
      );
    }
    const binding = matches[0];
    const compatibility = checkSourceCompatibility(requirement, binding, {
      now: runtime.now,
    });
    itemIssues.push(...compatibility.issues);
    itemIssues.push(...checkAdapter(requirement, binding, runtime.adapters));
    allIssues.push(...itemIssues);
    items.push({
      requirement,
      binding,
      compatible: !itemIssues.some((entry) => entry.severity === "error"),
      issues: itemIssues,
    });
  }

  return {
    ready: !allIssues.some((entry) => entry.severity === "error"),
    sources: items,
    issues: allIssues,
  };
}

export class SourceReadinessError extends Error {
  readonly report: SourceReadinessReport;

  constructor(report: SourceReadinessReport) {
    const details = report.issues
      .filter((entry) => entry.severity === "error")
      .map((entry) => entry.message)
      .join(" ");
    super(`Agent source requirements are not ready. ${details}`.trim());
    this.name = "SourceReadinessError";
    this.report = report;
  }
}

/** Throwing companion for run paths that must fail loud before execution. */
export function assertAgentSourceReady(
  agent: SourceContractCarrier,
  runtime: SourceRuntimeContext,
): void {
  const report = checkAgentSourceReadiness(agent, runtime);
  if (!report.ready) throw new SourceReadinessError(report);
}
