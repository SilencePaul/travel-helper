import assert from "node:assert/strict";
import test from "node:test";
import { collectionRules } from "./cloudbaseSecurity.mjs";

test("allows browser reads only for trip members", () => {
  const rules = collectionRules({ read: "auth != null && auth.uid in doc.memberUids", write: false });
  assert.deepEqual(rules[0], { name: "trips", rule: { read: "auth != null && auth.uid in doc.memberUids", write: false } });
  assert.equal(rules.slice(1).every(({ rule }) => rule.read === false && rule.write === false), true);
});
