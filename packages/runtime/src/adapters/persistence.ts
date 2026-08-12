// Abstract persistence interface used by the engine.
//
// The runtime never imports a database driver. Each deployment target
// (cloud Postgres, desktop SQLite, self-hosted Docker) provides its own
// implementation of this interface.

import type { MissingConnection } from "../connection-grounding";
import type { RunActionReceipt, RunOutcomeStatus } from "../actions/types";
import type { EvaluationContract } from "../sources/types";

export type AgentRecord = {
  id: string;
  name: string;
  description: string;
};

export type BlueprintRecord = {
  systemPrompt: string;
  primaryModel: string | null;
  /**
   * Promises this worker was created with that nothing available can keep.
   *
   * Creation does not block any more — a worker with one unprovable promise
   * still keeps the others — so these travel with the worker and become hard
   * refusals in its prompt (buildRefusalDirective). Without them the model
   * improvises and implies the deed was done, which is worse than the refused
   * draft this replaced. Absent/empty on workers with nothing unkeepable.
   */
  unkeepablePromises?: string[] | null;
  /**
   * Optional per-agent output token cap. The engine clamps it to a sane
   * range and falls back to its default (8192) when null/absent. Lets a
   * long-form agent ask for more headroom (or a terse one save cost)
   * without a code change. Travels in the .agent file's blueprint.
   */
  maxTokens?: number | null;
  /**
   * Optional Anthropic extended-thinking budget (tokens). When set, the
   * engine enables extended thinking on Anthropic models with this budget
   * (clamped). Absent/null = thinking off (default). Ignored by non-Anthropic
   * models. Travels in the .agent file's blueprint.
   */
  extendedThinkingBudget?: number | null;
  /**
   * Secret-free checks that travel with the `.agent` blueprint. Hosts may
   * keep richer private regression suites separately, but this contract must
   * produce the same receipt outcomes wherever the blueprint runs.
   */
  evaluation?: EvaluationContract;
  /**
   * Secret-free creation contract used to prove that a run exercised every
   * critical capability it promised. The runtime reads this defensively so
   * older or third-party `.agent` files remain compatible.
   */
  capabilityPlan?: unknown;
  /**
   * Per-agent guardrails (jsonb on the blueprint, travels in the .agent file).
   * `sideEffectGate` opts the agent into the same-turn injection backstop:
   * once the run has read UNTRUSTED external content (a2a.invoke, web/email
   * reads, …), a subsequent SIDE-EFFECTING tool (send/post/pay) is gated.
   *   "off" (default/absent) — no gating;
   *   "confirm" — refuse with a message telling the model to confirm via
   *               ask_user before acting;
   *   "refuse"  — refuse outright.
   */
  guardrails?: { sideEffectGate?: "off" | "confirm" | "refuse" } & Record<
    string,
    unknown
  >;
};

/**
 * WHO caused a run. Attribution is recorded on the run row so a stranger's
 * public run, a partner's API call, and the owner's own click are three
 * distinguishable facts instead of one undifferentiated row.
 *   kind            — the doorway the run came through.
 *   initiatorUserId — the concrete signed-in user who caused it, when one
 *                     exists (null/absent for anonymous public runs and
 *                     machine-to-machine calls with no user identity).
 */
export type RunPrincipal = {
  kind:
    | "owner"
    | "marketplace"
    | "public"
    | "external"
    | "a2a"
    | "scheduler"
    | "webhook"
    | "sub_agent";
  initiatorUserId?: string | null;
};

export type NewRun = {
  id: string;
  agentId: string;
  input: string;
  startedAt: Date;
  /** Absent only for hosts that predate attribution (treated as unknown). */
  principal?: RunPrincipal;
};

export type RunCompletion = {
  id: string;
  output: string;
  totalTokens: number;
  costCents: number;
  /** This invocation only; excludes resume snapshot priorTotals. */
  attemptCostCents?: number;
  /** False when an attempted provider call did not return complete usage. */
  attemptUsageExact: boolean;
  latencyMs: number;
  llmCalls: number;
  completedAt: Date;
  /** Real-world outcome, independent from the engine having completed. */
  outcomeStatus?: RunOutcomeStatus;
};

export type RunFailure = {
  id: string;
  output: string;
  /** Usage already incurred before the run failed. Failures are still billable. */
  totalTokens: number;
  costCents: number;
  /** This invocation only; excludes resume snapshot priorTotals. */
  attemptCostCents?: number;
  /** False when an attempted provider call did not return complete usage. */
  attemptUsageExact: boolean;
  latencyMs: number;
  llmCalls: number;
  completedAt: Date;
  outcomeStatus?: RunOutcomeStatus;
};

export type RunPause = {
  id: string;
  question: string;
  hint?: string;
  options?: string[];
  allowOther?: boolean;
  /** Opaque JSON the api-server persists; engine re-reads it on resume. */
  state: unknown;
  pausedAt: Date;
  /** Bookkeeping for the partial run so charts stay accurate. */
  totalTokens: number;
  costCents: number;
  /** This invocation only; excludes resume snapshot priorTotals. */
  attemptCostCents?: number;
  /** False when an attempted provider call did not return complete usage. */
  attemptUsageExact: boolean;
  latencyMs: number;
  llmCalls: number;
};

/**
 * Durable pre-dispatch marker for one primary model invocation. Cloud hosts
 * use this to retain a conservative provider-cost floor when a process dies
 * after dispatch but before the provider can return usage metadata.
 */
export type ProviderCallStart = {
  runId: string;
  callOrdinal: number;
  conservativeCostCents: number;
  startedAt: Date;
};

/** One provider the agent is connected to, with the account label(s) it uses
 *  (e.g. { provider: "Gmail", accounts: ["me@example.com"] }). Feeds the engine's
 *  identity-grounding block so the model never GUESSES an email/identity. */
export type ConnectedAccount = { provider: string; accounts: string[] };

// Re-exported so hosts implementing the adapter can import the shape from the
// same module as the interface itself.
export type { MissingConnection };

export interface PersistenceAdapter {
  getAgent(id: string): Promise<AgentRecord | null>;
  getLatestBlueprint(agentId: string): Promise<BlueprintRecord | null>;
  /**
   * The authoritative accounts this agent operates under (provider → labels),
   * for identity grounding. OPTIONAL — a host that doesn't implement it just
   * gets the "never fabricate an identity" directive without a concrete list.
   */
  getConnectedAccounts?(
    agentId: string,
    userId: string,
  ): Promise<ConnectedAccount[]>;
  /**
   * The providers this agent NEEDS but is not connected to right now, for
   * connection grounding — so a revoked connection becomes a stated gap in the
   * output instead of an ask_user the run stalls on every tick. OPTIONAL: a
   * host that doesn't implement it simply gets no disconnection block.
   */
  getMissingConnections?(
    agentId: string,
    userId: string,
  ): Promise<MissingConnection[]>;
  createRun(run: NewRun): Promise<void>;
  recordProviderCallStarted?(call: ProviderCallStart): Promise<void>;
  completeRun(update: RunCompletion): Promise<void>;
  failRun(update: RunFailure): Promise<void>;
  /**
   * Optional durable action ledger. Implementations must upsert by action id.
   * The engine awaits the initial write before invoking an external effect.
   */
  saveRunAction?(action: RunActionReceipt): Promise<void>;
  /**
   * Mark the run as waiting for a user answer. Used by ask_user.
   * The state is the engine's serialized pause snapshot; the adapter
   * just stores it verbatim and returns it on resume.
   */
  pauseRun?(update: RunPause): Promise<void>;
  incrementAgentRunCount(agentId: string): Promise<void>;
}
