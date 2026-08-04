/**
 * Portable action/outcome contract.
 *
 * A tool call completing is not proof that its real-world effect completed.
 * Executors return a ToolExecutionEnvelope when they perform an external
 * action; the engine persists the action independently from run execution.
 */

export const ACTION_STATUSES = [
  "pending",
  "succeeded",
  "failed",
  "unknown",
] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export const ACTION_PROOFS = [
  "none",
  "accepted",
  "provider_committed",
  "postcondition_verified",
  "delivered",
  "settled",
  "human_confirmed",
] as const;
export type ActionProof = (typeof ACTION_PROOFS)[number];

export type ActionVerificationMode =
  | "synchronous"
  | "callback"
  | "poll"
  | "read_after_write"
  | "manual"
  | "unavailable";

export type RunOutcomeStatus =
  | "pending"
  | "succeeded"
  | "partial"
  | "failed"
  | "unknown";

/** Trusted, declarative metadata attached to a tool definition. */
export type ActionEffectDefinition = {
  provider: string;
  operation: string;
  requiredProof: ActionProof;
  verification: ActionVerificationMode;
  /** Required actions block a run-level "succeeded" outcome. Default true. */
  required?: boolean;
};

/** Outcome supplied by an executor after the provider call returns. */
export type ActionOutcome = {
  status: ActionStatus;
  proof: ActionProof;
  /**
   * Set false only when the executor proves the external effect was never
   * attempted (for example, it paused at an approval gate). This prevents an
   * abandoned intent from poisoning the final outcome after a resumed run.
   */
  required?: boolean;
  providerReference?: string;
  providerAccountReference?: string;
  providerStatus?: string;
  providerStatusRank?: number;
  credentialId?: string;
  /** Safe display label only; never put a raw secret or message body here. */
  target?: string;
  message?: string;
  retryable?: boolean;
  /** Non-secret host metadata used by reconciliation; API views may redact it. */
  metadata?: Record<string, string | number | boolean | null>;
  error?: { code?: string; message: string };
};

/** Durable, portable receipt for one real-world action. */
export type RunActionReceipt = ActionEffectDefinition &
  ActionOutcome & {
    id: string;
    runId: string;
    agentId: string;
    userId: string;
    toolCallId: string;
    toolName: string;
    required: boolean;
    idempotencyKey: string;
    startedAt: string;
    updatedAt: string;
    completedAt?: string;
  };

const ACTION_ENVELOPE_MARKER = "agentmug.action-result.v1" as const;

/**
 * Wrapper used by effectful executors. The engine unwraps `value` for the LLM
 * and keeps `action` as trusted control-plane metadata.
 */
export type ToolExecutionEnvelope<T = unknown> = {
  readonly __agentmug: typeof ACTION_ENVELOPE_MARKER;
  readonly value: T;
  readonly action: ActionOutcome;
};

export function actionResult<T>(
  value: T,
  action: ActionOutcome,
): ToolExecutionEnvelope<T> {
  return { __agentmug: ACTION_ENVELOPE_MARKER, value, action };
}

export function isActionResult(value: unknown): value is ToolExecutionEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ToolExecutionEnvelope>;
  return candidate.__agentmug === ACTION_ENVELOPE_MARKER && !!candidate.action;
}

const PROOF_RANK: Record<ActionProof, number> = {
  none: 0,
  accepted: 10,
  provider_committed: 20,
  postcondition_verified: 30,
  delivered: 40,
  settled: 50,
  human_confirmed: 60,
};

export function proofSatisfies(
  actual: ActionProof,
  required: ActionProof,
): boolean {
  return PROOF_RANK[actual] >= PROOF_RANK[required];
}

/** Conservative run-level aggregation for required actions. */
export function aggregateActionOutcome(
  actions: ReadonlyArray<
    Pick<RunActionReceipt, "required" | "status" | "proof" | "requiredProof">
  >,
): RunOutcomeStatus {
  const required = actions.filter((action) => action.required);
  if (required.length === 0) return "succeeded";

  const states = required.map((action): ActionStatus => {
    if (
      action.status === "succeeded" &&
      !proofSatisfies(action.proof, action.requiredProof)
    ) {
      return "unknown";
    }
    return action.status;
  });
  if (states.every((state) => state === "succeeded")) return "succeeded";
  if (states.some((state) => state === "pending")) return "pending";
  if (states.some((state) => state === "unknown")) return "unknown";
  const succeeded = states.some((state) => state === "succeeded");
  const failed = states.some((state) => state === "failed");
  if (succeeded && failed) return "partial";
  return "failed";
}

/** Combine engine execution with external effects without conflating them. */
export function deriveRunOutcome(
  executionStatus: string,
  actions: ReadonlyArray<
    Pick<RunActionReceipt, "required" | "status" | "proof" | "requiredProof">
  >,
): RunOutcomeStatus {
  const required = actions.filter((action) => action.required);
  const executionSucceeded =
    executionStatus === "completed" || executionStatus === "success";
  const executionLive =
    executionStatus === "running" || executionStatus === "paused";
  if (required.length === 0) {
    if (executionSucceeded) return "succeeded";
    return executionLive ? "pending" : "failed";
  }

  const actionOutcome = aggregateActionOutcome(required);
  if (executionSucceeded) return actionOutcome;
  if (executionLive) return "pending";
  return actionOutcome === "succeeded" ? "partial" : actionOutcome;
}
