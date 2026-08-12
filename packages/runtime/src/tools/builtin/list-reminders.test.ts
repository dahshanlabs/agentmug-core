import assert from "node:assert/strict";
import test from "node:test";
import { listRemindersDefinition } from "./list-reminders";
import { isSideEffecting, readsUntrustedContent } from "../side-effect-gate";

test("list_reminders is a bounded read-only tool", () => {
  assert.equal(listRemindersDefinition.name, "list_reminders");
  assert.equal(listRemindersDefinition.effect, undefined);
  assert.equal(readsUntrustedContent("list_reminders"), true);
  assert.equal(isSideEffecting("list_reminders"), false);
});
