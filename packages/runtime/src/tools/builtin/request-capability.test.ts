import assert from "node:assert/strict";
import test from "node:test";
import { requestCapabilityDefinition } from "./request-capability";

test("a capability gap is a required pending proof obligation", () => {
  assert.deepEqual(requestCapabilityDefinition.effect, {
    provider: "agentmug",
    operation: "capability_gap_resolution",
    requiredProof: "postcondition_verified",
    verification: "manual",
    required: true,
  });
});
