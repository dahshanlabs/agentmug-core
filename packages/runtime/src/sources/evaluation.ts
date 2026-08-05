import type {
  EvaluationCheck,
  EvaluationContract,
  ReceiptApproval,
  ReceiptEvaluation,
  ReceiptSourceWrite,
  SourceBinding,
  SourceRequirement,
  StructuredCitation,
} from "./types";

export type PortableEvaluationContext = {
  contract: EvaluationContract;
  phases: readonly EvaluationCheck["phase"][];
  requirements: readonly SourceRequirement[];
  bindings: readonly SourceBinding[];
  readSourceIds?: readonly string[];
  citations?: readonly StructuredCitation[];
  writes?: readonly ReceiptSourceWrite[];
  output?: string;
};

function result(
  check: EvaluationCheck,
  status: ReceiptEvaluation["status"],
  message: string,
): ReceiptEvaluation {
  return {
    checkId: check.id,
    status,
    ...(status === "passed"
      ? { score: 1 }
      : status === "failed"
        ? { score: 0 }
        : {}),
    message,
  };
}

function checkSourceIds(
  check: EvaluationCheck,
  requirements: readonly SourceRequirement[],
): string[] {
  return check.sourceIds?.length
    ? [...check.sourceIds]
    : requirements
        .filter((source) => source.required)
        .map((source) => source.id);
}

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function validateJsonValue(
  value: unknown,
  schema: unknown,
  path = "$",
  depth = 0,
): string | null {
  if (depth > 12) return `${path} exceeded the supported schema depth.`;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return `${path} uses an unsupported schema node.`;
  }
  const node = schema as Record<string, unknown>;
  if ("const" in node && JSON.stringify(value) !== JSON.stringify(node.const)) {
    return `${path} did not match its required constant.`;
  }
  if (
    Array.isArray(node.enum) &&
    !node.enum.some(
      (candidate) => JSON.stringify(candidate) === JSON.stringify(value),
    )
  ) {
    return `${path} was not one of the allowed values.`;
  }

  const allowedTypes = Array.isArray(node.type)
    ? node.type.filter((item): item is string => typeof item === "string")
    : typeof node.type === "string"
      ? [node.type]
      : [];
  const actualType = jsonType(value);
  const typeMatches =
    allowedTypes.length === 0 ||
    allowedTypes.includes(actualType) ||
    (actualType === "integer" && allowedTypes.includes("number"));
  if (!typeMatches) {
    return `${path} must be ${allowedTypes.join(" or ")}; received ${actualType}.`;
  }

  if (typeof value === "string") {
    if (typeof node.minLength === "number" && value.length < node.minLength) {
      return `${path} is shorter than minLength ${node.minLength}.`;
    }
    if (typeof node.maxLength === "number" && value.length > node.maxLength) {
      return `${path} is longer than maxLength ${node.maxLength}.`;
    }
  }
  if (typeof value === "number") {
    if (typeof node.minimum === "number" && value < node.minimum) {
      return `${path} is below minimum ${node.minimum}.`;
    }
    if (typeof node.maximum === "number" && value > node.maximum) {
      return `${path} is above maximum ${node.maximum}.`;
    }
  }
  if (Array.isArray(value)) {
    if (typeof node.minItems === "number" && value.length < node.minItems) {
      return `${path} has fewer than ${node.minItems} items.`;
    }
    if (typeof node.maxItems === "number" && value.length > node.maxItems) {
      return `${path} has more than ${node.maxItems} items.`;
    }
    if (node.items !== undefined) {
      for (let index = 0; index < value.length; index += 1) {
        const issue = validateJsonValue(
          value[index],
          node.items,
          `${path}[${index}]`,
          depth + 1,
        );
        if (issue) return issue;
      }
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties =
      node.properties &&
      typeof node.properties === "object" &&
      !Array.isArray(node.properties)
        ? (node.properties as Record<string, unknown>)
        : {};
    const required = Array.isArray(node.required)
      ? node.required.filter((item): item is string => typeof item === "string")
      : [];
    for (const key of required) {
      if (!(key in record)) return `${path}.${key} is required.`;
    }
    if (node.additionalProperties === false) {
      const unknown = Object.keys(record).find((key) => !(key in properties));
      if (unknown) return `${path}.${unknown} is not allowed.`;
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (!(key in record)) continue;
      const issue = validateJsonValue(
        record[key],
        childSchema,
        `${path}.${key}`,
        depth + 1,
      );
      if (issue) return issue;
    }
  }
  return null;
}

