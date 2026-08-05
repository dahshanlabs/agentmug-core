import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_WORKER_ARCHITECTURE,
  SUPPORTED_WORKER_ARCHITECTURES,
  WORKER_ARCHITECTURE_CAPABILITIES,
  isKnownWorkerArchitecture,
  isSupportedWorkerArchitecture,
} from "./architecture-capabilities";

test("only executable architectures are advertised as supported", () => {
  assert.equal(DEFAULT_WORKER_ARCHITECTURE, "solo");
  assert.deepEqual(
    SUPPORTED_WORKER_ARCHITECTURES.map((capability) => capability.id),
    ["solo"],
  );
  assert.equal(isSupportedWorkerArchitecture("solo"), true);
  assert.equal(isSupportedWorkerArchitecture("pipeline"), false);
});

test("planned portable vocabulary remains known without becoming selectable", () => {
  assert.equal(isKnownWorkerArchitecture("pipeline"), true);
  assert.equal(isKnownWorkerArchitecture("orchestrator_workers"), true);
  assert.equal(isKnownWorkerArchitecture("hierarchical"), true);
  assert.equal(isKnownWorkerArchitecture("made_up"), false);

  const planned = WORKER_ARCHITECTURE_CAPABILITIES.filter(
    (capability) => capability.availability === "planned",
  );
  assert.equal(planned.length, 3);
  for (const capability of planned) {
    assert.ok(capability.futureNeed);
    assert.ok(capability.enablementGate);
  }
});

