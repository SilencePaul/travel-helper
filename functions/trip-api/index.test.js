const assert = require("node:assert/strict");
const test = require("node:test");
const { createTripHandler } = require("./index.js");

test("uses the authenticated custom UID and ignores a payload actor UID", async () => {
  const calls = [];
  const handler = createTripHandler({ getUserInfo: () => ({ customUserId: "fs_member" }), commands: { execute: async (payload, actorUid) => { calls.push({ payload, actorUid }); return { ok: true }; } } });

  const result = await handler({ data: { action: "listMembers", actorUid: "attacker" }, userInfo: { customUserId: "fs_attacker" } });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls[0], { payload: { action: "listMembers", actorUid: "attacker" }, actorUid: "fs_member" });
});

test("uses the trusted CloudBase runtime UID and ignores event or context identities", async () => {
  const calls = [];
  const handler = createTripHandler({ getUserInfo: () => ({ uid: "internal-only" }), commands: { execute: async (_payload, actorUid) => { calls.push(actorUid); return { ok: true }; } } });

  assert.deepEqual(await handler({ data: { action: "listMembers" }, userInfo: { customUserId: "fs_event_admin" } }, { userInfo: { customUserId: "fs_context_admin" } }), { ok: true });
  assert.deepEqual(calls, ["internal-only"]);
});

test("uses the custom user ID exposed by the CloudBase runtime auth", async () => {
  const calls = [];
  const handler = createTripHandler({
    getUserInfo: () => ({ uid: "cloudbase-internal-uid", customUserId: "fs_member" }),
    commands: { execute: async (payload, actorUid) => { calls.push({ payload, actorUid }); return { ok: true }; } },
  });

  assert.deepEqual(await handler({ data: { action: "listMembers" } }), { ok: true });
  assert.deepEqual(calls, [{ payload: { action: "listMembers" }, actorUid: "fs_member" }]);
});

test("returns only stable command errors", async () => {
  const handler = createTripHandler({ getUserInfo: () => ({ customUserId: "fs_member" }), commands: { execute: async () => { const error = new Error("provider details"); error.code = "UNEXPECTED_PROVIDER_ERROR"; throw error; } } });
  assert.deepEqual(await handler({ action: "listMembers" }), { error: "TRIP_API_UNAVAILABLE" });
});

test("wraps decision command success in the shared result envelope", async () => {
  const preference = { id: "preference-1", revision: 1 };
  const handler = createTripHandler({
    getUserInfo: () => ({ customUserId: "fs_member" }),
    commands: { execute: async () => ({ preference }) },
  });

  assert.deepEqual(await handler({
    action: "upsertPreference",
    tripId: "trip-1",
    expectedRevision: 0,
    idempotencyKey: "request-001",
    answers: {},
  }), { ok: true, action: "upsertPreference", data: preference });
});

test("decision conflicts expose the latest resource in the shared failure envelope", async () => {
  const latest = { id: "candidate-1", revision: 3 };
  const handler = createTripHandler({
    getUserInfo: () => ({ customUserId: "fs_member" }),
    commands: { execute: async () => { const error = new Error("VERSION_CONFLICT"); error.code = "VERSION_CONFLICT"; error.currentVersion = 3; error.latest = latest; throw error; } },
  });

  assert.deepEqual(await handler({
    action: "placeTentative",
    tripId: "trip-1",
    candidateId: "candidate-1",
    expectedCandidateRevision: 2,
    placement: { tripDayId: "day-1", date: "2026-10-01", sortKey: "a0" },
    idempotencyKey: "request-001",
  }), { ok: false, error: "VERSION_CONFLICT", latest });
});

test("returns stable decision state errors", async () => {
  const handler = createTripHandler({
    getUserInfo: () => ({ customUserId: "fs_member" }),
    commands: { execute: async () => { const error = new Error("INVALID_CONFIRMATION_STATE"); error.code = "INVALID_CONFIRMATION_STATE"; throw error; } },
  });

  assert.deepEqual(await handler({ action: "setConfirmationReceipt" }), { ok: false, error: "INVALID_CONFIRMATION_STATE" });
});

