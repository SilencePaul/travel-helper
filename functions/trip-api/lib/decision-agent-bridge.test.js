const assert = require("node:assert/strict");
const { generateKeyPairSync, sign } = require("node:crypto");
const test = require("node:test");

const { canonicalJson, createDecisionAgentBridge, sha256Base64Url } = require("./decision-agent-bridge.js");

function signature(privateKey, value) {
  return sign("sha256", Buffer.from(canonicalJson(value)), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
}

function createTransaction(run) {
  const runs = new Map([[run.id, structuredClone(run)]]);
  const idempotency = new Map();
  const collection = (name) => {
    const store = name === "trip_agent_runs" ? runs : idempotency;
    return {
      doc(id) {
        return {
          async get() { const value = store.get(id); return { data: value ? [structuredClone(value)] : [] }; },
          async set(value) { store.set(id, structuredClone(value)); },
        };
      },
    };
  };
  return { transaction: { collection }, runs, idempotency };
}

function pendingRun(publicKeyJwk, overrides = {}) {
  return {
    id: "agent-run-1",
    tripId: "trip-1",
    publicKeyJwk,
    pairingCodeHash: sha256Base64Url("pairing-code"),
    scope: ["submitProposalBatch"],
    status: "pending_claim",
    lastSequence: 0,
    revision: 1,
    expiresAt: "2026-08-28T00:15:00.000Z",
    ...overrides,
  };
}

test("a valid P-256 claim consumes the pairing code and activates the run", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const state = createTransaction(pendingRun(publicKey.export({ format: "jwk" })));
  const bridge = createDecisionAgentBridge({ now: () => new Date("2026-08-28T00:05:00.000Z") });
  const claim = { agentRunId: "agent-run-1", pairingCode: "pairing-code", clientNonce: "nonce-001" };

  const result = await bridge.claim(state.transaction, { ...claim, signature: signature(privateKey, claim) });

  assert.deepEqual(result, {
    agentRunId: "agent-run-1",
    claimedAt: "2026-08-28T00:05:00.000Z",
    expiresAt: "2026-08-28T00:15:00.000Z",
    nextSequence: 1,
  });
  assert.equal(state.runs.get("agent-run-1").status, "claimed");
  assert.equal(state.runs.get("agent-run-1").pairingCodeHash, undefined);
  assert.equal(state.runs.get("agent-run-1").clientNonce, "nonce-001");
});

test("agent commands require the next sequence and replay the original result once", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const state = createTransaction(pendingRun(publicKey.export({ format: "jwk" }), { status: "claimed", pairingCodeHash: undefined, clientNonce: "nonce-001" }));
  const bridge = createDecisionAgentBridge({ now: () => new Date("2026-08-28T00:05:00.000Z") });
  const command = { agentRunId: "agent-run-1", sequence: 1, idempotencyKey: "proposal-001", action: "submitProposalBatch", payload: { round: 1 } };
  const input = { ...command, signature: signature(privateKey, command) };
  let calls = 0;

  const first = await bridge.run(state.transaction, input, async () => { calls += 1; return { candidates: ["candidate-1"] }; });
  const replay = await bridge.run(state.transaction, input, async () => { calls += 1; return { candidates: ["candidate-2"] }; });

  assert.deepEqual(first, { result: { candidates: ["candidate-1"] }, replayed: false });
  assert.deepEqual(replay, { result: { candidates: ["candidate-1"] }, replayed: true });
  assert.equal(calls, 1);
  assert.equal(state.runs.get("agent-run-1").lastSequence, 1);
});

test("authorization is rechecked after signature verification before returning an idempotent replay", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const state = createTransaction(pendingRun(publicKey.export({ format: "jwk" }), {
    status: "claimed",
    pairingCodeHash: undefined,
  }));
  const bridge = createDecisionAgentBridge({ now: () => new Date("2026-08-28T00:05:00.000Z") });
  const command = { agentRunId: "agent-run-1", sequence: 1, idempotencyKey: "context-001", action: "getDecisionContext", payload: {} };
  const input = { ...command, signature: signature(privateKey, command) };
  let authorized = true;
  let authorizationCalls = 0;
  const authorize = async () => {
    authorizationCalls += 1;
    if (!authorized) {
      const error = new Error("ADMIN_REQUIRED");
      error.code = "ADMIN_REQUIRED";
      throw error;
    }
  };

  await bridge.run(state.transaction, input, async () => ({ context: "safe" }), authorize);
  authorized = false;

  await assert.rejects(
    () => bridge.run(state.transaction, input, async () => ({ context: "must-not-return" }), authorize),
    { code: "ADMIN_REQUIRED" },
  );
  assert.equal(authorizationCalls, 2);
});

