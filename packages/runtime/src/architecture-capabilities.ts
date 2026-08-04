/**
 * Authoritative worker-architecture capability registry.
 *
 * Architecture names are part of the portable `.agent` vocabulary, but an
 * architecture is selectable only after the runtime can execute it end to
 * end. Keeping those two ideas separate lets old artifacts remain readable
 * without advertising metadata-only execution modes as working features.
 */
export const WORKER_ARCHITECTURE_IDS = [
  "solo",
  "pipeline",
  "orchestrator_workers",
  "hierarchical",
] as const;

export type WorkerArchitectureId =
  (typeof WORKER_ARCHITECTURE_IDS)[number];

export type WorkerArchitectureAvailability = "available" | "planned";

export type WorkerArchitectureCapability = Readonly<{
  id: WorkerArchitectureId;
  label: string;
  description: string;
  availability: WorkerArchitectureAvailability;
  /** Product/runtime reason to keep this architecture in the roadmap. */
  futureNeed?: string;
  /** Evidence required before changing availability to `available`. */
  enablementGate?: string;
}>;

export const WORKER_ARCHITECTURE_CAPABILITIES = [
  {
    id: "solo",
    label: "Solo worker",
    description:
      "One worker keeps the full conversation and tool context for the whole job.",
    availability: "available",
  },
  {
    id: "pipeline",
    label: "Sequential pipeline",
    description:
      "Typed stages pass work forward with stage-level retries and resumability.",
    availability: "planned",
    futureNeed:
      "Deterministic multi-stage jobs that need typed handoffs, independent retries, and resumable execution.",
    enablementGate:
      "Blueprint, persistence, export/import, runtime, trace, retry, resume, and cost tests must pass end to end.",
  },
  {
    id: "orchestrator_workers",
    label: "Orchestrator + workers",
    description:
      "An orchestrator delegates independent work to explicitly scoped child workers.",
    availability: "planned",
    futureNeed:
      "Genuinely parallel research or execution with per-worker tools, models, budgets, and bounded concurrency.",
    enablementGate:
      "Child-worker model/tool/budget scopes, concurrency and recursion limits, persistence, trace, and cost tests must pass end to end.",
  },
  {
    id: "hierarchical",
    label: "Hierarchical orchestration",
    description:
      "Recursive orchestration for complex worker trees.",
    availability: "planned",
    futureNeed:
      "Deep delegation when one orchestration level is insufficient; this should be expressed as recursive orchestration, not a separate first implementation.",
    enablementGate:
      "Recursive orchestration must have depth, concurrency, budget, cancellation, persistence, trace, and cost limits proven end to end.",
  },
] as const satisfies readonly WorkerArchitectureCapability[];

export type SupportedWorkerArchitectureId = Extract<
  (typeof WORKER_ARCHITECTURE_CAPABILITIES)[number],
  { availability: "available" }
>["id"];

export const DEFAULT_WORKER_ARCHITECTURE: SupportedWorkerArchitectureId =
  "solo";

export const SUPPORTED_WORKER_ARCHITECTURES =
  WORKER_ARCHITECTURE_CAPABILITIES.filter(
    (capability) => capability.availability === "available",
  );

const knownArchitectureIds = new Set<string>(WORKER_ARCHITECTURE_IDS);
const supportedArchitectureIds = new Set<string>(
  SUPPORTED_WORKER_ARCHITECTURES.map((capability) => capability.id),
);

export function isKnownWorkerArchitecture(
  value: unknown,
): value is WorkerArchitectureId {
  return typeof value === "string" && knownArchitectureIds.has(value);
}

export function isSupportedWorkerArchitecture(
  value: unknown,
): value is SupportedWorkerArchitectureId {
  return typeof value === "string" && supportedArchitectureIds.has(value);
}

