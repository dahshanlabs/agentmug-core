import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { auditPublicCore } from "./audit-public-core.mjs";
import {
  compareSemver,
  listPendingChangesets,
  readReleasePolicy,
  validatePublicReleaseState,
} from "./public-core-release-state.mjs";

const root = process.cwd();
const policy = await readReleasePolicy(
  path.join(root, "config", "public-core-release.json"),
);
const before = await validatePublicReleaseState({ root, policy });

if (before.state === "versioned") {
  console.log(
    "First public-core version transition already completed; nothing to replay.",
  );
  process.exit(0);
}

for (const expected of [
  policy.initialLicenseChangeset,
  "portable-artifact-bindings.md",
]) {
  await access(path.join(root, ".changeset", expected));
}

if (!process.env.npm_execpath) {
  throw new Error(
    "Run this lifecycle proof through pnpm so Changesets is pinned.",
  );
}
execFileSync(
  process.execPath,
  [process.env.npm_execpath, "exec", "changeset", "version"],
  { cwd: root, stdio: "inherit" },
);

for (const [packageName, entry] of Object.entries(policy.releasePackages)) {
  const manifest = JSON.parse(
    await readFile(path.join(root, entry.directory, "package.json"), "utf8"),
  );
  assert.equal(
    compareSemver(manifest.version, entry.firstApacheVersion),
    0,
    `${packageName} should transition to ${entry.firstApacheVersion}`,
  );
}

const pending = await listPendingChangesets(root);
for (const consumed of [
  policy.initialLicenseChangeset,
  "portable-artifact-bindings.md",
]) {
  assert.equal(
    pending.some((changeset) => changeset.filename === consumed),
    false,
    `${consumed} should be consumed by Changesets`,
  );
}

const after = await validatePublicReleaseState({ root, policy });
assert.equal(after.state, "versioned");
assert.equal(after.changesets.length, 0);

await auditPublicCore({
  root,
  publicRepository: "dahshanlabs/agentmug-core",
  writeManifest: true,
});
await auditPublicCore({
  root,
  publicRepository: "dahshanlabs/agentmug-core",
  writeManifest: false,
});

console.log(
  "Public-core lifecycle proof passed: real Changesets transition, exact versions, consumed files, refreshed manifest, and post-version audit.",
);
