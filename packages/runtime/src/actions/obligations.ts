import type {
  ActionEffectDefinition,
  ActionVerificationMode,
  RunActionReceipt,
} from "./types";

export type CapabilityOperationEffect =
  | "read"
  | "write"
  | "execute"
  | "communicate";

export type RequiredCapabilityObligation = {
  requirementId: string;
  requirement: string;
  toolName: string;
  operationEffect: CapabilityOperationEffect;
  action: ActionEffectDefinition;
  /** A normal tool result proves reads/computation; external effects need an action envelope. */
  effectful: boolean;
};

type ToolWithEffect = {
  name: string;
  effect?: ActionEffectDefinition;
};

function planResolutions(plan: unknown): Array<Record<string, unknown>> {
  if (!plan || typeof plan !== "object") return [];
  const value = plan as {
    resolutions?: unknown;
    capabilities?: { resolutions?: unknown };
  };
  const candidate = Array.isArray(value.resolutions)
    ? value.resolutions
    : Array.isArray(value.capabilities?.resolutions)
      ? value.capabilities.resolutions
      : [];
  return candidate.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object",
  );
}

function operationEffect(value: unknown): CapabilityOperationEffect | null {
  return value === "read" ||
    value === "write" ||
    value === "execute" ||
    value === "communicate"
    ? value
    : null;
}

/**
 * Compile a portable capability plan into run-scoped proof obligations.
 *
 * This is intentionally provider-neutral. A read/computation is proved by a
 * successful invocation of the exact registered tool. A write/communication
 * is only proved by the tool's trusted ActionEffectDefinition and executor
 * receipt. Stale plans that call a critical operation "supported" while the
 * host has no matching tool fail closed instead of silently becoming Done.
 */
export function requiredCapabilityObligations(
  plan: unknown,
  tools: readonly ToolWithEffect[],
): RequiredCapabilityObligation[] {
  const registered = new Map(tools.map((tool) => [tool.name, tool]));
  const seen = new Set<string>();
  const obligations: RequiredCapabilityObligation[] = [];

  for (const resolution of planResolutions(plan)) {
    if (resolution.status !== "supported" || resolution.path !== "execute")
      continue;
    if (resolution.coveredBy || resolution.critical === false) continue;
    const requirementId =
      typeof resolution.requirementId === "string"
        ? resolution.requirementId.trim()
        : "";
    const requirement =
      typeof resolution.requirement === "string"
        ? resolution.requirement.trim()
        : "";
    const toolName =
      typeof resolution.tool === "string" ? resolution.tool.trim() : "";
    if (!requirementId || !requirement || !toolName) continue;
    if (toolName === "runtime.reason" || toolName.startsWith("trigger:"))
      continue;
    if (seen.has(requirementId)) continue;

    const tool = registered.get(toolName);
    const declaredEffect = operationEffect(resolution.effect);
    const effect = declaredEffect ?? (tool?.effect ? "write" : null);
    // Older plans did not carry `effect`. A registered effectful tool is still
    // unambiguous; an absent, untyped tool is left to the existing capability
    // grounding because treating it as a required mutation would be a guess.
    if (!effect) continue;

    const effectful = effect === "write" || effect === "communicate";
    const verification: ActionVerificationMode = effectful
      ? (tool?.effect?.verification ?? "unavailable")
      : "synchronous";
    const action: ActionEffectDefinition = tool?.effect ?? {
      provider: effectful ? "unbound" : "runtime",
      operation:
        typeof resolution.operationId === "string"
          ? resolution.operationId
          : toolName,
      requiredProof: "postcondition_verified",
      verification,
      required: true,
    };

    seen.add(requirementId);
    obligations.push({
      requirementId,
      requirement,
      toolName,
      operationEffect: effect,
      action,
      effectful,
    });
  }

  return obligations;
}

export function isCapabilityObligation(
  action: Pick<RunActionReceipt, "metadata">,
): boolean {
  return action.metadata?.kind === "capability_obligation";
}
