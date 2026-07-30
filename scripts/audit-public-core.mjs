import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  readReleasePolicy,
  validatePublicReleaseState,
} from "./public-core-release-state.mjs";

const expectedPackages = new Map([
  [
    "@agentmug/runtime",
    {
      directory: "packages/runtime",
      license: "Apache-2.0",
      publishedLicenseFile: "NOTICE",
      requiresLicenseHooks: true,
    },
  ],
  [
    "@agentmug/cli",
    {
      directory: "packages/cli",
      license: "Apache-2.0",
      publishedLicenseFile: "NOTICE",
      requiresLicenseHooks: true,
    },
  ],
  [
    "@agentmug/mcp-bridge",
    {
      directory: "packages/mcp-bridge",
      license: "Apache-2.0",
      publishedLicenseFile: "NOTICE",
      requiresLicenseHooks: true,
    },
  ],
  [
    "@agentmug/otel",
    {
      directory: "packages/otel",
      license: "Apache-2.0",
      publishedLicenseFile: "NOTICE",
      requiresLicenseHooks: true,
    },
  ],
  [
    "n8n-nodes-agentmug",
    {
      directory: "integrations/n8n-nodes-agentmug",
      license: "MIT",
      publishedLicenseFile: "LICENSE",
      requiresLicenseHooks: false,
    },
  ],
]);
const exportMarkerName = ".agentmug-public-export";
const commitShaPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

const ignoredDirectoryNames = new Set([
  ".git",
  "coverage",
  "node_modules",
  "target",
]);
const generatedBuildDirectoryNames = new Set(["dist"]);

const requiredPaths = [
  "LICENSE",
  "NOTICE",
  "README.md",
  "pnpm-lock.yaml",
  "OPEN_SOURCE.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "GOVERNANCE.md",
  "TRADEMARKS.md",
  "PUBLIC_RELEASE.md",
  ".agentmug-public-export",
  ".gitattributes",
  ".prettierignore",
  ".github/CODEOWNERS",
  ".github/workflows/ci.yml",
  ".github/workflows/release-n8n.yml",
  ".github/workflows/release.yml",
  "config/public-core-release.json",
  "spec/agent.v1.json",
  "packages/runtime/src/format/agent-file.ts",
  "integrations/n8n-nodes-agentmug/LICENSE",
  "integrations/n8n-nodes-agentmug/eslint.config.mjs",
  "scripts/guard-public-publish.mjs",
  "scripts/guard-public-publish.test.mjs",
  "scripts/audit-public-core.test.mjs",
  "scripts/check-public-package-licenses.test.mjs",
  "scripts/public-core-release-state.mjs",
  "scripts/public-core-release-state.test.mjs",
  "scripts/test-public-core-version-transition.mjs",
  "scripts/verify-package-tarballs.mjs",
];

const forbiddenPathPatterns = [
  {
    label: "secret or environment file",
    pattern: /(^|\/)\.env(?:\.|$)/i,
  },
  {
    label: "private key or credential store",
    pattern:
      /(^|\/)(?:id_rsa|id_ed25519|[^/]+\.(?:pem|p12|pfx|key|jks|keystore))$/i,
  },
  {
    label: "private product source",
    pattern:
      /(^|\/)(?:artifacts\/(?:agentforge|api-server|agentlit-desktop)|lib\/(?:api-client-react|api-spec|api-zod|db))(?:\/|$)/i,
  },
  {
    label: "private project memory",
    pattern: /(^|\/)(?:brain\.klypix|\.claude|\.cursor)(?:\/|$)/i,
  },
  {
    label: "binary release artifact",
    pattern: /\.(?:appimage|deb|dmg|exe|msi)$/i,
  },
];

