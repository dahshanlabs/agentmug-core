import assert from "node:assert/strict";
import test from "node:test";
import {
  actionResult,
  aggregateActionOutcome,
  deriveRunOutcome,
  isActionResult,
  proofSatisfies,
  type RunActionReceipt,
} from "./types";

function action(
  status: RunActionReceipt["status"],
  proof: RunActionReceipt["proof"],
): Pick<RunActionReceipt, "required" | "status" | "proof" | "requiredProof"> {
  return { required: true, status, proof, requiredProof: "delivered" };
}

test("provider acceptance does not satisfy delivery proof", () => {
  assert.equal(proofSatisfies("accepted", "delivered"), false);
  assert.equal(
    aggregateActionOutcome([action("pending", "accepted")]),
    "pending",
  );
});

test("an executor cannot claim success with insufficient proof", () => {
  assert.equal(
    aggregateActionOutcome([action("succeeded", "accepted")]),
    "unknown",
  );
});

test("mixed verified and failed required actions are partial", () => {
  assert.equal(
    aggregateActionOutcome([
      action("succeeded", "delivered"),
      action("failed", "none"),
    ]),
    "partial",
  );
});

test("execution and action outcome stay separate", () => {
  assert.equal(deriveRunOutcome("completed", []), "succeeded");
  assert.equal(deriveRunOutcome("failed", []), "failed");
  assert.equal(
    deriveRunOutcome("failed", [action("succeeded", "delivered")]),
    "partial",
  );
});

test("a proven not-attempted approval-gated intent is not a required effect", () => {
  const notAttempted = { ...action("failed", "none"), required: false };
  assert.equal(deriveRunOutcome("paused", [notAttempted]), "pending");
  assert.equal(deriveRunOutcome("completed", [notAttempted]), "succeeded");
});

test("action envelopes are explicit and do not collide with ordinary results", () => {
  const wrapped = actionResult(
    { status: "queued" },
    { status: "pending", proof: "accepted" },
  );
  assert.equal(isActionResult(wrapped), true);
  assert.equal(isActionResult({ value: {}, action: {} }), false);
});
