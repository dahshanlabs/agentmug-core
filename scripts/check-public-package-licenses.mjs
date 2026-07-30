import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const skippedDirectories = new Set([
  ".git",
  "dist",
  "node_modules",
  "node_modules.partial-20260729",
  "node_modules.partial2-20260729",
]);

const packagePolicies = new Map([
  [
    "@agentmug/runtime",
    {
      license: "Apache-2.0",
      publishedLicenseFile: "NOTICE",
      requiresLicenseHooks: true,
    },
  ],
  [
    "@agentmug/cli",
    {
      license: "Apache-2.0",
      publishedLicenseFile: "NOTICE",
      requiresLicenseHooks: true,
    },
  ],
  [
    "@agentmug/mcp-bridge",
    {
      license: "Apache-2.0",
      publishedLicenseFile: "NOTICE",
      requiresLicenseHooks: true,
    },
  ],
  [
    "@agentmug/otel",
    {
      license: "Apache-2.0",
      publishedLicenseFile: "NOTICE",
      requiresLicenseHooks: true,
    },
  ],
  [
    "n8n-nodes-agentmug",
    {
      license: "MIT",
      publishedLicenseFile: "LICENSE",
      requiresLicenseHooks: false,
    },
  ],
]);

async function findPackageManifests(directory) {
  const manifests = [];
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;

    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      manifests.push(...(await findPackageManifests(entryPath)));
    } else if (entry.isFile() && entry.name === "package.json") {
      manifests.push(entryPath);
    }
  }

  return manifests;
}

export async function checkPublicPackageLicenses(
  repositoryRoot = process.cwd(),
) {
  const manifests = await findPackageManifests(repositoryRoot);
  const publicPackages = [];
  const violations = [];

  for (const manifest of manifests) {
    const packageJson = JSON.parse(await readFile(manifest, "utf8"));
    if (!packageJson.name || packageJson.private === true) continue;

    publicPackages.push(packageJson.name);
    const relativeManifest = path.relative(repositoryRoot, manifest);
    const policy = packagePolicies.get(packageJson.name);
    if (!policy) {
      violations.push(
        `${packageJson.name}: unexpected public package in ${relativeManifest}.`,
      );
      continue;
    }

    if (packageJson.license !== policy.license) {
      violations.push(
        `${packageJson.name}: expected ${policy.license} in ${relativeManifest}, found ${packageJson.license || "no license"}.`,
      );
    }

    if (!packageJson.files?.includes(policy.publishedLicenseFile)) {
      violations.push(
        `${packageJson.name}: ${relativeManifest} must include ${policy.publishedLicenseFile} in its published files.`,
      );
    }

    if (
      policy.requiresLicenseHooks &&
      (!packageJson.scripts?.prepack || !packageJson.scripts?.postpack)
    ) {
      violations.push(
        `${packageJson.name}: ${relativeManifest} must prepare and clean LICENSE/NOTICE during packaging.`,
      );
    }
  }

  for (const packageName of packagePolicies.keys()) {
    if (!publicPackages.includes(packageName)) {
      violations.push(`${packageName}: expected public package is missing.`);
    }
  }

  if (violations.length > 0) {
    const error = new Error(
      `Public package license gate failed:\n${violations
        .sort()
        .map((violation) => `  - ${violation}`)
        .join("\n")}`,
    );
    error.violations = violations;
    throw error;
  }

  const counts = new Map();
  for (const packageName of publicPackages) {
    const license = packagePolicies.get(packageName).license;
    counts.set(license, (counts.get(license) || 0) + 1);
  }
  return {
    packages: publicPackages.sort(),
    summary: [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([license, count]) => `${count} ${license}`)
      .join(", "),
  };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() ===
    path.resolve(fileURLToPath(import.meta.url)).toLowerCase();

if (isMain) {
  try {
    const result = await checkPublicPackageLicenses();
    console.log(
      `Public package license gate passed (${result.summary}: ${result.packages.join(", ")}).`,
    );
  } catch (error) {
    console.error(error?.message || error);
    process.exit(1);
  }
}
