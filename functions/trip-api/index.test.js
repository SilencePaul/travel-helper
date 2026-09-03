const assert = require("node:assert/strict");
const test = require("node:test");
const { agentMain, createAgentHttpHandler, createTripHandler, main } = require("./index.js");
const { createDecisionAgentBridge } = require("./lib/decision-agent-bridge.js");

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

test("Decision mutations wrap only declared domain failures without changing legacy read failures", async () => {
  const unauthenticated = createTripHandler({ getUserInfo: () => undefined, commands: { execute: async () => ({}) } });
  const mutation = {
    action: "upsertPreference",
    tripId: "trip-1",
    expectedRevision: 0,
    idempotencyKey: "request-001",
    answers: {},
  };

  assert.deepEqual(await unauthenticated(mutation), { ok: false, error: "AUTH_REQUIRED" });
  assert.deepEqual(await unauthenticated({ action: "getTrip", tripId: "trip-1" }), { error: "AUTH_REQUIRED" });
  const unavailable = createTripHandler({ getUserInfo: () => ({ customUserId: "fs_admin" }), env: {} });
  await assert.rejects(() => unavailable(mutation), { code: "TRIP_API_UNAVAILABLE" });

  for (const [internalCode, publicCode] of [
    ["TRIP_NOT_FOUND", "FORBIDDEN"],
    ["MEMBER_NOT_FOUND", "INVALID_REQUEST"],
  ]) {
    const handler = createTripHandler({
      getUserInfo: () => ({ customUserId: "fs_admin" }),
      commands: { execute: async () => { const error = new Error(internalCode); error.code = internalCode; throw error; } },
    });
    assert.deepEqual(await handler(mutation), { ok: false, error: publicCode });
  }

  for (const internalCode of ["TRIP_API_UNAVAILABLE", "UNEXPECTED_PROVIDER_ERROR"]) {
    const failure = Object.assign(new Error(internalCode), { code: internalCode });
    const handler = createTripHandler({
      getUserInfo: () => ({ customUserId: "fs_admin" }),
      commands: { execute: async () => { throw failure; } },
    });
    await assert.rejects(() => handler(mutation), (error) => error === failure);
  }
});

test("Agent domain failures use a declared ok-false envelope while transport failures reject", async () => {
  const input = {
    action: "getDecisionContext",
    agentRunId: "agent-run-1",
    sequence: 1,
    idempotencyKey: "context-001",
    payload: {},
    signature: "signature",
  };
  for (const [internalCode, publicCode] of [
    ["TRIP_NOT_FOUND", "FORBIDDEN"],
    ["MEMBER_NOT_FOUND", "INVALID_REQUEST"],
  ]) {
    const handler = createTripHandler({
      commands: { executeAgent: async () => { const error = new Error(internalCode); error.code = internalCode; throw error; } },
    });
    const result = await handler(input);
    assert.deepEqual(result, { ok: false, error: publicCode });
    assert.deepEqual(Object.keys(result).sort(), ["error", "ok"]);
  }

  for (const internalCode of ["TRIP_API_UNAVAILABLE", "UNEXPECTED_PROVIDER_ERROR"]) {
    const failure = Object.assign(new Error(internalCode), { code: internalCode });
    const handler = createTripHandler({ commands: { executeAgent: async () => { throw failure; } } });
    await assert.rejects(() => handler(input), (error) => error === failure);
  }
  await assert.rejects(
    () => createTripHandler({ env: {} })(input),
    { code: "TRIP_API_UNAVAILABLE" },
  );
});