function evaluateCheck(
  check: EvaluationCheck,
  context: PortableEvaluationContext,
): ReceiptEvaluation {
  const sourceIds = checkSourceIds(check, context.requirements);
  const readSourceIds = new Set(context.readSourceIds ?? []);
  if (check.type === "source-ready") {
    if (sourceIds.length === 0) {
      return result(
        check,
        "skipped",
        "Source-readiness check did not resolve a source.",
      );
    }
    const missing = sourceIds.filter((sourceId) => {
      const binding = context.bindings.find(
        (item) => item.sourceId === sourceId,
      );
      return (
        !binding || (binding.status !== "ready" && !readSourceIds.has(sourceId))
      );
    });
    return missing.length === 0
      ? result(
          check,
          "passed",
          "Every declared source for this check was admitted by this host.",
        )
      : result(
          check,
          "failed",
          `Source readiness was not proven for: ${missing.join(", ")}.`,
        );
  }
  if (check.type === "freshness") {
    if (sourceIds.length === 0) {
      return result(
        check,
        "skipped",
        "Freshness check did not resolve a source.",
      );
    }
    const stale = sourceIds.filter((sourceId) => {
      const binding = context.bindings.find(
        (item) => item.sourceId === sourceId,
      );
      return (
        !binding || (binding.status !== "ready" && !readSourceIds.has(sourceId))
      );
    });
    return stale.length === 0
      ? result(
          check,
          "passed",
          "Freshness was admitted or synchronized by this host.",
        )
      : result(
          check,
          "failed",
          `Freshness was not proven for: ${stale.join(", ")}.`,
        );
  }
  if (check.type === "citation") {
    if (sourceIds.length === 0) {
      return result(check, "skipped", "Citation check did not name a source.");
    }
    const cited = new Set(
      (context.citations ?? []).map((citation) => citation.sourceRequirementId),
    );
    const missing = sourceIds.filter((sourceId) => !cited.has(sourceId));
    return missing.length === 0
      ? result(
          check,
          "passed",
          "The output cited every source required by this check.",
        )
      : result(
          check,
          "failed",
          `The output did not cite: ${missing.join(", ")}.`,
        );
  }
  if (check.type === "write-boundary") {
    if (sourceIds.length === 0) {
      return result(
        check,
        "skipped",
        "Write-boundary check did not name an allowed source.",
      );
    }
    const allowed = new Set(sourceIds);
    const outside = (context.writes ?? [])
      .filter((write) => !allowed.has(write.sourceId))
      .map((write) => write.sourceId);
    return outside.length === 0
      ? result(
          check,
          "passed",
          "No recorded source write crossed the declared boundary.",
        )
      : result(
          check,
          "failed",
          `Recorded writes crossed the boundary: ${[...new Set(outside)].join(", ")}.`,
        );
  }
  if (check.type === "output-schema") {
    const schema = check.config?.schema;
    if (!schema) {
      return result(
        check,
        "skipped",
        "Output-schema check has no config.schema declaration.",
      );
    }
    if (context.output === undefined) {
      return result(
        check,
        "skipped",
        "Output-schema check can run only after output exists.",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(context.output);
    } catch {
      return result(check, "failed", "Output was not valid JSON.");
    }
    const issue = validateJsonValue(parsed, schema);
    return issue
      ? result(check, "failed", issue)
      : result(
          check,
          "passed",
          "Output matched the declared JSON schema subset.",
        );
  }
  return result(
    check,
    "skipped",
    "This prose-only check needs a host-specific deterministic evaluator or an owner-private regression case.",
  );
}

export function evaluatePortableChecks(
  context: PortableEvaluationContext,
): ReceiptEvaluation[] {
  const phases = new Set(context.phases);
  return context.contract.checks
    .filter((check) => phases.has(check.phase))
    .map((check) => evaluateCheck(check, context));
}

export function portableEvaluationPolicyFailure(options: {
  contract: EvaluationContract;
  evaluations: readonly ReceiptEvaluation[];
  approvals?: readonly ReceiptApproval[];
  includeMinimumScore?: boolean;
}): { message: string; minimumScoreEvaluation?: ReceiptEvaluation } | null {
  const {
    contract,
    evaluations,
    approvals = [],
    includeMinimumScore = false,
  } = options;
  const approved = new Set(
    approvals
      .filter((approval) => approval.decision === "approved")
      .map((approval) => approval.action),
  );
  const checkById = new Map(contract.checks.map((check) => [check.id, check]));
  const blockers = evaluations.filter((evaluation) => {
    const check = checkById.get(evaluation.checkId);
    return (
      check?.severity === "error" &&
      evaluation.status !== "passed" &&
      !approved.has(`evaluation:${evaluation.checkId}`)
    );
  });

  let minimumScoreEvaluation: ReceiptEvaluation | undefined;
  if (includeMinimumScore && contract.minimumScore !== undefined) {
    const scored = evaluations.filter(
      (evaluation) =>
        checkById.has(evaluation.checkId) &&
        evaluation.status !== "skipped" &&
        typeof evaluation.score === "number",
    );
    const aggregate =
      scored.length === 0
        ? 0
        : scored.reduce((sum, evaluation) => sum + (evaluation.score ?? 0), 0) /
          scored.length;
    minimumScoreEvaluation = {
      checkId: "contract:minimum-score",
      status: aggregate >= contract.minimumScore ? "passed" : "failed",
      score: aggregate,
      message: `Portable check score ${Math.round(aggregate * 100)}%; required ${Math.round(contract.minimumScore * 100)}%.`,
    };
    if (
      minimumScoreEvaluation.status === "failed" &&
      !approved.has("evaluation:contract:minimum-score")
    ) {
      blockers.push(minimumScoreEvaluation);
    }
  }

  if (blockers.length === 0 || contract.failurePolicy === "warn") {
    return minimumScoreEvaluation
      ? { message: "", minimumScoreEvaluation }
      : null;
  }
  const ids = blockers.map((evaluation) => evaluation.checkId).join(", ");
  return {
    message:
      contract.failurePolicy === "require-approval"
        ? `Portable checks require explicit approval before this run can continue: ${ids}.`
        : `Portable checks blocked this run: ${ids}.`,
    minimumScoreEvaluation,
  };
}
