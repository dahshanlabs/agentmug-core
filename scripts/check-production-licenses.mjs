import { execFileSync } from "node:child_process";

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
    "Apache-2.0; the package ships its license text but omits package.json metadata.",
  ],
  [
    "stripe-replit-sync",
    "Apache-2.0 upstream; the npm package omits package.json metadata.",
  ],
  [
    "@nangohq/frontend",
    "Elastic License 2.0; approved only for the Nango client integration.",
  ],
  [
    "@nangohq/types",
    "Elastic License 2.0; transitive types used by the approved Nango client integration.",
  ],
  [
    "jszip",
    "Chosen under the MIT option stated in the package's bundled dual-license text; transitive to the DOCX/XLSX readers.",
  ],
  [
    "buffers",
    "MIT/X11 in the upstream node-buffers source; the 0.1.1 npm tarball omits license metadata. Used only as an ExcelJS transitive.",
  ],
  [
    "unionfs",
    "Unlicense public-domain dedication in the bundled LICENSE; package.json omits license metadata. Used only through Temporal's workflow bundler.",
  ],
]);

const reviewRequired =
  /(?:^|[^A-Z])(?:AGPL|GPL|LGPL|SSPL|BUSL|Commons Clause|CC-BY-NC|PolyForm|Elastic(?: License)?(?: 2\.0)?)(?:[^A-Z]|$)/i;
const missingMetadata = /^(?:Unknown|SEE LICENSE\b)/i;

let report;
try {
  report = JSON.parse(
    runPnpm(["licenses", "list", "--prod", "--json"]),
  );
} catch (error) {
  console.error("Could not produce the production dependency license inventory.");
  const capturedOutput = [error?.stdout, error?.stderr]
    .filter((value) => typeof value === "string" && value.trim())
    .join("\n")
    .trim();
  if (capturedOutput) console.error(capturedOutput);
  process.exit(error?.status || 1);
}

const violations = [];
const reviewed = [];
let packageCount = 0;

for (const [license, packages] of Object.entries(report)) {
  for (const dependency of packages) {
    packageCount += 1;
    const packageName = dependency.name;

    if (reviewRequired.test(license) || missingMetadata.test(license)) {
      const rationale = reviewedNonStandardPackages.get(packageName);
      if (!rationale) {
        violations.push(
          `${packageName}: ${license}; explicit legal review is required before release.`,
        );
      } else {
        reviewed.push(`${packageName}: ${rationale}`);
      }
    }
  }
}

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
