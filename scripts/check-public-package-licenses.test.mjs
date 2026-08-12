import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkPublicPackageLicenses } from "./check-public-package-licenses.mjs";
import {
  evaluateProductionLicenseReport,
  repositoryScopeError,
} from "./check-production-licenses.mjs";

const policies = [
  ["@agentmug/runtime", "Apache-2.0"],
  ["@agentmug/cli", "Apache-2.0"],
  ["@agentmug/mcp-bridge", "Apache-2.0"],
  ["@agentmug/otel", "Apache-2.0"],
  ["n8n-nodes-agentmug", "MIT"],
];

async function writePackage(root, index, name, license) {
  const directory = path.join(root, `package-${index}`);
  await mkdir(directory, { recursive: true });
  const isN8n = name === "n8n-nodes-agentmug";
  await writeFile(
    path.join(directory, "package.json"),
    `${JSON.stringify(
      {
        name,
        version: "1.0.0",
        license,
        files: [isN8n ? "LICENSE" : "NOTICE"],
        scripts: isN8n
          ? {}
          : {
              prepack: "prepare-license",
              postpack: "clean-license",
            },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return directory;
}

test("license gate enforces Apache core and MIT n8n as separate policies", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentmug-license-gate-"));
  context.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const directories = [];
  for (let index = 0; index < policies.length; index += 1) {
    const [name, license] = policies[index];
    directories.push(await writePackage(root, index, name, license));
  }

  const result = await checkPublicPackageLicenses(root);
  assert.equal(result.summary, "4 Apache-2.0, 1 MIT");

  const n8nDirectory = directories.at(-1);
  await writeFile(
    path.join(n8nDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "n8n-nodes-agentmug",
        version: "1.0.0",
        license: "Apache-2.0",
        files: ["LICENSE"],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await assert.rejects(
    checkPublicPackageLicenses(root),
    /n8n-nodes-agentmug: expected MIT/,
  );
});

test("production license exceptions are repository-scoped and cannot go stale", () => {
  const publicReport = {
    "(MIT OR GPL-3.0-or-later)": [
      { name: "jszip", versions: ["3.10.1"] },
    ],
    Unknown: [{ name: "buffers", versions: ["0.1.1"] }],
    BSD: [{ name: "duck", versions: ["0.1.12"] }],
    MIT: [{ name: "safe-package", versions: ["1.0.0"] }],
  };
  assert.deepEqual(
    evaluateProductionLicenseReport(publicReport, "public")
      .violations,
    [],
  );

  assert.deepEqual(
    evaluateProductionLicenseReport(
      {
        ...publicReport,
        Unknown: [
          ...publicReport.Unknown,
          { name: "unionfs", versions: ["4.6.0"] },
        ],
      },
      "public",
    ).violations,
    [
      "unionfs: Unknown; explicit legal review is required before release.",
    ],
  );

  assert.deepEqual(
    evaluateProductionLicenseReport(
      {
        "(MIT OR GPL-3.0-or-later)": [
          { name: "jszip", versions: ["3.10.1"] },
        ],
        BSD: [{ name: "duck", versions: ["0.1.12"] }],
      },
      "public",
    ).violations,
    [
      "buffers: reviewed public exception is unused in the production license inventory.",
    ],
  );

  const privateReport = {
    Unknown: [
      { name: "@browserbasehq/sdk", versions: ["2.12.0"] },
      { name: "stripe-replit-sync", versions: ["1.0.0"] },
      { name: "buffers", versions: ["0.1.1"] },
      { name: "unionfs", versions: ["4.6.0"] },
    ],
    "SEE LICENSE IN LICENSE FILE IN GIT REPOSITORY": [
      { name: "@nangohq/frontend", versions: ["0.70.6"] },
      { name: "@nangohq/types", versions: ["0.70.6"] },
    ],
    "(MIT OR GPL-3.0-or-later)": [
      { name: "jszip", versions: ["3.10.1"] },
    ],
    BSD: [{ name: "duck", versions: ["0.1.12"] }],
  };
  assert.deepEqual(
    evaluateProductionLicenseReport(privateReport, "private").violations,
    [],
  );
  assert.match(
    evaluateProductionLicenseReport(privateReport, "unknown-project")
      .violations[0],
    /unknown repository scope/,
  );

  const changedLicense = {
    ...publicReport,
    "(MIT OR GPL-3.0-or-later)": [],
    "AGPL-3.0-only": [{ name: "jszip", versions: ["3.10.1"] }],
  };
  assert.match(
    evaluateProductionLicenseReport(changedLicense, "public").violations[0],
    /jszip: AGPL-3\.0-only/,
  );
  for (const license of ["UNLICENSED", "Proprietary", "LicenseRef-Restricted"]) {
    assert.match(
      evaluateProductionLicenseReport(
        { ...publicReport, [license]: [{ name: "new-package", versions: ["1.0.0"] }] },
        "public",
      ).violations[0],
      /new-package/,
    );
  }
  for (const malformed of [
    { MIT: [{}] },
    { MIT: "not-an-array" },
    {
      MIT: [
        {
          name: "safe-package",
          versions: ["1.0.0"],
          license: "AGPL-3.0-only",
        },
      ],
    },
  ]) {
    assert.ok(
      evaluateProductionLicenseReport(malformed, "public").violations.some(
        (violation) => /malformed|must be an array/.test(violation),
      ),
    );
  }
});

test("public license scope permits only the trusted private staging lane", () => {
  assert.equal(
    repositoryScopeError({
      scope: "public",
      repository: "dahshanlabs/agentmug-core",
      githubRepository: "dahshanlabs/agentmug-core",
    }),
    undefined,
  );
  assert.equal(
    repositoryScopeError({
      scope: "public",
      repository: "dahshanlabs/agentmug-core",
      githubRepository: "dahshanlabs/AgentMug",
      stagedFrom: "dahshanlabs/AgentMug",
    }),
    undefined,
  );
  assert.match(
    repositoryScopeError({
      scope: "public",
      repository: "dahshanlabs/agentmug-core",
      githubRepository: "attacker/fork",
      stagedFrom: "dahshanlabs/AgentMug",
    }),
    /public scope requires repository/,
  );
});
