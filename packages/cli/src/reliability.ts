export type CloudReliabilityRun = {
  id: string;
  agentId: string;
  trigger: "manual" | "release_gate" | "external";
  status: "running" | "completed" | "failed";
  blueprintVersion?: number;
  aggregateScore?: number;
  passRate?: number;
  casesRun: number;
  error?: string;
  durationMs?: number;
  startedAt: string;
  completedAt?: string;
  createdAt: string;
};

export type CloudReliabilitySummary = {
  safeSimulation: true;
  caseCount: number;
  canRun: boolean;
  latestRun: CloudReliabilityRun | null;
  history: CloudReliabilityRun[];
  privacy: string;
};

function percentage(value: number | undefined): string {
  return typeof value === "number" ? `${Math.round(value * 100)}%` : "n/a";
}

function score(value: number | undefined): string {
  return typeof value === "number" ? `${Math.round(value)}%` : "n/a";
}

export function formatCloudReliabilityRun(run: CloudReliabilityRun): string[] {
  return [
    `status: ${run.status}`,
    `score: ${score(run.aggregateScore)}`,
    `pass rate: ${percentage(run.passRate)}`,
    `cases: ${run.casesRun}`,
    `blueprint: ${run.blueprintVersion ?? "unknown"}`,
    `duration: ${run.durationMs === undefined ? "n/a" : `${run.durationMs}ms`}`,
    `completed: ${run.completedAt ?? "not completed"}`,
    ...(run.error ? [`error: ${run.error}`] : []),
  ];
}

export function formatCloudReliabilitySummary(
  summary: CloudReliabilitySummary,
): string[] {
  return [
    "Cloud reliability",
    `  protected cases: ${summary.caseCount}`,
    `  safe check available: ${summary.canRun ? "yes" : "no"}`,
    ...(summary.latestRun
      ? formatCloudReliabilityRun(summary.latestRun).map(
          (line) => `  latest ${line}`,
        )
      : ["  latest: no completed or attempted check yet"]),
    "  boundary: safe simulation only; no live connected tools are called",
    `  privacy: ${summary.privacy}`,
    "  scope: this checks the hosted worker, not a locally modified .agent file",
  ];
}

export function evaluationCounts(
  evaluations: ReadonlyArray<{ status: "passed" | "failed" | "skipped" }>,
) {
  return evaluations.reduce(
    (counts, evaluation) => {
      counts[evaluation.status] += 1;
      return counts;
    },
    { passed: 0, failed: 0, skipped: 0 },
  );
}
