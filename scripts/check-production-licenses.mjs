import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function runPnpm(args) {
  if (process.env.npm_execpath) {
    return execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
  }

  if (process.platform === "win32") {
    return execFileSync(
      process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe",
      ["/d", "/s", "/c", `pnpm ${args.join(" ")}`],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
  }

  return execFileSync("pnpm", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

const reviewedNonStandardPackages = new Map([
  [
    "@browserbasehq/sdk",
    {
      scopes: ["private"],
      licenses: ["Unknown"],
      versions: ["2.12.0"],
      rationale:
        "Apache-2.0; the package ships its license text but omits package.json metadata.",
    },
  ],
  [
    "stripe-replit-sync",
    {
      scopes: ["private"],
      licenses: ["Unknown"],
      versions: ["1.0.0"],
      rationale:
        "Apache-2.0 upstream; the npm package omits package.json metadata.",
    },
  ],
  [
    "@nangohq/frontend",
    {
      scopes: ["private"],
      licenses: ["SEE LICENSE IN LICENSE FILE IN GIT REPOSITORY"],
      versions: ["0.70.6"],
      rationale:
        "Elastic License 2.0; approved only for the Nango client integration.",
    },
  ],
  [
    "@nangohq/types",
    {
      scopes: ["private"],
      licenses: ["SEE LICENSE IN LICENSE FILE IN GIT REPOSITORY"],
      versions: ["0.70.6"],
      rationale:
        "Elastic License 2.0; transitive types used by the approved Nango client integration.",
    },
  ],
  [
    "jszip",
    {
      scopes: ["private", "public"],
      licenses: ["(MIT OR GPL-3.0-or-later)"],
      versions: ["3.10.1"],
      rationale:
        "Chosen under the MIT option stated in the package's bundled dual-license text; transitive to the DOCX/XLSX readers.",
    },
  ],
  [
    "buffers",
    {
      scopes: ["private", "public"],
      licenses: ["Unknown"],
      versions: ["0.1.1"],
      rationale:
        "MIT/X11 in the upstream node-buffers source; the 0.1.1 npm tarball omits license metadata. Used only as an ExcelJS transitive.",
    },
  ],
  [
    "unionfs",
    {
      scopes: ["private"],
      licenses: ["Unknown"],
      versions: ["4.6.0"],
      rationale:
        "Unlicense public-domain dedication in the bundled LICENSE; package.json omits license metadata. Used only through Temporal's workflow bundler.",
    },
  ],
]);

const permittedLicenseLabels = new Set([
  "(AFL-2.1 OR BSD-3-Clause)",
  "(Apache-2.0 AND BSD-3-Clause)",
  "(MIT AND Zlib)",
  "(MIT OR CC0-1.0)",
  "0BSD",
  "Apache-2.0",
  "Apache-2.0 AND MIT",
  "Apache-2.0 OR MIT",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC-BY-4.0",
  "ISC",
  "MIT",
  "MIT OR Apache-2.0",
  "MIT/X11",
  "Unlicense",
]);

reviewedNonStandardPackages.set("duck", {
  scopes: ["private", "public"],
  licenses: ["BSD"],
  versions: ["0.1.12"],
  rationale:
    "The bundled license grants redistribution and use under the historical BSD terms; the package reports only the ambiguous BSD label.",
});

export function evaluateProductionLicenseReport(report, scope) {
  const violations = [];
  const reviewed = [];
  const usedExceptions = new Set();
  let packageCount = 0;
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return {
      packageCount,
      reviewed,
      violations: ["Production license inventory must be an object."],
    };
  }
  if (scope !== "private" && scope !== "public") {
    violations.push(
      `${scope || "(missing scope)"}: unknown repository scope; license exceptions fail closed.`,
    );
    scope = undefined;
  }

  for (const [license, packages] of Object.entries(report)) {
    if (!Array.isArray(packages)) {
      violations.push(`${license}: license inventory bucket must be an array.`);
      continue;
    }
    for (const dependency of packages) {
      packageCount += 1;
      const packageName = dependency?.name;
      const packageVersions = dependency?.versions;
      if (
        !dependency ||
        typeof dependency !== "object" ||
        typeof packageName !== "string" ||
        !packageName.trim() ||
        !Array.isArray(packageVersions) ||
        packageVersions.length === 0 ||
        packageVersions.some(
          (version) => typeof version !== "string" || !version.trim(),
        ) ||
        (dependency.license !== undefined && dependency.license !== license)
      ) {
        violations.push(
          `${license}: malformed production license inventory record.`,
        );
        continue;
      }
      if (permittedLicenseLabels.has(license)) {
        continue;
      }
      const review = reviewedNonStandardPackages.get(packageName);
      if (
        !scope ||
        !review?.scopes.includes(scope) ||
        !review.licenses.includes(license) ||
        !Array.isArray(packageVersions) ||
        packageVersions.length === 0 ||
        packageVersions.some(
          (version) =>
            typeof version !== "string" || !review.versions.includes(version),
        )
      ) {
        violations.push(
          `${packageName}: ${license}; explicit legal review is required before release.`,
        );
        continue;
      }
      usedExceptions.add(packageName);
      reviewed.push(`${packageName}: ${review.rationale}`);
    }
  }

  if (scope) {
    for (const [packageName, review] of reviewedNonStandardPackages) {
      if (review.scopes.includes(scope) && !usedExceptions.has(packageName)) {
        violations.push(
          `${packageName}: reviewed ${scope} exception is unused in the production license inventory.`,
        );
      }
    }
  }
  return { packageCount, reviewed, violations };
}

export function repositoryScopeError({
  scope,
  repository,
  githubRepository,
  stagedFrom,
}) {
  const expectedRepository =
    scope === "public"
      ? "dahshanlabs/agentmug-core"
      : scope === "private"
        ? "dahshanlabs/AgentMug"
        : undefined;
  const trustedStaging =
    scope === "public" &&
    stagedFrom === "dahshanlabs/AgentMug" &&
    githubRepository === stagedFrom;
  return repository === expectedRepository &&
    (!githubRepository || githubRepository === expectedRepository || trustedStaging)
    ? undefined
    : `${scope || "unknown"} scope requires repository ${expectedRepository}`;
}

function main() {
  let report;
  try {
    report = JSON.parse(
      runPnpm(["licenses", "list", "--prod", "--json"]),
    );
  } catch (error) {
    console.error(
      "Could not produce the production dependency license inventory.",
    );
    const capturedOutput = [error?.stdout, error?.stderr]
      .filter((value) => typeof value === "string" && value.trim())
      .join("\n")
      .trim();
    if (capturedOutput) console.error(capturedOutput);
    process.exit(error?.status || 1);
  }

  const rootPackage = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const scopeIndex = process.argv.indexOf("--scope");
  const scope = scopeIndex >= 0 ? process.argv[scopeIndex + 1] : undefined;
  const repositoryIndex = process.argv.indexOf("--repository");
  const repository =
    repositoryIndex >= 0 ? process.argv[repositoryIndex + 1] : undefined;
  const githubRepository = process.env.GITHUB_REPOSITORY;
  const scopeError =
    scope === "public"
      ? rootPackage.name === "agentmug-core" &&
        rootPackage.repository?.url ===
          "https://github.com/dahshanlabs/agentmug-core.git"
        ? undefined
        : "public scope requires the canonical agentmug-core package identity"
      : scope === "private"
        ? rootPackage.name === "workspace"
          ? undefined
          : "private scope requires the workspace package identity"
        : "--scope must be explicitly set to private or public";
  const repositoryError = repositoryScopeError({
    scope,
    repository,
    githubRepository,
    stagedFrom: process.env.AGENTMUG_LICENSE_STAGED_FROM,
  });
  const { packageCount, reviewed, violations } =
    evaluateProductionLicenseReport(report, scope);
  if (scopeError) violations.unshift(scopeError);
  if (repositoryError) violations.unshift(repositoryError);
  if (reviewed.length > 0) {
    console.log("Explicitly reviewed non-standard metadata:");
    for (const item of reviewed.sort()) console.log(`  - ${item}`);
  }
  if (violations.length > 0) {
    console.error("\nProduction dependency license gate failed:");
    for (const violation of violations.sort()) console.error(`  - ${violation}`);
    process.exit(1);
  }
  console.log(
    `Production dependency license gate passed (${packageCount} package entries).`,
  );
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() ===
    path.resolve(fileURLToPath(import.meta.url)).toLowerCase();

if (isMain) main();
