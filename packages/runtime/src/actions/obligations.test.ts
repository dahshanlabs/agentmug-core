import assert from "node:assert/strict";
import test from "node:test";
import { requiredCapabilityObligations } from "./obligations";

test("portable plans compile only independent critical executable requirements", () => {
  const obligations = requiredCapabilityObligations(
    {
      version: 1,
      resolutions: [
        {
          requirementId: "read",
          requirement: "Read the records",
          status: "supported",
          path: "execute",
          tool: "records.read",
          effect: "read",
          critical: true,
        },
        {
          requirementId: "repeat",
          requirement: "Use the same records",
          status: "supported",
          path: "execute",
          tool: "records.read",
          effect: "read",
          coveredBy: "read",
        },
        {
          requirementId: "optional",
          requirement: "Optionally notify",
          status: "supported",
          path: "execute",
          tool: "notify.send",
          effect: "communicate",
          critical: false,
        },
      ],
    },
    [
      { name: "records.read" },
      {
        name: "notify.send",
        effect: {
          provider: "notify",
          operation: "send",
          requiredProof: "delivered",
          verification: "callback",
        },
      },
    ],
  );

  assert.deepEqual(
    obligations.map((item) => item.requirementId),
    ["read"],
  );
  assert.equal(obligations[0]?.action.provider, "runtime");
  assert.equal(obligations[0]?.effectful, false);
});

test("a missing effectful tool remains an unverified blocking obligation", () => {
  const [obligation] = requiredCapabilityObligations(
    {
      resolutions: [
        {
          requirementId: "send",
          requirement: "Send the result",
          status: "supported",
          path: "execute",
          operationId: "provider.send",
          tool: "provider.send",
          effect: "communicate",
        },
      ],
    },
    [],
  );

  assert.equal(obligation?.action.provider, "unbound");
  assert.equal(obligation?.action.verification, "unavailable");
  assert.equal(obligation?.effectful, true);
});
