import assert from "node:assert/strict";
import { AGENT_FILE_SCHEMA_V1, type AgentFileV1 } from "../format/agent-file";
import {
  canonicalJson,
  deploymentArtifactDigest,
  parseDeploymentManifest,
} from "./registry-contract";

const artifact: AgentFileV1 = {
  $schema: AGENT_FILE_SCHEMA_V1,
  id: "contract-test",
  name: "Contract test",
  description: "Proves stable deployment identity.",
  version: "1.1.0",
  exportedAt: "2026-08-07T12:00:00.000Z",
  blueprint: {
    primaryModel: "claude-sonnet-4-6",
    systemPrompt: "Return the result.",
    tools: ["fetch_url"],
  },
  inputs: { accepts: ["text"] },
};

const reordered = {
  inputs: artifact.inputs,
  blueprint: {
    tools: artifact.blueprint.tools,
    systemPrompt: artifact.blueprint.systemPrompt,
    primaryModel: artifact.blueprint.primaryModel,
  },
  exportedAt: artifact.exportedAt,
  version: artifact.version,
  description: artifact.description,
  name: artifact.name,
  id: artifact.id,
  $schema: artifact.$schema,
};

assert.equal(canonicalJson(artifact), canonicalJson(reordered));
assert.equal(
  await deploymentArtifactDigest(artifact),
  await deploymentArtifactDigest(reordered as AgentFileV1),
);

const digest = await deploymentArtifactDigest(artifact);
const manifest = parseDeploymentManifest({
  version: 1,
  deploymentId: "deployment-test",
  workerName: artifact.name,
  pinnedVersion: 1,
  artifactDigest: digest,
  artifact,
  promises: [{ requirementId: "fetch", tool: "fetch_url" }],
});
assert.equal(manifest.artifact.id, artifact.id);
assert.equal(manifest.promises[0]?.tool, "fetch_url");

assert.throws(
  () =>
    parseDeploymentManifest({
      version: 1,
      deploymentId: "deployment-test",
      workerName: artifact.name,
      pinnedVersion: 1,
      artifactDigest: "not-a-digest",
      artifact,
      promises: [],
    }),
  /SHA-256/,
);

console.log("deployment registry contract: ok");