test("self-revoke is a signed unscoped control action with transactional sequence and replay", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const state = createTransaction(pendingRun(publicKey.export({ format: "jwk" }), {
    status: "claimed",
    pairingCodeHash: undefined,
    revision: 2,
  }));
  const bridge = createDecisionAgentBridge({ now: () => new Date("2026-08-28T00:05:00.000Z") });
  const command = {
    agentRunId: "agent-run-1",
    sequence: 1,
    idempotencyKey: "self-revoke-001",
    action: "revokeAgentRunSelf",
    payload: {},
  };
  const input = { ...command, signature: signature(privateKey, command) };
  let operationCalls = 0;

  const authorize = async () => { throw new Error("self revoke must not require current admin"); };
  const first = await bridge.run(state.transaction, input, async () => { operationCalls += 1; return { leaked: true }; }, authorize);
  const replay = await bridge.run(state.transaction, input, async () => { operationCalls += 1; return { leaked: true }; }, authorize);

  assert.deepEqual(first, {
    result: { agentRunId: "agent-run-1", revokedAt: "2026-08-28T00:05:00.000Z" },
    replayed: false,
  });
  assert.deepEqual(replay, { result: first.result, replayed: true });
  assert.equal(operationCalls, 0);
  assert.equal(state.runs.get("agent-run-1").status, "revoked");
  assert.equal(state.runs.get("agent-run-1").revokedAt, "2026-08-28T00:05:00.000Z");
  assert.equal(state.runs.get("agent-run-1").lastSequence, 1);
  assert.equal(state.runs.get("agent-run-1").revision, 3);
  assert.equal(state.idempotency.size, 1);

  const newEnvelope = { ...command, sequence: 2, idempotencyKey: "self-revoke-002" };
  await assert.rejects(
    () => bridge.run(state.transaction, { ...newEnvelope, signature: signature(privateKey, newEnvelope) }, async () => ({})),
    { code: "INVALID_AGENT_CLAIM" },
  );
});

test("a tampered command signature and an ungranted scope are rejected", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const state = createTransaction(pendingRun(publicKey.export({ format: "jwk" }), { status: "claimed", pairingCodeHash: undefined }));
  const bridge = createDecisionAgentBridge({ now: () => new Date("2026-08-28T00:05:00.000Z") });
  const signed = { agentRunId: "agent-run-1", sequence: 1, idempotencyKey: "proposal-001", action: "submitProposalBatch", payload: { round: 1 } };

  await assert.rejects(
    () => bridge.run(state.transaction, { ...signed, payload: { round: 2 }, signature: signature(privateKey, signed) }, async () => ({})),
    { code: "INVALID_AGENT_CLAIM" },
  );
  const blocked = { ...signed, action: "appendEvidenceSnapshot" };
  await assert.rejects(
    () => bridge.run(state.transaction, { ...blocked, signature: signature(privateKey, blocked) }, async () => ({})),
    { code: "AGENT_SCOPE_FORBIDDEN" },
  );
});

test("an exact claim retry returns the original result after expiry or revocation without storing the pairing code", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const state = createTransaction(pendingRun(publicKey.export({ format: "jwk" })));
  let clock = new Date("2026-08-28T00:05:00.000Z");
  const bridge = createDecisionAgentBridge({ now: () => clock });
  const claim = { agentRunId: "agent-run-1", pairingCode: "pairing-code", clientNonce: "nonce-001" };
  const input = { ...claim, signature: signature(privateKey, claim) };

  const first = await bridge.claim(state.transaction, input);
  state.runs.get("agent-run-1").status = "revoked";
  clock = new Date("2026-08-28T00:20:00.000Z");
  const replay = await bridge.claim(state.transaction, input);

  assert.deepEqual(replay, first);
  assert.equal(JSON.stringify(state.runs.get("agent-run-1")).includes("pairing-code"), false);
  const changed = { ...claim, clientNonce: "nonce-002" };
  await assert.rejects(
    () => bridge.claim(state.transaction, { ...changed, signature: signature(privateKey, changed) }),
    { code: "INVALID_AGENT_CLAIM" },
  );
});

