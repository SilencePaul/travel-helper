const privateCollections = [
  "membership_index", "auth_bootstrap", "auth_oauth_states", "auth_sessions", "auth_exchange_codes", "members", "trip_audits", "trip_idempotency",
  "trip_preferences", "trip_preference_summaries", "trip_candidates", "trip_evidence_snapshots", "trip_candidate_feedback", "trip_confirmation_receipts",
  "trip_tentative_placements", "trip_decision_audits", "trip_decision_events", "trip_decision_meta", "trip_decision_indexes", "trip_decision_idempotency",
  "trip_agent_runs", "trip_agent_idempotency",
];

export function collectionRules(tripRule) {
  return [
    { name: "trips", rule: tripRule },
    ...privateCollections.map((name) => ({ name, rule: { read: false, write: false } })),
  ];
}