test("the local bridge can claim an agent run without a browser identity", async () => {
  const calls = [];
  const claimed = { agentRunId: "agent-run-1", claimedAt: "2026-08-28T00:00:00.000Z", nextSequence: 1 };
  const handler = createTripHandler({
    getUserInfo: () => undefined,
    commands: { executeAgent: async (payload) => { calls.push(payload); return claimed; } },
  });
  const input = { action: "claimAgentRun", agentRunId: "agent-run-1", pairingCode: "secret", clientNonce: "nonce-001", signature: "signature" };

  assert.deepEqual(await handler(input), { ok: true, data: claimed });
  assert.deepEqual(calls, [input]);
});

test("agent command results use their dedicated success envelope", async () => {
  const candidates = [{ id: "candidate-1" }, { id: "candidate-2" }];
  const handler = createTripHandler({
    getUserInfo: () => undefined,
    commands: { executeAgent: async () => ({ candidates, replayed: false }) },
  });

  assert.deepEqual(await handler({ action: "submitProposalBatch", agentRunId: "agent-run-1", sequence: 1 }), {
    ok: true,
    action: "submitProposalBatch",
    data: candidates,
    replayed: false,
  });
});

test("agent decision context and incomplete verification warning use stable envelopes", async () => {
  const context = { tripId: "trip-1", preferences: [], candidates: [] };
  const candidate = { id: "candidate-1", verificationState: "candidate" };
  const executeAgent = async (payload) => payload.action === "getDecisionContext"
    ? { context, replayed: false }
    : { candidate, warning: "VERIFICATION_INCOMPLETE", replayed: false };
  const handler = createTripHandler({ getUserInfo: () => undefined, commands: { executeAgent } });

  assert.deepEqual(await handler({ action: "getDecisionContext", agentRunId: "agent-run-1", sequence: 1 }), {
    ok: true,
    action: "getDecisionContext",
    data: context,
    replayed: false,
  });
  assert.deepEqual(await handler({ action: "appendEvidenceSnapshot", agentRunId: "agent-run-1", sequence: 2 }), {
    ok: true,
    action: "appendEvidenceSnapshot",
    data: candidate,
    warning: "VERIFICATION_INCOMPLETE",
    replayed: false,
  });
});

test("an authenticated member can read an agent run safe status", async () => {
  const status = { agentRunId: "agent-run-1", tripId: "trip-1", status: "claimed", revision: 2 };
  const calls = [];
  const handler = createTripHandler({
    getUserInfo: () => ({ customUserId: "fs_member" }),
    commands: { execute: async (payload, actorUid) => { calls.push({ payload, actorUid }); return status; } },
  });

  assert.deepEqual(await handler({ action: "getAgentRunStatus", tripId: "trip-1", agentRunId: "agent-run-1" }), status);
  assert.deepEqual(calls, [{ payload: { action: "getAgentRunStatus", tripId: "trip-1", agentRunId: "agent-run-1" }, actorUid: "fs_member" }]);
});

test("an authenticated member summary request is not mistaken for an agent command", async () => {
  const calls = [];
  const summary = { id: "trip-1", revision: 1 };
  const handler = createTripHandler({
    getUserInfo: () => ({ customUserId: "fs_member" }),
    commands: {
      execute: async (payload, actorUid) => { calls.push({ kind: "member", payload, actorUid }); return { summary }; },
      executeAgent: async () => { calls.push({ kind: "agent" }); return {}; },
    },
  });
  const input = { action: "generatePreferenceSummary", tripId: "trip-1", sourcePreferenceRevisions: { fs_member: 2 }, idempotencyKey: "request-001" };

  assert.deepEqual(await handler(input), { ok: true, action: "generatePreferenceSummary", data: summary });
  assert.equal(calls[0].kind, "member");
});
