import { parseAgentFile, type AgentFileV1 } from "../format/agent-file";

/**
 * Versioned wire contract between the AgentMug control plane and a runner.
 * Keep it in the portable runtime so the producer and consumer cannot drift.
 */
export type DeploymentPromiseV1 = {
  requirementId: string;
  tool?: string;
};

export type DeploymentManifestV1 = {
  version: 1;
  deploymentId: string;
  workerName: string;
  pinnedVersion: number | null;
  artifactDigest: string;
  artifact: AgentFileV1;
  promises: DeploymentPromiseV1[];
};

export type RunnerHeartbeatV1 = {
  runtimeVersion: string;
  runnerKind: string;
  label?: string;
  tools: string[];
  artifactDigest: string | null;
  /** Host-computed readiness fact; the registry still computes final parity. */
  ready: boolean;
  /** Stable codes only — never error text, credentials, prompts, or run data. */
  readinessIssues: string[];
  lastRunAt?: string;
};

function canonicalValue(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON cannot contain non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value))
      throw new TypeError("Canonical JSON cannot contain cycles");
    seen.add(value);
    const result = `[${value
      .map((item) =>
        item === undefined ||
        typeof item === "function" ||
        typeof item === "symbol"
          ? "null"
          : canonicalValue(item, seen),
      )
      .join(",")}]`;
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (seen.has(value))
      throw new TypeError("Canonical JSON cannot contain cycles");
    seen.add(value);
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .sort()
      .filter((key) => {
        const item = record[key];
        return (
          item !== undefined &&
          typeof item !== "function" &&
          typeof item !== "symbol"
        );
      })
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalValue(record[key], seen)}`,
      );
    seen.delete(value);
    return `{${members.join(",")}}`;
  }
  throw new TypeError(`Canonical JSON cannot contain ${typeof value}`);
}

/** Stable JSON independent of object insertion order or Postgres jsonb ordering. */
export function canonicalJson(value: unknown): string {
  return canonicalValue(value, new Set());
}

/** SHA-256 identity for an exact `.agent` artifact. */
export async function deploymentArtifactDigest(
  value: AgentFileV1,
): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Deployment manifest ${field} must be a non-empty string`);
  }
  return value;
}

/** Fail-closed parser for registry data received over the network. */
export function parseDeploymentManifest(value: unknown): DeploymentManifestV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Deployment manifest must be an object");
  }
  const manifest = value as Record<string, unknown>;
  if (manifest.version !== 1) {
    throw new Error(
      `Unsupported deployment manifest version: ${String(manifest.version)}`,
    );
  }
  const deploymentId = nonEmptyString(manifest.deploymentId, "deploymentId");
  const workerName = nonEmptyString(manifest.workerName, "workerName");
  const artifactDigest = nonEmptyString(
    manifest.artifactDigest,
    "artifactDigest",
  );
  if (!/^[a-f0-9]{64}$/.test(artifactDigest)) {
    throw new Error(
      "Deployment manifest artifactDigest must be a SHA-256 hex digest",
    );
  }
  const pinnedVersion = manifest.pinnedVersion;
  if (
    pinnedVersion !== null &&
    (!Number.isInteger(pinnedVersion) || Number(pinnedVersion) < 1)
  ) {
    throw new Error(
      "Deployment manifest pinnedVersion must be a positive integer or null",
    );
  }
  if (!Array.isArray(manifest.promises)) {
    throw new Error("Deployment manifest promises must be an array");
  }
  const promises = manifest.promises.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(
        `Deployment manifest promises[${index}] must be an object`,
      );
    }
    const promise = item as Record<string, unknown>;
    const requirementId = nonEmptyString(
      promise.requirementId,
      `promises[${index}].requirementId`,
    );
    if (promise.tool !== undefined && typeof promise.tool !== "string") {
      throw new Error(
        `Deployment manifest promises[${index}].tool must be a string`,
      );
    }
    return {
      requirementId,
      ...(typeof promise.tool === "string" && promise.tool
        ? { tool: promise.tool }
        : {}),
    };
  });
  return {
    version: 1,
    deploymentId,
    workerName,
    pinnedVersion: pinnedVersion as number | null,
    artifactDigest,
    artifact: parseAgentFile(manifest.artifact),
    promises,
  };
}
