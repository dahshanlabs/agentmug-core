import { execFileSync } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

const privateLayout = [
  ["@agentmug/runtime", "packages/runtime"],
  ["@agentmug/cli", "packages/cli"],
  ["@agentmug/mcp-bridge", "packages/mcp-bridge"],
  ["@agentmug/otel", "packages/otel"],
  ["n8n-nodes-agentmug", "integrations/n8n-nodes-agentmug"],
];

const publicLayout = [
  ["@agentmug/runtime", "packages/runtime"],
  ["@agentmug/cli", "packages/cli"],
  ["@agentmug/mcp-bridge", "packages/mcp-bridge"],
  ["@agentmug/otel", "packages/otel"],
  ["n8n-nodes-agentmug", "integrations/n8n-nodes-agentmug"],
];

const requiredTarballFiles = new Map([
  ["@agentmug/runtime", ["LICENSE", "NOTICE", "README.md", "package.json"]],
  ["@agentmug/cli", ["LICENSE", "NOTICE", "README.md", "package.json"]],
  ["@agentmug/mcp-bridge", ["LICENSE", "NOTICE", "README.md", "package.json"]],
  ["@agentmug/otel", ["LICENSE", "NOTICE", "README.md", "package.json"]],
  ["n8n-nodes-agentmug", ["LICENSE", "README.md", "package.json"]],
]);

const repositoryRoot = process.cwd();
const npmEnvironment = { ...process.env };
for (const key of Object.keys(npmEnvironment)) {
  if (
    /^npm_config_(?:catalog|minimum_release_age|npm_globalconfig|overrides|verify_deps_before_run|_jsr_registry)$/i.test(
      key,
    )
  ) {
    delete npmEnvironment[key];
  }
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function runNpmPack(packageDirectory) {
  const args = ["pack", "--dry-run", "--json"];

  if (process.platform === "win32") {
    return execFileSync(
      process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe",
      ["/d", "/s", "/c", `npm ${args.join(" ")}`],
      {
        cwd: packageDirectory,
        env: npmEnvironment,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  }

  return execFileSync("npm", args, {
    cwd: packageDirectory,
    env: npmEnvironment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const layout = (await exists(path.join(repositoryRoot, "packages", "runtime")))
  ? publicLayout
  : privateLayout;

const violations = [];

for (const [expectedName, relativeDirectory] of layout) {
  const packageDirectory = path.join(repositoryRoot, relativeDirectory);
  if (!(await exists(path.join(packageDirectory, "package.json")))) {
    violations.push(
      `${expectedName}: missing ${relativeDirectory}/package.json`,
    );
    continue;
  }

  let report;
  try {
    const output = runNpmPack(packageDirectory);
    report = JSON.parse(output)[0];
  } catch (error) {
    const stderr = String(error?.stderr || "").trim();
    violations.push(
      `${expectedName}: npm pack --dry-run failed${stderr ? `: ${stderr}` : ""}`,
    );
    continue;
  }

  if (report.name !== expectedName) {
    violations.push(
      `${relativeDirectory}: expected ${expectedName}, packed ${report.name}`,
    );
  }

  const files = new Set((report.files || []).map((entry) => entry.path));
  for (const required of requiredTarballFiles.get(expectedName) || []) {
    if (!files.has(required)) {
      violations.push(`${expectedName}: tarball is missing ${required}`);
    }
  }

  if (
    ["@agentmug/cli", "@agentmug/mcp-bridge"].includes(expectedName) &&
    !files.has("dist/THIRD_PARTY_LICENSES.txt")
  ) {
    violations.push(
      `${expectedName}: bundled dependency license inventory is missing`,
    );
  }

  for (const file of files) {
    const normalized = file.replaceAll("\\", "/");
    if (
      normalized.includes("../") ||
      /(^|\/)(?:\.env(?:\.|$)|node_modules|src)(?:\/|$)/i.test(normalized) ||
      /(?:^|\/)[^/]+\.test\.d\.(?:ts|mts|cts)$/i.test(normalized) ||
      /\.(?:pem|p12|pfx|key|keystore)$/i.test(normalized)
    ) {
      violations.push(`${expectedName}: forbidden tarball path ${file}`);
    }
  }

  if ((report.unpackedSize || 0) > 20 * 1024 * 1024) {
    violations.push(
      `${expectedName}: unpacked tarball exceeds 20 MiB (${report.unpackedSize} bytes)`,
    );
  }

  console.log(
    `${expectedName}: ${files.size} files, ${report.unpackedSize || 0} unpacked bytes`,
  );
}

if (violations.length > 0) {
  console.error("\nPackage tarball gate failed:");
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}

console.log(`Package tarball gate passed (${layout.length} packages).`);
