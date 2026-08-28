import assert from "node:assert/strict";
import test from "node:test";
import { collectionRules } from "./cloudbaseSecurity.mjs";

test("allows browser reads only for trip members", () => {
  const rules = collectionRules({ read: "auth != null && auth.uid in doc.memberUids", write: false });
  assert.deepEqual(rules[0], { name: "trips", rule: { read: "auth != null && auth.uid in doc.memberUids", write: false } });
  assert.equal(rules.slice(1).every(({ rule }) => rule.read === false && rule.write === false), true);
  assert.deepEqual(rules.find(({ name }) => name === "auth_exchange_codes"), {
    name: "auth_exchange_codes",
    rule: { read: false, write: false },
  });
  for (const name of ["trip_preferences", "trip_preference_summaries", "trip_candidates", "trip_evidence_snapshots", "trip_candidate_feedback", "trip_confirmation_receipts", "trip_tentative_placements", "trip_decision_audits", "trip_decision_events", "trip_decision_meta", "trip_decision_indexes", "trip_decision_idempotency", "trip_agent_runs", "trip_agent_idempotency"]) {
    assert.deepEqual(rules.find((entry) => entry.name === name), { name, rule: { read: false, write: false } });
  }
});
