/**
 * Portable executable-capability artifact.
 *
 * The artifact is data, not authority. A host MUST verify the digest and apply
 * its own trust decision before handing the source to a real sandbox. This is
 * what lets a capability travel in a .agent file without letting an arbitrary
 * imported file grant itself permission to execute code.
 */

export const EXECUTABLE_CAPABILITY_KIND = "portable_python_v1" as const;
export const EXECUTABLE_CAPABILITY_POLICY =
  "deterministic-transform-v1" as const;

export type AgentExecutableCapabilityV1 = {
  version: 1;
  kind: typeof EXECUTABLE_CAPABILITY_KIND;
  language: "python";
  entrypoint: "run";
  policy: typeof EXECUTABLE_CAPABILITY_POLICY;
  source: string;
  /** SHA-256 over executableCapabilityDigestMaterial(artifact). */
  digest: `sha256:${string}`;
  contract: {
    /** Value-free JSON Schema inferred from the verified fixture. */
    inputSchema: Record<string, unknown>;
    /** Value-free JSON Schema inferred from the verified result. */
    outputSchema: Record<string, unknown>;
  };
  permissions: {
    network: false;
    secrets: [];
    filesystemWrites: false;
  };
};

export type UnsignedAgentExecutableCapabilityV1 = Omit<
  AgentExecutableCapabilityV1,
  "digest"
>;

export type PortableCapabilityPolicyCheck = {
  code: string;
  passed: boolean;
  note: string;
};

const MAX_SOURCE_CHARS = 12_000;
const MAX_SCHEMA_CHARS = 16_000;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;

const ALLOWED_PYTHON_IMPORTS = new Set([
  "calendar",
  "collections",
  "copy",
  "csv",
  "dataclasses",
  "datetime",
  "decimal",
  "enum",
  "fractions",
  "functools",
  "itertools",
  "json",
  "math",
  "operator",
  "re",
  "statistics",
  "string",
  "typing",
  "unicodedata",
]);

const DENIED_SOURCE: Array<{
  code: string;
  label: string;
  pattern: RegExp;
}> = [
  {
    code: "no_network",
    label: "Network access is denied",
    pattern:
      /\b(requests|urllib|httpx|aiohttp|socket|ftplib|smtplib|telnetlib)\b|https?:\/\//i,
  },
  {
    code: "no_process",
    label: "Processes and shell commands are denied",
    pattern: /\b(subprocess|os\.system|os\.popen|pty\.|commands\.)\b/i,
  },
  {
    code: "no_dynamic_code",
    label: "Dynamic code execution is denied",
    pattern:
      /\b(eval|exec|compile|__import__|globals|locals|breakpoint)\s*\(|\b(getattr|setattr|delattr)\s*\(/i,
  },
  {
    code: "no_secrets",
    label: "Secret and environment access is denied",
    pattern:
      /\b(os\.environ|getenv|api[_-]?key|access[_-]?token|password|secret)\b/i,
  },
  {
    code: "no_filesystem",
    label: "Filesystem access is denied",
    pattern:
      /\bopen\s*\(|\b(pathlib|shutil|tempfile)\b|\b(write_text|write_bytes|read_text|read_bytes|unlink|remove|rmtree)\s*\(/i,
  },
  {
    code: "no_dunder_escape",
    label: "Python object-introspection escapes are denied",
    pattern: /__[A-Za-z_][A-Za-z0-9_]*__/,
  },
];

function importedPythonModules(code: string): string[] {
  const modules: string[] = [];
  for (const line of code.split("\n")) {
    const from = line.match(/^\s*from\s+([A-Za-z_][\w.]*)\s+import\s+/);
    if (from?.[1]) modules.push(from[1].split(".")[0]!);
    const direct = line.match(/^\s*import\s+(.+)$/);
    if (!direct?.[1]) continue;
    modules.push(
      ...direct[1]
        .split(",")
        .map(
          (item) =>
            item
              .trim()
              .split(/\s+as\s+/)[0]!
              .split(".")[0]!,
        )
        .filter(Boolean),
    );
  }
  return modules;
}

/** Defense-in-depth policy every executing host re-runs, even after proof. */
export function portablePythonPolicyChecks(
  source: string,
): PortableCapabilityPolicyCheck[] {
  const checks = DENIED_SOURCE.map((rule) => ({
    code: rule.code,
    passed: !rule.pattern.test(source),
    note: rule.pattern.test(source)
      ? rule.label
      : `${rule.label.replace(" is denied", " was not found")}.`,
  }));
  const deniedImports = importedPythonModules(source).filter(
    (module) => !ALLOWED_PYTHON_IMPORTS.has(module),
  );
  checks.push({
    code: "imports_allowlist",
    passed: deniedImports.length === 0,
    note:
      deniedImports.length === 0
        ? "Every import is on the deterministic standard-library allowlist."
        : `Denied imports: ${[...new Set(deniedImports)].join(", ")}.`,
  });
  checks.push({
    code: "entrypoint",
    passed: /def\s+run\s*\(\s*payload\s*\)\s*:/.test(source),
    note: "The artifact must expose exactly the run(payload) entrypoint.",
  });
  checks.push({
    code: "payload_usage",
    passed: (source.match(/\bpayload\b/g) ?? []).length >= 2,
    note: "The implementation must consume the runtime payload instead of returning a frozen proof result.",
  });
  return checks;
}

function jsonSize(value: unknown, label: string, max: number): void {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON-serializable`);
  }
  if (encoded === undefined || encoded.length > max) {
    throw new Error(`${label} is missing or too large`);
  }
}

function schemaRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON Schema object`);
  }
  jsonSize(value, label, MAX_SCHEMA_CHARS);
  return value as Record<string, unknown>;
}

/** Strict shape/policy parser. Digest verification remains async and separate. */
export function parseAgentExecutableCapability(
  raw: unknown,
): AgentExecutableCapabilityV1 {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Executable capability must be an object");
  }
  const value = raw as Partial<AgentExecutableCapabilityV1>;
  const permissions = value.permissions as
    | AgentExecutableCapabilityV1["permissions"]
    | undefined;
  const contract = value.contract as
    | AgentExecutableCapabilityV1["contract"]
    | undefined;
  const exactKeys = (
    candidate: Record<string, unknown>,
    allowed: string[],
  ): boolean => Object.keys(candidate).every((key) => allowed.includes(key));
  if (
    !exactKeys(raw as Record<string, unknown>, [
      "version",
      "kind",
      "language",
      "entrypoint",
      "policy",
      "source",
      "digest",
      "contract",
      "permissions",
    ]) ||
    value.version !== 1 ||
    value.kind !== EXECUTABLE_CAPABILITY_KIND ||
    value.language !== "python" ||
    value.entrypoint !== "run" ||
    value.policy !== EXECUTABLE_CAPABILITY_POLICY ||
    typeof value.source !== "string" ||
    !value.source.trim() ||
    value.source.length > MAX_SOURCE_CHARS ||
    typeof value.digest !== "string" ||
    !SHA256_DIGEST.test(value.digest) ||
    !contract ||
    !exactKeys(contract as unknown as Record<string, unknown>, [
      "inputSchema",
      "outputSchema",
    ]) ||
    !permissions ||
    !exactKeys(permissions as unknown as Record<string, unknown>, [
      "network",
      "secrets",
      "filesystemWrites",
    ]) ||
    permissions.network !== false ||
    permissions.filesystemWrites !== false ||
    !Array.isArray(permissions.secrets) ||
    permissions.secrets.length !== 0
  ) {
    throw new Error("Executable capability has an invalid or unsafe contract");
  }
  const inputSchema = schemaRecord(contract.inputSchema, "Input schema");
  const outputSchema = schemaRecord(contract.outputSchema, "Output schema");
  const failed = portablePythonPolicyChecks(value.source).filter(
    (check) => !check.passed,
  );
  if (failed.length > 0) {
    throw new Error(
      `Executable capability violates policy: ${failed.map((check) => check.code).join(", ")}`,
    );
  }
  return {
    version: 1,
    kind: EXECUTABLE_CAPABILITY_KIND,
    language: "python",
    entrypoint: "run",
    policy: EXECUTABLE_CAPABILITY_POLICY,
    source: value.source,
    digest: value.digest as `sha256:${string}`,
    contract: { inputSchema, outputSchema },
    permissions: {
      network: false,
      secrets: [],
      filesystemWrites: false,
    },
  };
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalJson(nested)]),
    );
  }
  return value;
}

