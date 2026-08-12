import {
  parseAgentExecutableCapability,
  verifyExecutableCapabilityDigest,
  type AgentExecutableCapabilityV1,
} from "../../capabilities/executable-capability";
import {
  parseAgentSkillProofAttestation,
  type AgentSkillProofAttestationV2,
} from "../../format/agent-file";
import type { InlineToolDefinition } from "../types";
import type {
  ToolExecutionContext,
  ToolExecutor,
  ToolRegistry,
} from "../registry";

export const capabilityExecuteDefinition: InlineToolDefinition = {
  type: "inline",
  name: "capability.execute",
  description:
    "Execute one verified reusable capability with NEW JSON input. Call use_skill first, then pass the current request's normalized values as payload. The host verifies the artifact digest and local trust before any sandbox runs; an imported file cannot authorize its own code.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Verified capability name returned by use_skill.",
      },
      payload: {
        type: "object",
        additionalProperties: true,
        description:
          "JSON input built from the CURRENT request. Never reuse a verification example's values.",
      },
    },
    required: ["name", "payload"],
    additionalProperties: false,
  },
};

export type CapabilityExecuteInput = {
  name: string;
  payload: Record<string, unknown>;
};

export type CapabilityExecuteResult = {
  capability: string;
  artifactDigest: string;
  sandbox: string;
  output: unknown;
};

export interface CapabilityExecutionSandbox {
  readonly id: string;
  execute(input: {
    artifact: AgentExecutableCapabilityV1;
    payload: unknown;
    context: ToolExecutionContext;
  }): Promise<unknown>;
}

type ExecutableSkill = {
  name: string;
  proof: AgentSkillProofAttestationV2;
  executable: AgentExecutableCapabilityV1;
};

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeName(value: string): string {
  return value.trim().normalize("NFKC").toLowerCase();
}

