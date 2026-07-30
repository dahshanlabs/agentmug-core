import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "guard-public-publish.mjs",
);
const emptyHome = path.join(
  tmpdir(),
  `agentmug-publish-guard-empty-home-${process.pid}`,
);
const validEnvironment = {
  AGENTMUG_PUBLIC_REPOSITORY: "dahshanlabs/agentmug-core",
  AGENTMUG_RELEASE_ENABLED: "true",
  AGENTMUG_REPOSITORY_VISIBILITY: "public",
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "dahshanlabs/agentmug-core",
  GITHUB_REF: "refs/heads/main",
  GITHUB_REF_PROTECTED: "true",
  GITHUB_SHA: "a".repeat(40),
  GITHUB_WORKFLOW_REF:
    "dahshanlabs/agentmug-core/.github/workflows/release.yml@refs/heads/main",
  AGENTMUG_PUBLISH_ENVIRONMENT: "npm-production",
  AGENTMUG_RELEASE_ARTIFACT_ID: "123456",
  AGENTMUG_RELEASE_ARTIFACT_SHA256: "b".repeat(64),
  AGENTMUG_RELEASE_SOURCE_SHA: "a".repeat(40),
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid/oidc",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "ephemeral-test-token",
  HOME: emptyHome,
  USERPROFILE: emptyHome,
};

function run(overrides = {}) {
  const env = { ...process.env };
  for (const key of [
    "AGENTMUG_PUBLIC_REPOSITORY",
    "AGENTMUG_RELEASE_ENABLED",
    "AGENTMUG_REPOSITORY_VISIBILITY",
    "GITHUB_ACTIONS",
    "GITHUB_REPOSITORY",
    "GITHUB_REF",
    "GITHUB_REF_PROTECTED",
    "GITHUB_SHA",
    "GITHUB_WORKFLOW_REF",
    "AGENTMUG_PUBLISH_ENVIRONMENT",
    "AGENTMUG_RELEASE_ARTIFACT_ID",
    "AGENTMUG_RELEASE_ARTIFACT_SHA256",
    "AGENTMUG_RELEASE_SOURCE_SHA",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "NODE_AUTH_TOKEN",
    "NPM_TOKEN",
    "NPM_CONFIG_USERCONFIG",
    "HOME",
    "USERPROFILE",
  ]) {
    delete env[key];
  }
  Object.assign(env, validEnvironment, overrides);
  return spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env,
  });
}

test("the complete public OIDC context passes", () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
});

test("release enablement is explicit", () => {
  const result = run({ AGENTMUG_RELEASE_ENABLED: "false" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /publishing is disabled/);
});

test("both GitHub OIDC request values are required", () => {
  const result = run({ ACTIONS_ID_TOKEN_REQUEST_TOKEN: "" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /GitHub OIDC is unavailable/);
});

test("long-lived npm credentials fail closed", () => {
  const result = run({ NPM_TOKEN: "must-not-be-used" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /long-lived npm tokens are forbidden/);
});

test("publishing requires the protected main branch", () => {
  const result = run({ GITHUB_REF_PROTECTED: "false" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /branch protection/);
});

test("publishing is bound to the canonical workflow", () => {
  const result = run({
    GITHUB_WORKFLOW_REF:
      "dahshanlabs/agentmug-core/.github/workflows/other.yml@refs/heads/main",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected trusted workflow/);
});

test("publishing requires an immutable verified artifact identity", () => {
  const result = run({ AGENTMUG_RELEASE_ARTIFACT_SHA256: "not-a-digest" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /artifact SHA-256/);
});

test("the verified source SHA must match the workflow commit", () => {
  const result = run({ AGENTMUG_RELEASE_SOURCE_SHA: "c".repeat(40) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source SHA must exactly match/);
});

test("credential-bearing npm config fails closed", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "agentmug-npmrc-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const npmrc = path.join(directory, ".npmrc");
  writeFileSync(
    npmrc,
    "//registry.npmjs.org/:_authToken=long-lived-token\n",
    "utf8",
  );

  const result = run({ NPM_CONFIG_USERCONFIG: npmrc });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /credential-bearing npm config is forbidden/);
});