/** Stable bytes covered by the artifact's SHA-256 pin. */
export function executableCapabilityDigestMaterial(
  artifact: AgentExecutableCapabilityV1 | UnsignedAgentExecutableCapabilityV1,
): string {
  return JSON.stringify(
    canonicalJson({
      version: artifact.version,
      kind: artifact.kind,
      language: artifact.language,
      entrypoint: artifact.entrypoint,
      policy: artifact.policy,
      source: artifact.source,
      contract: artifact.contract,
      permissions: artifact.permissions,
    }),
  );
}

export async function executableCapabilitySha256(
  artifact: AgentExecutableCapabilityV1 | UnsignedAgentExecutableCapabilityV1,
): Promise<`sha256:${string}`> {
  const bytes = new TextEncoder().encode(
    executableCapabilityDigestMaterial(artifact),
  );
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `sha256:${hex}`;
}

export async function verifyExecutableCapabilityDigest(
  raw: unknown,
): Promise<AgentExecutableCapabilityV1> {
  const artifact = parseAgentExecutableCapability(raw);
  const actual = await executableCapabilitySha256(artifact);
  if (actual !== artifact.digest) {
    throw new Error("Executable capability digest does not match its source");
  }
  return artifact;
}

/** Infer a value-free JSON Schema; fixture values never enter the artifact. */
export function inferCapabilityJsonSchema(
  value: unknown,
  depth = 0,
): Record<string, unknown> {
  if (depth > 8) return {};
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    const schemas = value
      .slice(0, 20)
      .map((item) => inferCapabilityJsonSchema(item, depth + 1));
    const unique = [
      ...new Map(
        schemas.map((schema) => [
          JSON.stringify(canonicalJson(schema)),
          schema,
        ]),
      ).values(),
    ];
    return {
      type: "array",
      ...(unique.length === 1
        ? { items: unique[0] }
        : unique.length > 1
          ? { items: { anyOf: unique } }
          : {}),
    };
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(
      0,
      100,
    );
    return {
      type: "object",
      properties: Object.fromEntries(
        entries.map(([key, nested]) => [
          key,
          inferCapabilityJsonSchema(nested, depth + 1),
        ]),
      ),
      required: entries.map(([key]) => key),
      additionalProperties: false,
    };
  }
  if (typeof value === "number") {
    return { type: Number.isInteger(value) ? "integer" : "number" };
  }
  if (typeof value === "boolean") return { type: "boolean" };
  if (typeof value === "string") return { type: "string" };
  return {};
}
