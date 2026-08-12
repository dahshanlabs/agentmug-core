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
  /** Declared source policy; the executing host's sandbox remains authority. */
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
      /\b(eval|exec|compile|__import__|globals|locals|vars|breakpoint)\s*\(|\b(getattr|setattr|delattr|attrgetter|methodcaller)\s*\(/i,
  },
  {
    code: "no_runtime_introspection",
    label: "Runtime and frame introspection is denied",
    pattern:
      /\b(sys|_sys|bltns|builtins|importlib|pkgutil|inspect|gi_frame|cr_frame|ag_frame|f_globals|f_locals|tb_frame)\b/i,
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
      /\bopen\s*\(|\b(pathlib|shutil|tempfile)\b|\b(write_text|write_bytes|read_text|read_bytes|listdir|scandir|stat|lstat|walk|chdir|mkdir|makedirs|rename|replace|unlink|remove|rmdir|rmtree|chmod|chown|link|symlink|truncate)\s*\(/i,
  },
  {
    code: "no_dunder_escape",
    label: "Python object-introspection escapes are denied",
    pattern: /__[A-Za-z_][A-Za-z0-9_]*__/,
  },
];

const INVALID_PYTHON_IMPORT = "(invalid import syntax)";

function isPythonHorizontalWhitespace(character: string | undefined): boolean {
  return (
    character === " " ||
    character === "\t" ||
    character === "\f" ||
    character === "\v"
  );
}

function skipPythonHorizontalWhitespace(value: string, start: number): number {
  let index = start;
  while (
    index < value.length &&
    isPythonHorizontalWhitespace(value[index])
  ) {
    index += 1;
  }
  return index;
}

function skipPythonImportTrivia(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    index = skipPythonHorizontalWhitespace(value, index);
    while (value[index] === "\n" || value[index] === "\r") {
      index += 1;
      index = skipPythonHorizontalWhitespace(value, index);
    }
    if (value[index] !== "#") return index;
    while (
      index < value.length &&
      value[index] !== "\n" &&
      value[index] !== "\r"
    ) {
      index += 1;
    }
    while (value[index] === "\n" || value[index] === "\r") index += 1;
  }
  return index;
}

function isPythonIdentifierStart(character: string | undefined): boolean {
  if (!character) return false;
  const code = character.charCodeAt(0);
  return (
    character === "_" ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

function isPythonIdentifierPart(character: string | undefined): boolean {
  if (isPythonIdentifierStart(character)) return true;
  if (!character) return false;
  const code = character.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function readPythonIdentifier(
  value: string,
  start: number,
): { value: string; next: number } | undefined {
  if (!isPythonIdentifierStart(value[start])) return undefined;
  let next = start + 1;
  while (next < value.length && isPythonIdentifierPart(value[next])) next += 1;
  return { value: value.slice(start, next), next };
}

function readQualifiedPythonModule(
  value: string,
  start: number,
): { root: string; next: number } | undefined {
  const first = readPythonIdentifier(value, start);
  if (!first) return undefined;
  let next = first.next;
  while (value[next] === ".") {
    const segment = readPythonIdentifier(value, next + 1);
    if (!segment) return undefined;
    next = segment.next;
  }
  return { root: first.value, next };
}

function pythonStatementBody(
  line: string,
  keyword: "from" | "import",
): string | undefined {
  const start = skipPythonHorizontalWhitespace(line, 0);
  if (!line.startsWith(keyword, start)) return undefined;
  const afterKeyword = start + keyword.length;
  if (!isPythonHorizontalWhitespace(line[afterKeyword])) return undefined;
  return line.slice(skipPythonHorizontalWhitespace(line, afterKeyword));
}

function readPythonAlias(value: string, start: number): number | undefined {
  const beforeAlias = start;
  const aliasKeyword = skipPythonHorizontalWhitespace(value, start);
  if (
    aliasKeyword === beforeAlias ||
    !value.startsWith("as", aliasKeyword) ||
    !isPythonHorizontalWhitespace(value[aliasKeyword + 2])
  ) {
    return start;
  }
  const aliasStart = skipPythonHorizontalWhitespace(value, aliasKeyword + 2);
  return readPythonIdentifier(value, aliasStart)?.next;
}

function directPythonImports(value: string): string[] | undefined {
  const modules: string[] = [];
  let index = 0;
  while (index < value.length) {
    index = skipPythonHorizontalWhitespace(value, index);
    const module = readQualifiedPythonModule(value, index);
    if (!module) return undefined;
    modules.push(module.root);
    index = readPythonAlias(value, module.next) ?? -1;
    if (index < 0) return undefined;
    const separator = skipPythonHorizontalWhitespace(value, index);
    if (separator === value.length) return modules;
    if (value[separator] === "#") return modules;
    index = separator;
    if (value[index] !== ",") return undefined;
    index += 1;
    if (skipPythonHorizontalWhitespace(value, index) === value.length) {
      return undefined;
    }
  }
  return undefined;
}

function validFromImportTargets(value: string, start: number): boolean {
  let index = skipPythonImportTrivia(value, start);
  let parenthesized = false;
  if (value[index] === "(") {
    parenthesized = true;
    index = skipPythonImportTrivia(value, index + 1);
  }
  if (value[index] === "*") {
    const end = index + 1;
    index = skipPythonImportTrivia(value, end);
    if (parenthesized && value[index] === ")") {
      index = skipPythonImportTrivia(value, index + 1);
    }
    return (
      index === value.length ||
      (!parenthesized && value[index] === "#")
    );
  }

  let found = false;
  while (index < value.length) {
    const imported = readPythonIdentifier(value, index);
    if (!imported) return false;
    found = true;
    const importedEnd = readPythonAlias(value, imported.next) ?? -1;
    index = importedEnd;
    if (index < 0) return false;
    index = parenthesized
      ? skipPythonImportTrivia(value, index)
      : skipPythonHorizontalWhitespace(value, index);
    if (parenthesized && value[index] === ")") {
      index = skipPythonImportTrivia(value, index + 1);
      return found && index === value.length;
    }
    if (index === value.length) return found && !parenthesized;
    if (!parenthesized && value[index] === "#") {
      return found;
    }
    if (value[index] !== ",") return false;
    index = parenthesized
      ? skipPythonImportTrivia(value, index + 1)
      : skipPythonHorizontalWhitespace(value, index + 1);
    if (parenthesized && value[index] === ")") {
      index = skipPythonImportTrivia(value, index + 1);
      return found && index === value.length;
    }
  }
  return false;
}

function fromPythonImport(value: string): string | undefined {
  const moduleStart = skipPythonHorizontalWhitespace(value, 0);
  const module = readQualifiedPythonModule(value, moduleStart);
  if (!module) return undefined;
  const importKeyword = skipPythonHorizontalWhitespace(value, module.next);
  if (
    importKeyword === module.next ||
    !value.startsWith("import", importKeyword) ||
    !isPythonHorizontalWhitespace(value[importKeyword + 6])
  ) {
    return undefined;
  }
  const targets = skipPythonHorizontalWhitespace(value, importKeyword + 6);
  return validFromImportTargets(value, targets) ? module.root : undefined;
}

/**
 * Split Python into simple-statement candidates without interpreting text in
 * comments or string literals. Imports are statements, so every valid import
 * starts at the file boundary, a logical newline, a semicolon, or after the
 * colon introducing a one-line suite (for example `if ready: import math`).
 *
 * The scanner is deliberately single-pass and bounded by the source length.
 * It is not a Python parser: malformed source is rejected later by the host.
 */
function pythonSimpleStatements(code: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let index = 0;
  let bracketDepth = 0;
  let comment = false;
  let quote: "'" | '"' | undefined;
  let tripleQuoted = false;

  const finishStatement = (end: number) => {
    statements.push(code.slice(start, end));
    start = end + 1;
  };

  while (index < code.length) {
    const character = code[index];

    if (comment) {
      if (character === "\n" || character === "\r") {
        comment = false;
        if (bracketDepth === 0) finishStatement(index);
      }
      index += 1;
      continue;
    }

    if (quote) {
      if (character === "\\") {
        index += Math.min(2, code.length - index);
        continue;
      }
      if (
        tripleQuoted &&
        character === quote &&
        code[index + 1] === quote &&
        code[index + 2] === quote
      ) {
        quote = undefined;
        tripleQuoted = false;
        index += 3;
        continue;
      }
      if (!tripleQuoted && character === quote) quote = undefined;
      index += 1;
      continue;
    }

    if (character === "#") {
      comment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      tripleQuoted =
        code[index + 1] === character && code[index + 2] === character;
      index += tripleQuoted ? 3 : 1;
      continue;
    }
    if (character === "(" || character === "[" || character === "{") {
      bracketDepth += 1;
      index += 1;
      continue;
    }
    if (character === ")" || character === "]" || character === "}") {
      bracketDepth = Math.max(0, bracketDepth - 1);
      index += 1;
      continue;
    }
    if (
      bracketDepth === 0 &&
      (character === "\n" ||
        character === "\r" ||
        character === ";" ||
        character === ":")
    ) {
      finishStatement(index);
    }
    index += 1;
  }

  statements.push(code.slice(start));
  return statements;
}

function importedPythonModules(code: string): string[] {
  const modules: string[] = [];
  for (const statement of pythonSimpleStatements(code)) {
    const fromBody = pythonStatementBody(statement, "from");
    if (fromBody !== undefined) {
      modules.push(fromPythonImport(fromBody) ?? INVALID_PYTHON_IMPORT);
      continue;
    }
    const importBody = pythonStatementBody(statement, "import");
    if (importBody === undefined) continue;
    modules.push(...(directPythonImports(importBody) ?? [INVALID_PYTHON_IMPORT]));
  }
  return modules;
}

/**
 * Conservative source screening every executing host re-runs after proof.
 * This is defense in depth, not a Python sandbox: the host must still isolate
 * the interpreter from its filesystem/secrets and enforce no network access.
 */
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
