import {
  checkAgentSourceReadiness,
  type AgentFileV1,
  type SourceBinding,
  type SourceReadinessReport,
  type SourceRequirement,
} from "@agentmug/runtime";
import { LocalReadOnlySourceAdapter } from "./local-source-adapter.js";
import { supportsLocalSourceAccepts } from "./source-extractors.js";
import { CliSourceBindingStore } from "./source-state.js";
import { terminalSafeOneLine } from "./terminal-safety.js";

export type CliSourceHostIssue = {
  sourceId: string;
  severity: "error" | "warning";
  code: string;
  message: string;
};

export type PreparedCliSources = {
  adapter: LocalReadOnlySourceAdapter;
  bindings: SourceBinding[];
  report: SourceReadinessReport;
  hostIssues: CliSourceHostIssue[];
  ready: boolean;
};

export type CliSourceStatus = {
  id: string;
  label: string;
  kind: string;
  required: boolean;
  bound: boolean;
  orphaned?: boolean;
  status: string;
  displayName?: string;
  extension?: string;
  mediaType?: string;
  capabilities: string[];
  revision?: {
    id?: string;
    idAttestation?: "host-computed" | "owner-client" | "source-adapter";
    modifiedAt?: string;
    contentHash?: string;
  };
  structure?: string[];
  approval?: {
    read?: string;
    approvedAt?: string;
  };
  issues: Array<{
    severity: "error" | "warning";
    code: string;
    message: string;
  }>;
};

function safeInspectionMessage(error: unknown, binding: SourceBinding): string {
  let message = error instanceof Error ? error.message : String(error);
  const privatePath = binding.locator.path;
  if (typeof privatePath === "string" && privatePath) {
    message = message.split(privatePath).join("[private path]");
  }
  return message.slice(0, 1_000);
}

function hostContractIssues(
  requirements: readonly SourceRequirement[],
  boundSourceIds: ReadonlySet<string>,
): CliSourceHostIssue[] {
  const issues: CliSourceHostIssue[] = [];
  for (const requirement of requirements) {
    if (!requirement.required && !boundSourceIds.has(requirement.id)) {
      continue;
    }
    if (
      requirement.approval?.read === "every-run" ||
      requirement.approval?.read === "every-action"
    ) {
      issues.push({
        sourceId: requirement.id,
        severity: "error",
        code: "interactive_read_approval_unsupported",
        message:
          `Source '${requirement.label}' requires interactive read approval ` +
          "that an unattended CLI run cannot collect.",
      });
    }
    if (requirement.freshness?.mode === "watch") {
      issues.push({
        sourceId: requirement.id,
        severity: "error",
        code: "watch_freshness_unsupported",
        message:
          `Source '${requirement.label}' requires continuous watch freshness; ` +
          "the CLI local adapter supports snapshot and on-run inspection only.",
      });
    }
    if (requirement.structure?.schema) {
      issues.push({
        sourceId: requirement.id,
        severity: "error",
        code: "structure_schema_unsupported",
        message:
          `Source '${requirement.label}' requires JSON Schema validation; ` +
          "this CLI host does not yet project local artifacts into a bounded schema candidate.",
      });
    }
    if (
      requirement.kind !== "provider" &&
      !supportsLocalSourceAccepts(requirement.accepts)
    ) {
      issues.push({
        sourceId: requirement.id,
        severity: "error",
        code: "local_format_unsupported",
        message:
          `Source '${requirement.label}' accepts only formats this CLI cannot extract. ` +
          "Web/cloud may support additional PDF or image formats; install a capable local adapter or bind this agent on a supported host.",
      });
    }
  }
  return issues;
}

