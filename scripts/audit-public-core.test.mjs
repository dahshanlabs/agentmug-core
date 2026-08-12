import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectFiles,
  containsForbiddenPersonalAddress,
  findForbiddenContentLabels,
  validatePublicRootIdentity,
  validateLicenseGateScope,
  validateRuntimeTestCoverage,
  validateVersionPackageLockSync,
  validateTrackedBuildOutputs,
} from "./audit-public-core.mjs";

function runGit(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

test("public root identity cannot select license policy by name alone", () => {
  const canonical = {
    name: "agentmug-core",
    private: true,
    license: "Apache-2.0",
    repository: {
      url: "https://github.com/dahshanlabs/agentmug-core.git",
    },
  };
  const violations = [];
  validatePublicRootIdentity(
    canonical,
    "dahshanlabs/agentmug-core",
    violations,
  );
  assert.deepEqual(violations, []);
  validatePublicRootIdentity(
    { ...canonical, repository: { url: "https://github.com/other/repo.git" } },
    "dahshanlabs/agentmug-core",
    violations,
  );
  assert.deepEqual(violations, [
    "root package.json must identify the private Apache-2.0 dahshanlabs/agentmug-core repository",
  ]);
});

test("public license exceptions require the canonical repository scope", () => {
  const violations = [];
  validateLicenseGateScope(
    {
      scripts: {
        "security:licenses":
          "node scripts/check-public-package-licenses.mjs && node scripts/check-production-licenses.mjs --scope public --repository dahshanlabs/agentmug-core",
      },
    },
    "dahshanlabs/agentmug-core",
    violations,
  );
  assert.deepEqual(violations, []);
  validateLicenseGateScope(
    {
      scripts: {
        "security:licenses":
          "node scripts/check-production-licenses.mjs --scope public",
      },
    },
    "dahshanlabs/agentmug-core",
    violations,
  );
  assert.deepEqual(violations, [
    "root package.json: security:licenses must bind public exceptions to dahshanlabs/agentmug-core",
  ]);
});

test("public verification cannot omit a runtime safety suite", () => {
  const required = [
    "test:artifact-contract",
    "test:capability-execute",
    "test:architectures",
    "test:source-contract",
    "test:engine-sources",
    "test:evaluations",
    "test:net-guard",
    "test:llm-routing",
    "test:actions",
    "test:schema-drift",
    "test:deployment-contract",
  ];
  const command = required
    .map((script) => `pnpm --filter @agentmug/runtime run ${script}`)
    .join(" && ");
  const violations = [];
  validateRuntimeTestCoverage({ scripts: { test: command } }, violations);
  assert.deepEqual(violations, []);

  validateRuntimeTestCoverage(
    {
      scripts: {
        test: command.replace(
          "pnpm --filter @agentmug/runtime run test:schema-drift",
          "echo skipped",
        ),
      },
    },
    violations,
  );
  assert.deepEqual(violations, [
    "root package.json: public verification must run runtime test:schema-drift",
  ]);

  const textualBypass = [];
  validateRuntimeTestCoverage(
    {
      scripts: {
        test: command.replace(
          "pnpm --filter @agentmug/runtime run test:schema-drift",
          'echo "pnpm --filter @agentmug/runtime run test:schema-drift"',
        ),
      },
    },
    textualBypass,
  );
  assert.deepEqual(textualBypass, [
    "root package.json: public verification must run runtime test:schema-drift",
  ]);
});

test("versioning refreshes the frozen lockfile before resealing the manifest", () => {
  const safe =
    "changeset version && pnpm install --lockfile-only --ignore-scripts --no-frozen-lockfile && node scripts/audit-public-core.mjs --root . --public-repository dahshanlabs/agentmug-core --write-manifest";
  const violations = [];
  validateVersionPackageLockSync(
    { scripts: { "version-packages": safe } },
    violations,
  );
  assert.deepEqual(violations, []);

  validateVersionPackageLockSync(
    {
      scripts: {
        "version-packages": safe.replace(
          "pnpm install --lockfile-only --ignore-scripts --no-frozen-lockfile && ",
          "",
        ),
      },
    },
    violations,
  );
  assert.deepEqual(violations, [
    "root package.json: version-packages must refresh the lockfile without lifecycle scripts before resealing the manifest",
  ]);

  const textualBypass = [];
  validateVersionPackageLockSync(
    {
      scripts: {
        "version-packages": `echo '${safe}' && changeset version && node scripts/audit-public-core.mjs --root . --public-repository dahshanlabs/agentmug-core --write-manifest`,
      },
    },
    textualBypass,
  );
  assert.deepEqual(textualBypass, [
    "root package.json: version-packages must refresh the lockfile without lifecycle scripts before resealing the manifest",
  ]);
});

test("fingerprinted email detection contains no reversible private fixtures", async () => {
  const consumerAddress = ["fixture", "gmail.com"].join("@");
  const fixtureFingerprint = createHash("sha256")
    .update(consumerAddress, "utf8")
    .digest("hex");
  assert.equal(
    containsForbiddenPersonalAddress(
      `contact ${consumerAddress}`,
      new Set([fixtureFingerprint]),
    ),
    true,
  );
  assert.ok(
    !findForbiddenContentLabels(
      `legal attribution ${consumerAddress}`,
    ).includes("personal fixture address"),
  );
  assert.ok(
    !findForbiddenContentLabels("contact me@example.com").includes(
      "personal fixture address",
    ),
  );

  const auditSource = await readFile(
    new URL("./audit-public-core.mjs", import.meta.url),
    "utf8",
  );
  const plaintextConsumerAddress =
    /\b[A-Z0-9._%+-]+@(?:gmail|hotmail|outlook)\.com\b/i;
  assert.doesNotMatch(auditSource, plaintextConsumerAddress);
  assert.doesNotMatch(auditSource, /Buffer\.from\([^)]*base64/i);

  for (const match of auditSource.matchAll(
    /["'`]([A-Za-z0-9+/]{16,}={0,2})["'`]/g,
  )) {
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    assert.doesNotMatch(decoded, /[A-Z0-9._%+-]+@[A-Z0-9.-]+/i);
  }
});

test("audit scans generated dist output instead of treating it as invisible", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentmug-audit-dist-"));
  context.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(path.join(root, "packages", "runtime", "dist"), {
    recursive: true,
  });
  await writeFile(
    path.join(root, "packages", "runtime", "dist", "index.js"),
    "export const built = true;\n",
    "utf8",
  );

  const files = await collectFiles(root);
  assert.deepEqual(
    files.map(({ relative }) => relative),
    ["packages/runtime/dist/index.js"],
  );
});

test("audit excludes Git metadata from clones and linked worktrees", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentmug-audit-git-"));
  context.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await writeFile(path.join(root, ".git"), "gitdir: ../metadata\n", "utf8");
  await mkdir(path.join(root, "nested", ".git"), { recursive: true });
  await writeFile(
    path.join(root, "nested", ".git", "config"),
    "private metadata\n",
    "utf8",
  );
  await writeFile(path.join(root, "nested", "index.js"), "export {};\n", "utf8");

  const files = await collectFiles(root);
  assert.deepEqual(
    files.map(({ relative }) => relative),
    ["nested/index.js"],
  );
});

test("audit rejects generated dist files committed to a public checkout", async (context) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "agentmug-audit-tracked-dist-"),
  );
  context.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  runGit(["init", "--quiet"], root);
  await mkdir(path.join(root, "packages", "runtime", "dist"), {
    recursive: true,
  });
  await writeFile(
    path.join(root, "packages", "runtime", "dist", "index.js"),
    "export const built = true;\n",
    "utf8",
  );
  runGit(["add", "--force", "packages/runtime/dist/index.js"], root);

  const violations = [];
  await validateTrackedBuildOutputs(root, violations);
  assert.deepEqual(violations, [
    "packages/runtime/dist/index.js: generated dist files must never be tracked",
  ]);
});
