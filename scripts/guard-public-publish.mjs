import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const expectedRepository = (
  process.env.AGENTMUG_PUBLIC_REPOSITORY || "dahshanlabs/agentmug-core"
).toLowerCase();
const actualRepository = (process.env.GITHUB_REPOSITORY || "").toLowerCase();
const visibility = (
  process.env.AGENTMUG_REPOSITORY_VISIBILITY || ""
).toLowerCase();
const expectedWorkflow = `${expectedRepository}/.github/workflows/release.yml@refs/heads/main`;
const workflowRef = (process.env.GITHUB_WORKFLOW_REF || "").toLowerCase();
const sourceSha = (process.env.AGENTMUG_RELEASE_SOURCE_SHA || "").toLowerCase();
const githubSha = (process.env.GITHUB_SHA || "").toLowerCase();

const failures = [];

if ((process.env.AGENTMUG_RELEASE_ENABLED || "").toLowerCase() !== "true") {
  failures.push(
    "publishing is disabled; set repository variable AGENTMUG_RELEASE_ENABLED=true only after launch approval",
  );
}

if (process.env.GITHUB_ACTIONS !== "true") {
  failures.push("publishing is allowed only from GitHub Actions");
}

if (actualRepository !== expectedRepository) {
  failures.push(
    `expected repository ${expectedRepository}, received ${actualRepository || "none"}`,
  );
}

if (visibility !== "public") {
  failures.push(
    `expected a public source repository, received visibility ${visibility || "unknown"}`,
  );
}

if (process.env.GITHUB_REF !== "refs/heads/main") {
  failures.push(
    `publishing is restricted to refs/heads/main, received ${process.env.GITHUB_REF || "none"}`,
  );
}

if (process.env.GITHUB_REF_PROTECTED !== "true") {
  failures.push("the main ref must have GitHub branch protection enabled");
}

if (workflowRef !== expectedWorkflow) {
  failures.push(
    `expected trusted workflow ${expectedWorkflow}, received ${workflowRef || "none"}`,
  );
}

if (process.env.AGENTMUG_PUBLISH_ENVIRONMENT !== "npm-production") {
  failures.push(
    "publishing requires the protected npm-production GitHub environment",
  );
}

if (!/^[1-9][0-9]*$/.test(process.env.AGENTMUG_RELEASE_ARTIFACT_ID || "")) {
  failures.push("an immutable numeric release artifact id is required");
}

if (
  !/^[a-f0-9]{64}$/i.test(process.env.AGENTMUG_RELEASE_ARTIFACT_SHA256 || "")
) {
  failures.push("a release artifact SHA-256 is required");
}

if (!/^[a-f0-9]{40}$/.test(sourceSha) || sourceSha !== githubSha) {
  failures.push(
    "the verified release source SHA must exactly match the workflow commit",
  );
}

if (
  !process.env.ACTIONS_ID_TOKEN_REQUEST_URL ||
  !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
) {
  failures.push("GitHub OIDC is unavailable; id-token: write is required");
}

if (process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN) {
  failures.push(
    "long-lived npm tokens are forbidden; use npm OIDC trusted publishing",
  );
}

const npmConfigPaths = new Set(
  [
    process.env.NPM_CONFIG_USERCONFIG,
    process.env.HOME && path.join(process.env.HOME, ".npmrc"),
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, ".npmrc"),
    path.join(process.cwd(), ".npmrc"),
  ].filter(Boolean),
);
for (const npmConfigPath of npmConfigPaths) {
  if (
    existsSync(npmConfigPath) &&
    /(?:^|\n)\s*(?:(?:\/\/[^:\n]+\/?:)?[:]?_authToken|_auth|username|password)\s*=/i.test(
      readFileSync(npmConfigPath, "utf8"),
    )
  ) {
    failures.push(
      `credential-bearing npm config is forbidden (${npmConfigPath})`,
    );
  }
}

if (failures.length > 0) {
  console.error("AgentMug public publish gate failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `AgentMug public publish gate passed (${actualRepository}, explicit enablement, OIDC, public source).`,
);