test("a claim retry accepts a fresh valid ECDSA signature but still verifies every replay", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const state = createTransaction(pendingRun(publicKey.export({ format: "jwk" })));
  const bridge = createDecisionAgentBridge({ now: () => new Date("2026-08-28T00:05:00.000Z") });
  const claim = { agentRunId: "agent-run-1", pairingCode: "pairing-code", clientNonce: "nonce-001" };
  const firstSignature = signature(privateKey, claim);
  let retrySignature = signature(privateKey, claim);
  while (retrySignature === firstSignature) retrySignature = signature(privateKey, claim);

  const first = await bridge.claim(state.transaction, { ...claim, signature: firstSignature });
  const replay = await bridge.claim(state.transaction, { ...claim, signature: retrySignature });

  assert.deepEqual(replay, first);
  await assert.rejects(
    () => bridge.claim(state.transaction, { ...claim, signature: "not-a-valid-signature" }),
    { code: "INVALID_AGENT_CLAIM" },
  );
});

test("an exact claim replay rechecks authorization after verifying its signature", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const state = createTransaction(pendingRun(publicKey.export({ format: "jwk" })));
  const bridge = createDecisionAgentBridge({ now: () => new Date("2026-08-28T00:05:00.000Z") });
  const claim = { agentRunId: "agent-run-1", pairingCode: "pairing-code", clientNonce: "nonce-001" };
  const input = { ...claim, signature: signature(privateKey, claim) };
  let authorized = true;
  const authorize = async () => {
    if (!authorized) {
      const error = new Error("ADMIN_REQUIRED");
      error.code = "ADMIN_REQUIRED";
      throw error;
    }
  };

  await bridge.claim(state.transaction, input, authorize);
  authorized = false;

  await assert.rejects(() => bridge.claim(state.transaction, input, authorize), { code: "ADMIN_REQUIRED" });
  await assert.rejects(
    () => bridge.claim(state.transaction, { ...claim, signature: "invalid-signature" }, authorize),
    { code: "INVALID_AGENT_CLAIM" },
  );
});

test("an unknown agent run is rejected with a stable domain error", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const state = createTransaction(pendingRun(publicKey.export({ format: "jwk" })));
  const bridge = createDecisionAgentBridge({ now: () => new Date("2026-08-28T00:05:00.000Z") });
  const command = { agentRunId: "missing-run", sequence: 1, idempotencyKey: "proposal-001", action: "submitProposalBatch", payload: { round: 1 } };

  await assert.rejects(
    () => bridge.run(state.transaction, { ...command, signature: signature(privateKey, command) }, async () => ({})),
    { code: "INVALID_AGENT_CLAIM" },
  );
});

test("an exact command retry returns the original result after expiry or revocation while new writes stay rejected", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const state = createTransaction(pendingRun(publicKey.export({ format: "jwk" }), { status: "claimed", pairingCodeHash: undefined }));
  let clock = new Date("2026-08-28T00:05:00.000Z");
  const bridge = createDecisionAgentBridge({ now: () => clock });
  const command = { agentRunId: "agent-run-1", sequence: 1, idempotencyKey: "proposal-001", action: "submitProposalBatch", payload: { round: 1 } };
  const input = { ...command, signature: signature(privateKey, command) };
  let calls = 0;

  const first = await bridge.run(state.transaction, input, async () => { calls += 1; return { candidates: ["candidate-1"] }; });
  state.runs.get("agent-run-1").status = "revoked";
  const revokedNext = { ...command, sequence: 2, idempotencyKey: "proposal-revoked-002" };
  await assert.rejects(
    () => bridge.run(state.transaction, { ...revokedNext, signature: signature(privateKey, revokedNext) }, async () => ({})),
    { code: "INVALID_AGENT_CLAIM" },
  );
  clock = new Date("2026-08-28T00:20:00.000Z");
  const replay = await bridge.run(state.transaction, input, async () => { calls += 1; return { candidates: ["candidate-2"] }; });

  assert.deepEqual(replay, { result: first.result, replayed: true });
  assert.equal(calls, 1);
  const changed = { ...command, payload: { round: 2 } };
  await assert.rejects(
    () => bridge.run(state.transaction, { ...changed, signature: signature(privateKey, changed) }, async () => ({})),
    { code: "IDEMPOTENCY_KEY_REUSED" },
  );
  const next = { ...command, sequence: 2, idempotencyKey: "proposal-002" };
  await assert.rejects(
    () => bridge.run(state.transaction, { ...next, signature: signature(privateKey, next) }, async () => ({})),
    { code: "AGENT_RUN_EXPIRED" },
  );
});
