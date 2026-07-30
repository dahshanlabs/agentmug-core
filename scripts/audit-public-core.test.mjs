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
  validateTrackedBuildOutputs,
} from "./audit-public-core.mjs";

function runGit(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

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
