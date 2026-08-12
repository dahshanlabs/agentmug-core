export type UsageCostTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
};

export type UsageCostDelta = Required<UsageCostTotals>;

/**
 * Return only usage introduced by the current retry/resume segment. Provider
 * counters in a paused snapshot are cumulative, so charging the raw totals on
 * every continuation would bill the same tokens more than once.
 */
export function usageCostDelta(
  totals: UsageCostTotals,
  prior: UsageCostTotals,
): UsageCostDelta {
  return {
    inputTokens: Math.max(0, totals.inputTokens - prior.inputTokens),
    outputTokens: Math.max(0, totals.outputTokens - prior.outputTokens),
    cacheReadTokens: Math.max(
      0,
      (totals.cacheReadTokens ?? 0) - (prior.cacheReadTokens ?? 0),
    ),
    cacheCreationTokens: Math.max(
      0,
      (totals.cacheCreationTokens ?? 0) - (prior.cacheCreationTokens ?? 0),
    ),
  };
}
