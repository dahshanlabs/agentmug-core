import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  compareSemver,
  parseChangeset,
  readReleasePolicy,
  selectCoreChangesets,
  validatePublicReleaseState,
} from "./public-core-release-state.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const privatePolicyPath = path.join(
  repositoryRoot,
  "config",
  "public-core",
  "config",
  "public-core-release.json",
);
const publicPolicyPath = path.join(
  repositoryRoot,
  "config",
  "public-core-release.json",
);
let policyPath;
try {
  await access(privatePolicyPath);
  policyPath = privatePolicyPath;
} catch {
  policyPath = publicPolicyPath;
}

async function createFixture(
  t,
  { versions, changesets = {}, includeN8nInWorkspace = false },
) {
  const root = await mkdtemp(path.join(tmpdir(), "agentmug-release-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const policy = await readReleasePolicy(policyPath);

  await mkdir(path.join(root, ".changeset"), { recursive: true });
  await writeFile(
    path.join(root, ".changeset", "config.json"),
    `${JSON.stringify({ ignore: [] }, null, 2)}\n`,
  );
  await writeFile(
    path.join(root, "pnpm-workspace.yaml"),
    `packages:
  - packages/*
  - examples/*
${includeN8nInWorkspace ? "  - integrations/*\n" : ""}`,
  );
  for (const [filename, content] of Object.entries(changesets)) {
    await writeFile(path.join(root, ".changeset", filename), content);
  }

  for (const [packageName, entry] of Object.entries(policy.releasePackages)) {
    const directory = path.join(root, entry.directory);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "package.json"),
      `${JSON.stringify(
        { name: packageName, version: versions[packageName] },
        null,
        2,
      )}\n`,
    );
  }

  return { policy, root };
}

const initialChangeset = `---
"@agentmug/runtime": patch
"@agentmug/cli": patch
"@agentmug/mcp-bridge": patch
"@agentmug/otel": major
---

Move the next releases to Apache-2.0.
`;

test("the repository's pending release files match its release lane", async () => {
  const policy = await readReleasePolicy(policyPath);
  const selected = await selectCoreChangesets({
    root: repositoryRoot,
    policy,
    allowNonCore: policyPath === privatePolicyPath,
  });
  for (const changeset of selected) {
    for (const packageName of changeset.releases.keys()) {
      assert.ok(policy.releasePackages[packageName]);
    }
  }
});

test("private-only changesets are ignored", async (t) => {
  const { policy, root } = await createFixture(t, {
    versions: {
      "@agentmug/runtime": "0.14.0",
      "@agentmug/cli": "0.7.0",
      "@agentmug/mcp-bridge": "0.2.1",
      "@agentmug/otel": "13.0.0",
    },
    changesets: {
      "private.md": `---
"@workspace/api-server": patch
---

Private change.
`,
    },
  });
  assert.deepEqual(
    await selectCoreChangesets({ root, policy, allowNonCore: true }),
    [],
  );
});

test("mixed core and private changesets fail closed", async (t) => {
  const { policy, root } = await createFixture(t, {
    versions: {
      "@agentmug/runtime": "0.14.0",
      "@agentmug/cli": "0.7.0",
      "@agentmug/mcp-bridge": "0.2.1",
      "@agentmug/otel": "13.0.0",
    },
    changesets: {
      "mixed.md": `---
"@agentmug/runtime": patch
"@workspace/api-server": patch
---

Mixed change.
`,
    },
  });
  await assert.rejects(
    selectCoreChangesets({ root, policy }),
    /core and non-core packages cannot share a changeset/,
  );
});

test("n8n changesets are routed away from core publishing", async (t) => {
  const { policy, root } = await createFixture(t, {
    versions: {
      "@agentmug/runtime": "0.14.0",
      "@agentmug/cli": "0.7.0",
      "@agentmug/mcp-bridge": "0.2.1",
      "@agentmug/otel": "13.0.0",
    },
    changesets: {
      "n8n.md": `---
"n8n-nodes-agentmug": patch
---

n8n change.
`,
    },
  });
  await assert.rejects(
    selectCoreChangesets({ root, policy }),
    /separate-lane package cannot enter the core release/,
  );
});

test("pre-version state requires the complete initial license changeset", async (t) => {
  const versions = {
    "@agentmug/runtime": "0.14.0",
    "@agentmug/cli": "0.7.0",
    "@agentmug/mcp-bridge": "0.2.1",
    "@agentmug/otel": "13.0.0",
  };
  const valid = await createFixture(t, {
    versions,
    changesets: { "apache-core-license.md": initialChangeset },
  });
  assert.equal(
    (await validatePublicReleaseState(valid)).state,
    "pending-first-apache-release",
  );

  const missing = await createFixture(t, { versions });
  await assert.rejects(
    validatePublicReleaseState(missing),
    /required until every core package reaches its first Apache version/,
  );
});

test("post-version state passes after Changesets consumes the initial file", async (t) => {
  const fixture = await createFixture(t, {
    versions: {
      "@agentmug/runtime": "0.15.0",
      "@agentmug/cli": "0.8.0",
      "@agentmug/mcp-bridge": "0.3.0",
      "@agentmug/otel": "14.0.0",
    },
  });
  assert.equal((await validatePublicReleaseState(fixture)).state, "versioned");
});

test("partial first-Apache state fails closed", async (t) => {
  const fixture = await createFixture(t, {
    versions: {
      "@agentmug/runtime": "0.15.0",
      "@agentmug/cli": "0.7.0",
      "@agentmug/mcp-bridge": "0.2.1",
      "@agentmug/otel": "13.0.0",
    },
    changesets: { "apache-core-license.md": initialChangeset },
  });
  await assert.rejects(
    validatePublicReleaseState(fixture),
    /partial first-Apache state is forbidden/,
  );
});

test("a stale initial changeset fails after versioning", async (t) => {
  const fixture = await createFixture(t, {
    versions: {
      "@agentmug/runtime": "0.15.0",
      "@agentmug/cli": "0.8.0",
      "@agentmug/mcp-bridge": "0.3.0",
      "@agentmug/otel": "14.0.0",
    },
    changesets: { "apache-core-license.md": initialChangeset },
  });
  await assert.rejects(
    validatePublicReleaseState(fixture),
    /stale initial-license changeset/,
  );
});

test("the dedicated n8n lane must stay outside the core Changesets workspace", async (t) => {
  const fixture = await createFixture(t, {
    versions: {
      "@agentmug/runtime": "0.15.0",
      "@agentmug/cli": "0.8.0",
      "@agentmug/mcp-bridge": "0.3.0",
      "@agentmug/otel": "14.0.0",
    },
    includeN8nInWorkspace: true,
  });
  await assert.rejects(
    validatePublicReleaseState(fixture),
    /separate-lane package n8n-nodes-agentmug would enter core Changesets/,
  );
});

test("Changesets parsing and semantic-version ordering are strict", () => {
  const parsed = parseChangeset(
    `---
'@agentmug/runtime': minor
---

Feature.
`,
    "feature.md",
  );
  assert.equal(parsed.releases.get("@agentmug/runtime"), "minor");
  assert.equal(compareSemver("0.15.0", "0.14.9"), 1);
  assert.equal(compareSemver("1.0.0-rc.1", "1.0.0"), -1);
  assert.throws(
    () => parseChangeset("---\nnot yaml\n---\n", "broken.md"),
    /invalid Changesets release entry/,
  );
});
