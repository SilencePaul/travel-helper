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

  assert.equal(result.agentRunId, "agent-run-1");
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