export async function prepareCliSources(
  agentPath: string,
  file: AgentFileV1,
  options: {
    store?: CliSourceBindingStore;
    adapter?: LocalReadOnlySourceAdapter;
  } = {},
): Promise<PreparedCliSources> {
  const store = options.store ?? new CliSourceBindingStore();
  const adapter =
    options.adapter ??
    new LocalReadOnlySourceAdapter({
      excludedRoots: [store.stateRoot],
    });
  const requirements = file.sources ?? [];
  if (requirements.length === 0) {
    const report = checkAgentSourceReadiness(file, {
      bindings: [],
      adapters: [],
    });
    return {
      adapter,
      bindings: [],
      report,
      hostIssues: [],
      ready: true,
    };
  }

  const stored = await store.list(agentPath, file);
  const inspected: SourceBinding[] = [];
  const inspectionIssues: CliSourceHostIssue[] = [];
  const requirementIds = new Set(requirements.map((item) => item.id));
  const requirementById = new Map(
    requirements.map((item) => [item.id, item]),
  );
  const policyIssues = hostContractIssues(
    requirements,
    new Set(stored.map((binding) => binding.sourceId)),
  );
  const policyBlockedIds = new Set(
    policyIssues
      .filter((issue) => issue.severity === "error")
      .map((issue) => issue.sourceId),
  );
  for (const binding of stored) {
    if (!requirementIds.has(binding.sourceId)) {
      // Orphans are shown so the user can clean them up, but their private
      // locator is never dereferenced and can never make an active run fail.
      inspected.push(binding);
      continue;
    }
    if (policyBlockedIds.has(binding.sourceId)) {
      inspected.push({ ...binding, status: "error" });
      continue;
    }
    if (binding.status === "revoked") {
      inspected.push(binding);
      inspectionIssues.push({
        sourceId: binding.sourceId,
        severity: "error",
        code: "binding_authority_changed",
        message:
          "Agent execution authority changed after this source was approved; explicitly bind it again.",
      });
      continue;
    }
    try {
      const candidate = await adapter.inspect(binding);
      const requirement = requirementById.get(binding.sourceId)!;
      if (requirement.freshness?.mode === "snapshot") {
        const boundRevision =
          binding.revision?.contentHash ?? binding.revision?.id;
        const currentRevision =
          candidate.revision?.contentHash ?? candidate.revision?.id;
        if (!boundRevision || boundRevision !== currentRevision) {
          inspected.push({ ...binding, status: "stale" });
          inspectionIssues.push({
            sourceId: binding.sourceId,
            severity: "error",
            code: "snapshot_revision_changed",
            message:
              `Snapshot source '${requirement.label}' changed after approval; explicitly bind it again to approve the new revision.`,
          });
          continue;
        }
      }
      inspected.push({
        ...binding,
        ...candidate,
        id: binding.id,
        locator: binding.locator,
      });
    } catch (error) {
      inspected.push({ ...binding, status: "error" });
      inspectionIssues.push({
        sourceId: binding.sourceId,
        severity: "error",
        code: "local_source_inspection_failed",
        message:
          `Source '${binding.displayName ?? binding.sourceId}' could not be inspected: ` +
          safeInspectionMessage(error, binding),
      });
    }
  }

  const report = checkAgentSourceReadiness(file, {
    bindings: inspected,
    adapters: [adapter.capabilities],
  });
  const hostIssues = [
    ...inspectionIssues,
    ...policyIssues,
  ];
  return {
    adapter,
    bindings: inspected,
    report,
    hostIssues,
    ready:
      report.ready &&
      !hostIssues.some((issue) => issue.severity === "error"),
  };
}