const forbiddenContentPatterns = [
  {
    label: "private key material",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
  {
    label: "AWS access key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    label: "GitHub token",
    pattern: /\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/,
  },
  {
    label: "npm token",
    pattern: /\bnpm_[A-Za-z0-9]{30,}\b/,
  },
  {
    label: "Anthropic API key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
  },
  {
    label: "OpenAI API key",
    pattern: /\bsk-[A-Za-z0-9]{20,}\b/,
  },
  {
    label: "Stripe secret key",
    pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  },
  {
    label: "Slack token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/,
  },
  {
    label: "credential-bearing database URL",
    pattern: /\b(?:postgres(?:ql)?|mysql):\/\/[^/\s:@]+:[^/\s@]+@/i,
  },
  {
    label: "private workspace import",
    pattern: /(?:from\s+|require\()["']@workspace\//,
  },
  {
    label: "private source path",
    pattern:
      /(?:artifacts[\\/](?:agentforge|api-server|agentlit-desktop)|lib[\\/](?:api-client-react|api-spec|api-zod|db))/i,
  },
  {
    label: "local absolute path",
    pattern: /\b[A-Z]:\\(?:Users|ANTIGRAVITY)\\/i,
  },
];

const forbiddenPersonalAddressFingerprints = new Set([
  "37e77d82c9faab5596a334ae10961ff832258bccf9beb01d608514871aa6bc4d",
  "4a8f41adfd105b25ee9cf9e3f10a92ae7ab252c4078ec60ac8c086ced4b5ad78",
]);

export function containsForbiddenPersonalAddress(
  text,
  fingerprints = forbiddenPersonalAddressFingerprints,
) {
  for (const match of text.matchAll(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}\b/gi,
  )) {
    const fingerprint = createHash("sha256")
      .update(match[0].toLowerCase(), "utf8")
      .digest("hex");
    if (fingerprints.has(fingerprint)) return true;
  }
  return false;
}

export function findForbiddenContentLabels(text) {
  const labels = forbiddenContentPatterns
    .filter((check) => check.pattern.test(text))
    .map((check) => check.label);
  if (containsForbiddenPersonalAddress(text)) {
    labels.push("personal fixture address");
  }
  return labels;
}

function normalizeRelative(value) {
  return value.split(path.sep).join("/");
}

function isGeneratedBuildOutput(relative) {
  return relative
    .split("/")
    .some((segment) => generatedBuildDirectoryNames.has(segment));
}

async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

export async function validateTrackedBuildOutputs(root, violations) {
  if (!(await pathExists(path.join(root, ".git")))) return;

  let output;
  try {
    output = execFileSync(
      "git",
      ["ls-files", "-z", "--", ":(glob)dist/**", ":(glob)**/dist/**"],
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    violations.push(
      `git: unable to verify that generated dist files are untracked (${error.message})`,
    );
    return;
  }

  for (const tracked of output.split("\0").filter(Boolean)) {
    violations.push(
      `${normalizeRelative(tracked)}: generated dist files must never be tracked`,
    );
  }
}

export async function collectFiles(root, directory = root, violations = []) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const relative = normalizeRelative(path.relative(root, absolute));
    const stat = await lstat(absolute);

    if (stat.isSymbolicLink()) {
      violations.push(`${relative}: symbolic links are not allowed`);
      continue;
    }

    if (entry.isDirectory()) {
      if (ignoredDirectoryNames.has(entry.name)) continue;
      files.push(...(await collectFiles(root, absolute, violations)));
      continue;
    }

    if (entry.isFile()) files.push({ absolute, relative, size: stat.size });
  }

  return files;
}

async function validatePackages(root, publicRepository, violations) {
  const discovered = new Map();
  const files = await collectFiles(root, root, []);

  for (const file of files) {
    if (!file.relative.endsWith("package.json")) continue;

    let packageJson;
    try {
      packageJson = JSON.parse(await readFile(file.absolute, "utf8"));
    } catch {
      violations.push(`${file.relative}: invalid package.json`);
      continue;
    }

    if (!packageJson.name || packageJson.private === true) continue;
    discovered.set(packageJson.name, path.posix.dirname(file.relative));

    const policy = expectedPackages.get(packageJson.name);
    if (!policy) {
      violations.push(
        `${file.relative}: unexpected public package ${packageJson.name}`,
      );
      continue;
    }

    if (path.posix.dirname(file.relative) !== policy.directory) {
      violations.push(
        `${packageJson.name}: expected ${policy.directory}, found ${path.posix.dirname(file.relative)}`,
      );
    }

    if (packageJson.license !== policy.license) {
      violations.push(`${packageJson.name}: license must be ${policy.license}`);
    }
    if (
      packageJson.name === "n8n-nodes-agentmug" &&
      packageJson.n8n?.strict !== true
    ) {
      violations.push("n8n-nodes-agentmug: n8n.strict must remain true");
    }

    if (packageJson.publishConfig?.access !== "public") {
      violations.push(
        `${packageJson.name}: publishConfig.access must be public`,
      );
    }

    if (packageJson.publishConfig?.provenance !== true) {
      violations.push(
        `${packageJson.name}: publishConfig.provenance must be true`,
      );
    }

    const repositoryUrl =
      typeof packageJson.repository === "string"
        ? packageJson.repository
        : packageJson.repository?.url;
    if (
      !repositoryUrl ||
      !repositoryUrl
        .toLowerCase()
        .includes(`github.com/${publicRepository.toLowerCase()}`)
    ) {
      violations.push(
        `${packageJson.name}: repository must point to ${publicRepository}`,
      );
    }

    if (
      typeof packageJson.repository === "object" &&
      packageJson.repository.directory !== policy.directory
    ) {
      violations.push(
        `${packageJson.name}: repository.directory must be ${policy.directory}`,
      );
    }

    if (!packageJson.files?.includes(policy.publishedLicenseFile)) {
      violations.push(
        `${packageJson.name}: published files must include ${policy.publishedLicenseFile}`,
      );
    }

    if (
      policy.requiresLicenseHooks &&
      (!packageJson.scripts?.prepack || !packageJson.scripts?.postpack)
    ) {
      violations.push(
        `${packageJson.name}: prepack and postpack license hooks are required`,
      );
    }
  }

  for (const [packageName, policy] of expectedPackages) {
    if (discovered.get(packageName) !== policy.directory) {
      violations.push(`${packageName}: expected public package is missing`);
    }
  }

  const rootPackage = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  if (rootPackage.private !== true || rootPackage.license !== "Apache-2.0") {
    violations.push(
      "root package.json must be private and licensed Apache-2.0",
    );
  }
}

async function validateAgentSchema(root, violations) {
  const schemaPath = path.join(root, "spec", "agent.v1.json");
  let schema;
  try {
    schema = JSON.parse(await readFile(schemaPath, "utf8"));
  } catch {
    violations.push("spec/agent.v1.json: invalid JSON Schema document");
    return;
  }

  if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
    violations.push("spec/agent.v1.json: expected JSON Schema draft 2020-12");
  }
  if (schema.$id !== "https://agentmug.com/schemas/agent.v1.json") {
    violations.push("spec/agent.v1.json: unexpected canonical $id");
  }
  if (
    schema.type !== "object" ||
    !schema.properties?.blueprint ||
    !schema.properties?.inputs
  ) {
    violations.push(
      "spec/agent.v1.json: missing required agent-file schema structure",
    );
  }
}

