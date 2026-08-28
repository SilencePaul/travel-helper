const privateCollections = ["membership_index", "auth_bootstrap", "auth_oauth_states", "auth_sessions", "auth_exchange_codes", "members", "trip_audits", "trip_idempotency"];

export function collectionRules(tripRule) {
  return [
    { name: "trips", rule: tripRule },
    ...privateCollections.map((name) => ({ name, rule: { read: false, write: false } })),
  ];
}