function boundedJson(value: unknown, label: string, max: number): void {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON-serializable`);
  }
  if (encoded === undefined || encoded.length > max) {
    throw new Error(`${label} is missing or exceeds ${max} characters`);
  }
}

function valueMatchesSchema(
  value: unknown,
  schema: Record<string, unknown>,
  depth = 0,
): boolean {
  if (depth > 12) return false;
  const alternatives = Array.isArray(schema.anyOf)
    ? schema.anyOf.filter(
        (candidate): candidate is Record<string, unknown> =>
          Boolean(candidate) &&
          typeof candidate === "object" &&
          !Array.isArray(candidate),
      )
    : [];
  if (alternatives.length > 0) {
    return alternatives.some((candidate) =>
      valueMatchesSchema(value, candidate, depth + 1),
    );
  }
  switch (schema.type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "string":
      return typeof value === "string";
    case "array": {
      if (!Array.isArray(value)) return false;
      const items = object(schema.items);
      return (
        !items ||
        value.every((item) => valueMatchesSchema(item, items, depth + 1))
      );
    }
    case "object": {
      const candidate = object(value);
      if (!candidate) return false;
      const properties = object(schema.properties) ?? {};
      const required = Array.isArray(schema.required)
        ? schema.required.filter(
            (key): key is string => typeof key === "string",
          )
        : [];
      if (required.some((key) => !(key in candidate))) return false;
      if (
        schema.additionalProperties === false &&
        Object.keys(candidate).some((key) => !(key in properties))
      ) {
        return false;
      }
      return Object.entries(properties).every(([key, nested]) => {
        if (!(key in candidate)) return true;
        const nestedSchema = object(nested);
        return (
          Boolean(nestedSchema) &&
          valueMatchesSchema(candidate[key], nestedSchema!, depth + 1)
        );
      });
    }
    default:
      return Object.keys(schema).length === 0;
  }
}

/**
 * Accept both the public .agent skill shape and AgentMug's private blueprint
 * materialization. This is shape normalization only: trust is supplied
 * separately by the host through trustedArtifactDigests.
 */
export function executableSkillsFromUnknown(raw: unknown): ExecutableSkill[] {
  if (!Array.isArray(raw)) return [];
  const skills: ExecutableSkill[] = [];
  for (const candidate of raw) {
    const skill = object(candidate);
    if (!skill || typeof skill.name !== "string" || !skill.name.trim()) {
      continue;
    }
    const verification = object(skill.verification);
    const locallyVerified =
      skill.verified === true || verification?.status === "verified";
    if (!locallyVerified) continue;
    const rawProof = skill.proof ?? verification?.taskProofAttestation;
    const rawExecutable =
      skill.executable ?? verification?.executableCapability;
    try {
      const proof = parseAgentSkillProofAttestation(rawProof);
      if (proof.version !== 2 || proof.reusableInputVerified !== true) continue;
      const executable = parseAgentExecutableCapability(rawExecutable);
      if (proof.artifactDigest !== executable.digest) continue;
      skills.push({ name: skill.name.trim(), proof, executable });
    } catch {
      // Invalid/legacy skills stay readable as recipes but are not executable.
    }
  }
  return skills;
}

/**
 * Normalize the explicit .agent v2 capsule boundary. Unlike private blueprint
 * skills, capsules never claim local verification: the executor's separate
 * trustedArtifactDigests input remains the only authority gate.
 */
export function executableCapabilitiesFromCapsules(
  raw: unknown,
): ExecutableSkill[] {
  if (!Array.isArray(raw)) return [];
  const capabilities: ExecutableSkill[] = [];
  for (const candidate of raw) {
    const capsule = object(candidate);
    if (
      !capsule ||
      capsule.version !== 1 ||
      typeof capsule.name !== "string" ||
      !capsule.name.trim()
    ) {
      continue;
    }
    try {
      const proof = parseAgentSkillProofAttestation(capsule.proof);
      if (proof.version !== 2 || proof.reusableInputVerified !== true) continue;
      const executable = parseAgentExecutableCapability(capsule.artifact);
      if (proof.artifactDigest !== executable.digest) continue;
      capabilities.push({ name: capsule.name.trim(), proof, executable });
    } catch {
      // Invalid capsules stay inspectable at the file boundary, never runnable.
    }
  }
  return capabilities;
}

export type CapabilityExecuteExecutorOptions = {
  /** Private, locally verified blueprint skills (cloud control plane). */
  skills?: unknown;
  /** Portable .agent v2 evidence. Always untrusted unless this host re-verifies it. */
  capabilityCapsules?: unknown;
  /** A sandbox is necessary but not sufficient: the digest must be trusted. */
  sandbox?: CapabilityExecutionSandbox;
  /** Digests re-verified or minted by this host's trusted control plane. */
  trustedArtifactDigests?: Iterable<string>;
};

export class CapabilityExecuteExecutor implements ToolExecutor {
  private readonly skills = new Map<string, ExecutableSkill>();
  private readonly trustedDigests: Set<string>;

  constructor(private readonly options: CapabilityExecuteExecutorOptions) {
    for (const skill of [
      ...executableSkillsFromUnknown(options.skills),
      ...executableCapabilitiesFromCapsules(options.capabilityCapsules),
    ]) {
      this.skills.set(normalizeName(skill.name), skill);
    }
    this.trustedDigests = new Set(options.trustedArtifactDigests ?? []);
  }

  async execute(
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<CapabilityExecuteResult> {
    const parsed = object(input);
    const name = typeof parsed?.name === "string" ? parsed.name.trim() : "";
    if (!name || name.length > 100 || !("payload" in (parsed ?? {}))) {
      throw new Error(
        "capability.execute requires a capability name and the current JSON payload",
      );
    }
    if (
      !parsed!.payload ||
      typeof parsed!.payload !== "object" ||
      Array.isArray(parsed!.payload)
    ) {
      throw new Error("capability.execute payload must be a JSON object");
    }
    boundedJson(parsed!.payload, "Capability payload", 64_000);
    const skill = this.skills.get(normalizeName(name));
    if (!skill) {
      throw new Error(
        `Capability '${name}' is not locally verified with an executable artifact`,
      );
    }

    // Re-parse and hash at the final execution boundary. A DB/file mutation
    // after registry construction therefore cannot smuggle different source.
    const artifact = await verifyExecutableCapabilityDigest(skill.executable);
    if (skill.proof.artifactDigest !== artifact.digest) {
      throw new Error("Capability proof is not bound to this artifact digest");
    }
    if (!valueMatchesSchema(parsed!.payload, artifact.contract.inputSchema)) {
      throw new Error(
        "Capability payload does not match the verified input contract",
      );
    }
    if (!this.trustedDigests.has(artifact.digest)) {
      throw new Error(
        "Capability execution is blocked on this host until the artifact is locally re-verified",
      );
    }
    if (!this.options.sandbox) {
      throw new Error(
        "Capability execution is unavailable on this host because no isolated no-network sandbox is configured",
      );
    }
    const output = await this.options.sandbox.execute({
      artifact,
      payload: parsed!.payload,
      context,
    });
    boundedJson(output, "Capability output", 64_000);
    if (!valueMatchesSchema(output, artifact.contract.outputSchema)) {
      throw new Error(
        "Capability sandbox output does not match the verified output contract",
      );
    }
    return {
      capability: skill.name,
      artifactDigest: artifact.digest,
      sandbox: this.options.sandbox.id,
      output,
    };
  }
}

export function registerCapabilityExecutionTool(
  registry: ToolRegistry,
  options: CapabilityExecuteExecutorOptions,
): { executableCount: number } {
  const executableCount = new Set([
    ...executableSkillsFromUnknown(options.skills).map((skill) =>
      normalizeName(skill.name),
    ),
    ...executableCapabilitiesFromCapsules(options.capabilityCapsules).map(
      (skill) => normalizeName(skill.name),
    ),
  ]).size;
  registry.register(
    capabilityExecuteDefinition,
    new CapabilityExecuteExecutor(options),
  );
  return { executableCount };
}