test("the local bridge can claim an agent run without a browser identity", async () => {
  const calls = [];
  const claimed = { agentRunId: "agent-run-1", claimedAt: "2026-08-28T00:00:00.000Z", expiresAt: "2026-08-28T00:15:00.000Z", nextSequence: 1 };
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

test("self-revoke returns only its fixed control result in the Agent success envelope", async () => {
  const handler = createTripHandler({
    getUserInfo: () => undefined,
    commands: {
      executeAgent: async () => ({
        agentRunId: "agent-run-1",
        revokedAt: "2026-08-28T00:05:00.000Z",
        replayed: false,
      }),
    },
  });

  assert.deepEqual(await handler({ action: "revokeAgentRunSelf", agentRunId: "agent-run-1", sequence: 1 }), {
    ok: true,
    action: "revokeAgentRunSelf",
    data: { agentRunId: "agent-run-1", revokedAt: "2026-08-28T00:05:00.000Z" },
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

test("an authenticated administrator can read an agent run safe status", async () => {
  const status = { agentRunId: "agent-run-1", tripId: "trip-1", status: "claimed", revision: 2 };
  const calls = [];
  const handler = createTripHandler({
    getUserInfo: () => ({ customUserId: "fs_admin" }),
    commands: { execute: async (payload, actorUid) => { calls.push({ payload, actorUid }); return status; } },
  });

  assert.deepEqual(await handler({ action: "getAgentRunStatus", tripId: "trip-1", agentRunId: "agent-run-1" }), status);
  assert.deepEqual(calls, [{ payload: { action: "getAgentRunStatus", tripId: "trip-1", agentRunId: "agent-run-1" }, actorUid: "fs_admin" }]);
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

test("the public Agent HTTP transport accepts only signed Agent actions", async () => {
  const calls = [];
  const transport = createAgentHttpHandler({
    handler: createTripHandler({
      getUserInfo: () => undefined,
      commands: { executeAgent: async (payload) => { calls.push(payload); return { agentRunId: payload.agentRunId, claimedAt: "2026-08-31T00:00:00.000Z", expiresAt: "2026-08-31T00:15:00.000Z", nextSequence: 1 }; } },
    }),
  });
  const claim = { action: "claimAgentRun", agentRunId: "agent-run-1", pairingCode: "secret", clientNonce: "nonce-001", signature: "signature" };

  const response = await transport({ httpMethod: "POST", path: "/api/agent", headers: { "content-type": "application/json" }, body: JSON.stringify(claim) });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { ok: true, data: { agentRunId: "agent-run-1", claimedAt: "2026-08-31T00:00:00.000Z", expiresAt: "2026-08-31T00:15:00.000Z", nextSequence: 1 } });
  assert.deepEqual(calls, [claim]);
});

test("the public Agent transport accepts the signed self-revoke control action", async () => {
  const transport = createAgentHttpHandler({ handler: async () => ({
    ok: true,
    action: "revokeAgentRunSelf",
    data: { agentRunId: "agent-run-1", revokedAt: "2026-08-31T00:05:00.000Z" },
    replayed: false,
  }) });
  const command = {
    action: "revokeAgentRunSelf",
    agentRunId: "agent-run-1",
    sequence: 1,
    idempotencyKey: "self-revoke-001",
    payload: {},
    signature: "signature",
  };

  const response = await transport({
    httpMethod: "POST",
    path: "/api/agent",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command),
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    ok: true,
    action: "revokeAgentRunSelf",
    data: { agentRunId: "agent-run-1", revokedAt: "2026-08-31T00:05:00.000Z" },
    replayed: false,
  });
});

test("the public Agent transport maps lost administrator authority or membership to forbidden", async () => {
  for (const error of ["ADMIN_REQUIRED", "MEMBERSHIP_REQUIRED"]) {
    const transport = createAgentHttpHandler({ handler: async () => ({ ok: false, error }) });
    const response = await transport({
      httpMethod: "POST",
      path: "/api/agent",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "getDecisionContext",
        agentRunId: "agent-run-1",
        sequence: 1,
        idempotencyKey: "context-001",
        payload: {},
        signature: "signature",
      }),
    });

    assert.equal(response.statusCode, 403);
    assert.deepEqual(JSON.parse(response.body), { ok: false, error });
  }
});

test("the public Agent HTTP transport rejects member commands before data access", async () => {
  let memberCalls = 0;
  const transport = createAgentHttpHandler({
    handler: createTripHandler({
      getUserInfo: () => ({ customUserId: "fs_member" }),
      commands: {
        execute: async () => { memberCalls += 1; return { title: "private trip" }; },
        executeAgent: async () => ({}),
      },
    }),
  });

  const response = await transport({ httpMethod: "POST", path: "/api/agent", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "getTrip", tripId: "trip-1" }) });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: "INVALID_REQUEST" });
  assert.equal(memberCalls, 0);
});

