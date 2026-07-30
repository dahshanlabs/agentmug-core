// SourceExecutionPlan — the unforgeable admission ticket for a run.
//
// Structural invariant (the reason this module exists): the engine's
// required-source gate can only check the requirements a caller passes in.
// A run entry point that simply never loads the worker's requirements gets
// a trivially-passing gate — the historical bypass risk with N independent
// call sites. This module closes it in two layers:
//
//   1. Type level: `runAgent` takes a required `sources: SourceExecutionPlan`.
//      There is no raw-requirements field. A new entry point cannot compile
//      without explicitly deciding its sources — either a real plan from
//      `prepareSourceExecution()` or a deliberate `noSourcePlan()`.
//   2. Runtime level: only `prepareSourceExecution()` can mint a plan (issued
//      plans are tracked in a module-private WeakSet, which casting cannot
//      forge), and construction IS the admissibility preflight. Holding a
//      plan means the preflight ran.
//
// A plan is a point-in-time admission: the engine still re-asserts
// immediately before source access to close revocation races. Evidence
// adapters here RESOLVE and READ only — action authority (sending, writing,
// posting) is a separate contract owned by tool executors and their guards.
// See docs/architecture/evidence-and-action-authority.md.

import type { SourceAdapter } from "./adapters";
import type { SourceBinding, SourceRequirement } from "./types";
import { checkAgentSourceReadiness, SourceReadinessError } from "./validation";

declare const planBrand: unique symbol;

/**
 * Admitted sources for one run: secret-free requirements, this owner's
 * runtime-private bindings, and the adapters able to read them. Only
 * `prepareSourceExecution()` / `noSourcePlan()` can create one.
 */
export type SourceExecutionPlan = {
  readonly requirements: readonly SourceRequirement[];
  readonly bindings: readonly SourceBinding[];
  readonly adapters: readonly SourceAdapter[];
  /** Nominal brand. Never assigned; blocks structural construction in TS. */
  readonly [planBrand]?: never;
};

const issuedPlans = new WeakSet<object>();

export function sourceAdapterCapabilities(
  adapters: readonly SourceAdapter[],
) {
  const adapterIds = new Set<string>();
  for (const adapter of adapters) {
    if (adapterIds.has(adapter.id)) {
      throw new Error(
        `Source adapter id '${adapter.id}' is registered more than once.`,
      );
    }
    adapterIds.add(adapter.id);
  }
  return adapters.map((adapter) => ({
    ...adapter.capabilities,
    // `SourceAdapter.id` is the executable lookup key. Do not trust a
    // separately-authored descriptor id to make readiness pass for an adapter
    // the execution path cannot actually find.
    adapterId: adapter.id,
  }));
}

/**
 * Host-independent admissibility gate: reject missing, revoked, incompatible,
 * or unsupported sources before transcription, RAG, LLM calls, or tools can
 * spend money or cause side effects. Runs at plan construction and again in
 * the engine immediately before source access (revocation races).
 */
export function assertBoundSourcePreflight(
  requirements: readonly SourceRequirement[],
  bindings: readonly SourceBinding[],
  adapters: readonly SourceAdapter[],
): void {
  if (requirements.length === 0) return;
  const runtimeAdapterCapabilities = sourceAdapterCapabilities(adapters);

  // An on-run source is allowed to arrive stale: synchronization is the thing
  // that makes it fresh. Preflight every OTHER contract dimension first, then
  // refresh, then run the complete readiness check against the observed state.
  const onRunIds = new Set(
    requirements
      .filter((requirement) => requirement.freshness?.mode === "on-run")
      .map((requirement) => requirement.id),
  );
  const preflightRequirements = requirements.map((requirement) => {
    if (requirement.freshness?.mode !== "on-run") return requirement;
    const { maxAgeSeconds: _ignored, ...freshness } = requirement.freshness;
    return { ...requirement, freshness };
  });
  const preflightBindings = bindings.map((binding) =>
    onRunIds.has(binding.sourceId) && binding.status === "stale"
      ? { ...binding, status: "ready" as const }
      : binding,
  );
  const preflight = checkAgentSourceReadiness(
    { sources: preflightRequirements },
    {
      bindings: preflightBindings,
      adapters: runtimeAdapterCapabilities,
    },
  );
  if (!preflight.ready) throw new SourceReadinessError(preflight);
}

/**
 * Build the admission ticket for a run. Runs the required-source
 * admissibility preflight at construction — a `SourceReadinessError` here
 * means the run was refused before any model call, with named issues.
 */
export function prepareSourceExecution(input: {
  requirements?: readonly SourceRequirement[];
  bindings?: readonly SourceBinding[];
  adapters?: readonly SourceAdapter[];
}): SourceExecutionPlan {
  const requirements = Object.freeze([...(input.requirements ?? [])]);
  const bindings = Object.freeze([...(input.bindings ?? [])]);
  const adapters = Object.freeze([...(input.adapters ?? [])]);
  assertBoundSourcePreflight(requirements, bindings, adapters);
  const plan = Object.freeze({ requirements, bindings, adapters });
  issuedPlans.add(plan);
  return plan;
}

/**
 * The explicit "this run uses no declared sources" statement, for embedders
 * and workers without source requirements. Deliberately a function call, not
 * an optional field: silence is not a decision.
 */
export function noSourcePlan(): SourceExecutionPlan {
  return prepareSourceExecution({});
}

/**
 * Engine-side check that a plan came from `prepareSourceExecution()`.
 * Returns the plan for destructuring convenience.
 */
export function assertSourceExecutionPlan(
  plan: SourceExecutionPlan,
): SourceExecutionPlan {
  if (
    typeof plan !== "object" ||
    plan === null ||
    !issuedPlans.has(plan)
  ) {
    throw new Error(
      "runAgent requires a SourceExecutionPlan created by prepareSourceExecution() or noSourcePlan(). " +
        "Hand-built or cast plans are rejected: plan construction is where the required-source " +
        "admissibility preflight runs, and accepting an unissued plan would allow a run whose " +
        "evidence was never verified.",
    );
  }
  return plan;
}