async function validateN8nStrictTooling(root, violations) {
  const configPath = path.join(
    root,
    "integrations",
    "n8n-nodes-agentmug",
    "eslint.config.mjs",
  );
  const expected =
    "import { config } from '@n8n/node-cli/eslint';\n\nexport default config;\n";
  let actual;
  try {
    actual = (await readFile(configPath, "utf8")).replaceAll("\r\n", "\n");
  } catch (error) {
    violations.push(
      `integrations/n8n-nodes-agentmug/eslint.config.mjs: unreadable (${error.message})`,
    );
    return;
  }
  if (actual !== expected) {
    violations.push(
      "integrations/n8n-nodes-agentmug/eslint.config.mjs: n8n strict mode requires the canonical default config",
    );
  }
}

async function validateWorkflows(root, violations) {
  const workflowDirectory = path.join(root, ".github", "workflows");
  const entries = await readdir(workflowDirectory, { withFileTypes: true });
  const workflowContents = new Map();
  for (const entry of entries) {
    if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
    const relative = `.github/workflows/${entry.name}`;
    const content = await readFile(
      path.join(workflowDirectory, entry.name),
      "utf8",
    );
    workflowContents.set(entry.name, content);
    for (const match of content.matchAll(/^\s*uses:\s*([^\s#]+)/gm)) {
      const action = match[1];
      if (action.startsWith("./")) continue;
      const separator = action.lastIndexOf("@");
      const reference = separator >= 0 ? action.slice(separator + 1) : "";
      if (!/^[a-f0-9]{40}$/.test(reference)) {
        violations.push(
          `${relative}: action must use an immutable commit SHA (${action})`,
        );
      }
    }
  }

  const releasePath = path.join(workflowDirectory, "release.yml");
  const release =
    workflowContents.get("release.yml") ??
    (await readFile(releasePath, "utf8"));
  const jobBlock = (name) => {
    const header = new RegExp(`^  ${name}:[ \\t]*\\r?$`, "m").exec(release);
    if (!header) return null;
    const start = header.index + header[0].length;
    const remainder = release.slice(start);
    const nextJob = /^  [A-Za-z0-9_-]+:[ \t]*\r?$/m.exec(remainder);
    return nextJob ? remainder.slice(0, nextJob.index) : remainder;
  };

  for (const [label, required] of [
    ["explicit release enablement", "AGENTMUG_RELEASE_ENABLED"],
    ["exact published-package output", "publishedPackages"],
    ["registry integrity verification", "dist.integrity"],
    ["pinned SBOM generator", "syft-version: v1.50.0"],
    ["GitHub provenance attestation", "subject-checksums: release/SHA256SUMS"],
    ["package SBOM attestation", "sbom-path:"],
    ["versioned manifest wrapper", "version: pnpm run version-packages"],
  ]) {
    if (!release.includes(required)) {
      violations.push(`.github/workflows/release.yml: missing ${label}`);
    }
  }

  const sbomJob = jobBlock("sbom");
  const attestJob = jobBlock("attest");
  if (!sbomJob) {
    violations.push(
      ".github/workflows/release.yml: missing unprivileged sbom job",
    );
  } else {
    if (!sbomJob.includes("syft-version: v1.50.0")) {
      violations.push(
        ".github/workflows/release.yml: sbom job must run the pinned scanner",
      );
    }
    if (
      /\b(?:id-token|attestations|artifact-metadata):\s*write\b/.test(
        sbomJob,
      ) ||
      sbomJob.includes("actions/attest@")
    ) {
      violations.push(
        ".github/workflows/release.yml: sbom scanner job must not hold attestation privileges",
      );
    }
  }

  if (!attestJob) {
    violations.push(
      ".github/workflows/release.yml: missing privileged attest job",
    );
  } else {
    for (const required of [
      "needs: sbom",
      "id-token: write",
      "attestations: write",
      "actions/attest@",
    ]) {
      if (!attestJob.includes(required)) {
        violations.push(
          `.github/workflows/release.yml: attest job missing ${required}`,
        );
      }
    }
    if (
      /\bsyft\b/i.test(attestJob) ||
      /\b(?:npm|pnpm)\s+(?:ci|install)\b/.test(attestJob)
    ) {
      violations.push(
        ".github/workflows/release.yml: privileged attest job must not install dependencies or run scanners",
      );
    }
  }

  for (const name of ["release.yml", "release-n8n.yml"]) {
    const content = workflowContents.get(name);
    if (
      content &&
      !/\.immutable[^\r\n]*(?:==|=)\s*["']?true["']?/i.test(content)
    ) {
      violations.push(
        `.github/workflows/${name}: must assert the published GitHub release is immutable`,
      );
    }
  }

  for (const name of ["ci.yml", "release.yml"]) {
    const content = workflowContents.get(name) || "";
    for (const line of content.split(/\r?\n/)) {
      if (
        /\bpnpm install\b/.test(line) &&
        !/\s--ignore-scripts(?:\s|$)/.test(line)
      ) {
        violations.push(
          `.github/workflows/${name}: dependency installation must use --ignore-scripts`,
        );
      }
    }
  }
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function readExportMarker(root, writeManifest, violations) {
  const markerPath = path.join(root, exportMarkerName);
  let marker;
  try {
    marker = JSON.parse(await readFile(markerPath, "utf8"));
  } catch (error) {
    violations.push(
      `${exportMarkerName}: invalid or missing export receipt (${error.message})`,
    );
    return null;
  }

  const expectedKeys = [
    "kind",
    "manifestSha256",
    "schemaVersion",
    "sourceCommitSha",
  ];
  const actualKeys = Object.keys(marker).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    violations.push(
      `${exportMarkerName}: receipt may contain only schemaVersion, kind, sourceCommitSha, and manifestSha256`,
    );
  }
  if (
    marker.schemaVersion !== 2 ||
    marker.kind !== "agentmug-public-core-staging"
  ) {
    violations.push(`${exportMarkerName}: unsupported export receipt`);
  }
  if (!commitShaPattern.test(marker.sourceCommitSha || "")) {
    violations.push(`${exportMarkerName}: invalid private source commit SHA`);
  }
  if (
    !sha256Pattern.test(marker.manifestSha256 || "") &&
    !(writeManifest && marker.manifestSha256 === null)
  ) {
    violations.push(`${exportMarkerName}: invalid public manifest SHA-256`);
  }

  return marker;
}

async function buildManifest(files, publicRepository, sourceCommitSha) {
  const manifestFiles = [];
  for (const file of files) {
    if (
      file.relative === exportMarkerName ||
      file.relative === "PUBLIC_CORE_MANIFEST.json" ||
      isGeneratedBuildOutput(file.relative)
    ) {
      continue;
    }
    const content = await readFile(file.absolute);
    manifestFiles.push({
      path: file.relative,
      sha256: createHash("sha256").update(content).digest("hex"),
      size: content.length,
    });
  }
  return {
    schemaVersion: 2,
    repository: publicRepository,
    source: {
      commitSha: sourceCommitSha,
    },
    files: manifestFiles,
  };
}

function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function validateManifest(root, expected, marker, violations) {
  const manifestPath = path.join(root, "PUBLIC_CORE_MANIFEST.json");
  let actual;
  let content;
  try {
    content = await readFile(manifestPath);
    actual = JSON.parse(content.toString("utf8"));
  } catch (error) {
    violations.push(
      `PUBLIC_CORE_MANIFEST.json: invalid or missing source manifest (${error.message})`,
    );
    return;
  }

  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    violations.push(
      "PUBLIC_CORE_MANIFEST.json: source tree drifted; regenerate the reviewed manifest",
    );
  }

  const manifestSha256 = sha256(content);
  if (marker?.manifestSha256 !== manifestSha256) {
    violations.push(
      `${exportMarkerName}: manifestSha256 does not match PUBLIC_CORE_MANIFEST.json`,
    );
  }
  return manifestSha256;
}

export async function auditPublicCore({
  root,
  publicRepository = "dahshanlabs/agentmug-core",
  writeManifest = false,
}) {
  const resolvedRoot = await realpath(path.resolve(root));
  const violations = [];
  await validateTrackedBuildOutputs(resolvedRoot, violations);

  for (const required of requiredPaths) {
    if (!(await pathExists(path.join(resolvedRoot, required)))) {
      violations.push(`${required}: required public-core path is missing`);
    }
  }

  const files = await collectFiles(resolvedRoot, resolvedRoot, violations);

  for (const file of files) {
    for (const check of forbiddenPathPatterns) {
      if (check.pattern.test(file.relative)) {
        violations.push(`${file.relative}: ${check.label}`);
      }
    }

    if (file.size > 5 * 1024 * 1024) {
      violations.push(`${file.relative}: source file exceeds 5 MiB`);
      continue;
    }

    const content = await readFile(file.absolute);
    if (content.includes(0)) continue;
    const text = content.toString("utf8");

    for (const label of findForbiddenContentLabels(text)) {
      violations.push(`${file.relative}: contains ${label}`);
    }
  }

  const marker = await readExportMarker(
    resolvedRoot,
    writeManifest,
    violations,
  );
  const expectedManifest = marker
    ? await buildManifest(files, publicRepository, marker.sourceCommitSha)
    : null;
  let manifestSha256;
  if (!writeManifest && expectedManifest) {
    manifestSha256 = await validateManifest(
      resolvedRoot,
      expectedManifest,
      marker,
      violations,
    );
  }

  await validateAgentSchema(resolvedRoot, violations);
  await validateN8nStrictTooling(resolvedRoot, violations);
  await validateWorkflows(resolvedRoot, violations);
  try {
    const policy = await readReleasePolicy(
      path.join(resolvedRoot, "config", "public-core-release.json"),
    );
    await validatePublicReleaseState({ root: resolvedRoot, policy });
  } catch (error) {
    violations.push(`release lifecycle: ${error.message}`);
  }
  await validatePackages(resolvedRoot, publicRepository, violations);

  if (violations.length > 0) {
    const error = new Error(
      `Public-core audit failed:\n${violations
        .sort()
        .map((item) => `  - ${item}`)
        .join("\n")}`,
    );
    error.violations = violations;
    throw error;
  }

  if (writeManifest && expectedManifest && marker) {
    const manifestContent = serializeManifest(expectedManifest);
    manifestSha256 = sha256(manifestContent);
    await writeFile(
      path.join(resolvedRoot, "PUBLIC_CORE_MANIFEST.json"),
      manifestContent,
      "utf8",
    );
    await writeFile(
      path.join(resolvedRoot, exportMarkerName),
      `${JSON.stringify(
        {
          schemaVersion: 2,
          kind: "agentmug-public-core-staging",
          sourceCommitSha: marker.sourceCommitSha,
          manifestSha256,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  return {
    files: files.length,
    root: resolvedRoot,
    sourceCommitSha: marker.sourceCommitSha,
    manifestSha256,
  };
}

function parseArguments(argv) {
  const parsed = {
    root: process.cwd(),
    publicRepository: "dahshanlabs/agentmug-core",
    writeManifest: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") parsed.root = argv[++index];
    else if (argument === "--public-repository") {
      parsed.publicRepository = argv[++index];
    } else if (argument === "--write-manifest") {
      parsed.writeManifest = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return parsed;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() ===
    path.resolve(fileURLToPath(import.meta.url)).toLowerCase();

if (isMain) {
  try {
    const result = await auditPublicCore(parseArguments(process.argv.slice(2)));
    console.log(
      `Public-core audit passed (${result.files} source files in ${result.root}).`,
    );
    console.log(`Private source commit: ${result.sourceCommitSha}`);
    console.log(`Public manifest SHA-256: ${result.manifestSha256}`);
  } catch (error) {
    console.error(error?.message || error);
    process.exit(1);
  }
}