test("the public Agent HTTP transport rejects wrong methods, types and oversized bodies", async () => {
  let calls = 0;
  const transport = createAgentHttpHandler({ handler: async () => { calls += 1; return { ok: true }; }, maxBodyBytes: 32 });

  for (const event of [
    { httpMethod: "GET", path: "/api/agent", headers: {} },
    { httpMethod: "POST", path: "/", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "claimAgentRun" }) },
    { httpMethod: "POST", path: "/api/agent", headers: { "content-type": "text/plain" }, body: "{}" },
    { httpMethod: "POST", path: "/api/agent?debug=1", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "claimAgentRun" }) },
    { httpMethod: "POST", path: "/api/agent", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "getDecisionContext", agentRunId: "agent-run-1" }) },
    { httpMethod: "POST", path: "/api/agent", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "claimAgentRun", padding: "x".repeat(64) }) },
  ]) {
    const response = await transport(event);
    assert.equal(response.statusCode >= 400 && response.statusCode < 500, true);
  }
  assert.equal(calls, 0);
});

test("member and public Agent exports stay isolated", async () => {
  assert.deepEqual(await main({ action: "getTrip", tripId: "trip-1" }), { error: "AUTH_REQUIRED" });
  const response = await agentMain({ httpMethod: "POST", path: "/api/agent", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "getTrip", tripId: "trip-1" }) });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: "INVALID_REQUEST" });
});

test("the public Agent adapter maps unexpected handler failures to 503", async () => {
  const transport = createAgentHttpHandler({ handler: async () => { throw new Error("database unavailable"); } });
  const response = await transport({
    httpMethod: "POST",
    path: "/api/agent",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "claimAgentRun", agentRunId: "run", pairingCode: "code", clientNonce: "nonce-001", signature: "signature" }),
  });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: "INVALID_REQUEST" });
});

test("the public Agent adapter maps a returned backend outage to 503", async () => {
  const transport = createAgentHttpHandler({ handler: async () => ({ ok: false, error: "TRIP_API_UNAVAILABLE" }) });
  const response = await transport({
    httpMethod: "POST",
    path: "/api/agent",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "claimAgentRun", agentRunId: "run", pairingCode: "code", clientNonce: "nonce-001", signature: "signature" }),
  });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: "INVALID_REQUEST" });
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.body.includes("database"), false);
});

test("the real Agent handler preserves transport-unavailable status without exposing it in the contract body", async () => {
  const failure = Object.assign(new Error("database unavailable"), { code: "TRIP_API_UNAVAILABLE" });
  const handler = createTripHandler({
    commands: {
      executeAgent: async () => { throw failure; },
    },
  });
  const input = {
    action: "getDecisionContext",
    agentRunId: "agent-run-1",
    sequence: 1,
    idempotencyKey: "context-001",
    payload: {},
    signature: "signature",
  };
  await assert.rejects(() => handler(input), (error) => error === failure);
  const transport = createAgentHttpHandler({ handler });
  const response = await transport({
    httpMethod: "POST",
    path: "/api/agent",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: "INVALID_REQUEST" });
});

test("the public Agent entry rejects an invalid signature through the real command verifier", async () => {
  const backendBridge = createDecisionAgentBridge({ now: () => new Date("2026-08-31T00:05:00.000Z") });
  const run = {
    id: "agent-run-1",
    tripId: "trip-1",
    publicKeyJwk: { kty: "EC", crv: "P-256", x: "invalid", y: "invalid" },
    scope: ["submitProposalBatch"],
    status: "claimed",
    lastSequence: 0,
    revision: 2,
    expiresAt: "2026-08-31T00:15:00.000Z",
  };
  const transaction = {
    collection(name) {
      assert.equal(name, "trip_agent_runs");
      return { doc() { return { async get() { return { data: [run] }; } }; } };
    },
  };
  const handler = createTripHandler({
    commands: { executeAgent: (input) => backendBridge.run(transaction, input, async () => { throw new Error("must not run"); }) },
  });
  const transport = createAgentHttpHandler({ handler });

  const response = await transport({
    httpMethod: "POST",
    path: "/api/agent",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "getDecisionContext",
      agentRunId: "agent-run-1",
      sequence: 1,
      idempotencyKey: "request-001",
      payload: {},
      signature: "invalid-signature",
    }),
  });

  assert.equal(response.statusCode, 403);
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: "INVALID_AGENT_CLAIM" });
});