function issueMessages(
  sourceId: string,
  report: SourceReadinessReport,
  hostIssues: readonly CliSourceHostIssue[],
): CliSourceStatus["issues"] {
  const runtime = report.issues
    .filter((issue) => issue.sourceId === sourceId)
    .map((issue) => ({
      severity: issue.severity,
      code: issue.code,
      message: issue.message,
    }));
  const host = hostIssues
    .filter((issue) => issue.sourceId === sourceId)
    .map(({ severity, code, message }) => ({ severity, code, message }));
  const seen = new Set<string>();
  return [...runtime, ...host].filter((issue) => {
    const key = `${issue.severity}\u0000${issue.code}\u0000${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function cliSourceStatuses(
  file: AgentFileV1,
  prepared: PreparedCliSources,
): CliSourceStatus[] {
  const statuses: CliSourceStatus[] = (file.sources ?? []).map((requirement) => {
    const binding = prepared.bindings.find(
      (candidate) => candidate.sourceId === requirement.id,
    );
    const issues = issueMessages(
      requirement.id,
      prepared.report,
      prepared.hostIssues,
    );
    return {
      id: requirement.id,
      label: requirement.label,
      kind: requirement.kind,
      required: requirement.required,
      bound: Boolean(binding),
      status: binding?.status ?? (requirement.required ? "missing" : "optional"),
      displayName: binding?.displayName,
      extension: binding?.extension,
      mediaType: binding?.mediaType,
      capabilities: binding?.capabilities ?? [],
      revision: binding?.revision
        ? {
            id: binding.revision.id,
            idAttestation: binding.revision.idAttestation,
            modifiedAt: binding.revision.modifiedAt,
            contentHash: binding.revision.contentHash,
          }
        : undefined,
      structure: binding?.structure,
      approval:
        requirement.approval?.read || binding?.metadata?.approvedAt
          ? {
              read: requirement.approval?.read,
              approvedAt:
                typeof binding?.metadata?.approvedAt === "string"
                  ? binding.metadata.approvedAt
                  : undefined,
            }
          : undefined,
      issues,
    };
  });

  const requirementIds = new Set((file.sources ?? []).map((item) => item.id));
  for (const binding of prepared.bindings) {
    if (requirementIds.has(binding.sourceId)) continue;
    statuses.push({
      id: binding.sourceId,
      label: binding.sourceId,
      kind: binding.kind,
      required: false,
      bound: true,
      orphaned: true,
      status: binding.status,
      displayName: binding.displayName,
      extension: binding.extension,
      mediaType: binding.mediaType,
      capabilities: binding.capabilities,
      revision: binding.revision
        ? {
            id: binding.revision.id,
            idAttestation: binding.revision.idAttestation,
            modifiedAt: binding.revision.modifiedAt,
            contentHash: binding.revision.contentHash,
          }
        : undefined,
      structure: binding.structure,
      issues: [{
        severity: "warning",
        code: "orphaned_binding",
        message: "Binding no longer has a matching requirement in this .agent.",
      }],
    });
  }
  return statuses;
}

export async function bindCliSource(
  agentPath: string,
  file: AgentFileV1,
  sourceId: string,
  targetPath: string,
  options: {
    store?: CliSourceBindingStore;
    adapter?: LocalReadOnlySourceAdapter;
    approved?: boolean;
  } = {},
): Promise<CliSourceStatus> {
  const requirement = (file.sources ?? []).find(
    (source) => source.id === sourceId,
  );
  if (!requirement) {
    throw new Error(
      `Agent does not declare source '${sourceId}'. Run 'agentmug sources list ${agentPath}' to see its requirements.`,
    );
  }
  const store = options.store ?? new CliSourceBindingStore();
  const adapter =
    options.adapter ??
    new LocalReadOnlySourceAdapter({
      excludedRoots: [store.stateRoot],
    });
  const preflightHostIssues = hostContractIssues(
    [requirement],
    new Set([requirement.id]),
  );
  const unsupportedHost = preflightHostIssues.find(
    (issue) => issue.severity === "error",
  );
  if (unsupportedHost) {
    throw new Error(
      `Local binding cannot satisfy '${requirement.label}': ${unsupportedHost.message}`,
    );
  }
  const missingCapability = requirement.access.capabilities.find(
    (capability) =>
      !adapter.capabilities.capabilities.includes(capability),
  );
  if (
    !adapter.capabilities.kinds.includes(requirement.kind) ||
    missingCapability
  ) {
    throw new Error(
      `Local binding cannot satisfy '${requirement.label}': ` +
        (missingCapability
          ? `the read-only CLI adapter cannot provide '${missingCapability}'.`
          : `source kind '${requirement.kind}' is unsupported.`),
    );
  }
  if (requirement.approval?.read === "on-bind" && !options.approved) {
    throw new Error(
      `Source '${requirement.label}' requires explicit on-bind read approval; review the source and rerun with --approve.`,
    );
  }
  const created = await adapter.createBinding(requirement, targetPath);
  const binding: SourceBinding = {
    ...created,
    metadata: {
      ...(created.metadata ?? {}),
      ...(requirement.approval?.read === "on-bind"
        ? { approvedAt: new Date().toISOString() }
        : {}),
    },
  };
  const report = checkAgentSourceReadiness(
    { sources: [requirement] },
    {
      bindings: [binding],
      adapters: [adapter.capabilities],
    },
  );
  const hostIssues = preflightHostIssues;
  const errors = [
    ...report.issues.filter((issue) => issue.severity === "error"),
    ...hostIssues.filter((issue) => issue.severity === "error"),
  ];
  if (errors.length > 0) {
    throw new Error(
      `Local binding cannot satisfy '${requirement.label}': ${errors
        .map((issue) => issue.message)
        .join(" ")}`,
    );
  }
  await store.put(agentPath, file, binding);
  const prepared: PreparedCliSources = {
    adapter,
    bindings: [binding],
    report,
    hostIssues,
    ready: true,
  };
  return cliSourceStatuses(
    { ...file, sources: [requirement] },
    prepared,
  )[0]!;
}

export async function unbindCliSource(
  agentPath: string,
  file: AgentFileV1,
  sourceId: string,
  store = new CliSourceBindingStore(),
): Promise<boolean> {
  return store.remove(agentPath, file, sourceId);
}

export function sourceReadinessErrorLines(
  file: AgentFileV1,
  prepared: PreparedCliSources,
): string[] {
  const lines: string[] = [];
  for (const status of cliSourceStatuses(file, prepared)) {
    if (status.orphaned) continue;
    const marker =
      status.issues.some((issue) => issue.severity === "error")
        ? "✗"
        : status.bound
          ? "✓"
          : "○";
    const binding = status.displayName
      ? ` — ${terminalSafeOneLine(status.displayName)}`
      : "";
    lines.push(
      `  ${marker} ${terminalSafeOneLine(status.label)} ` +
        `[${terminalSafeOneLine(status.kind, 100)}]${binding}`,
    );
    for (const fact of status.structure ?? []) {
      lines.push(`      ${terminalSafeOneLine(fact)}`);
    }
    for (const issue of status.issues) {
      lines.push(
        `      ${issue.severity === "error" ? "error" : "warning"}: ` +
          terminalSafeOneLine(issue.message),
      );
    }
  }
  return lines;
}

export function countBlockingSourceItems(
  file: AgentFileV1,
  prepared: PreparedCliSources,
): number {
  return cliSourceStatuses(file, prepared).filter(
    (status) =>
      !status.orphaned &&
      status.issues.some((issue) => issue.severity === "error"),
  ).length;
}
