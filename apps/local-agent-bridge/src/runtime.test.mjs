import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

import { LocalAgentBridgeRuntime, canonicalJson } from "./runtime.mjs";

const require = createRequire(import.meta.url);
const { createDecisionAgentBridge, sha256Base64Url } = require("../../../functions/trip-api/lib/decision-agent-bridge.js");
const { createAgentHttpHandler, createTripHandler } = require("../../../functions/trip-api/index.js");
const FUTURE_EXPIRES_AT = "2099-01-01T00:15:00.000Z";

function claimedData(agentRunId, nextSequence = 1, expiresAt = FUTURE_EXPIRES_AT) {
  return {
    agentRunId,
    claimedAt: "2026-08-31T00:00:00.000Z",
    expiresAt,
    nextSequence,
  };
}

function candidateData(index = 1) {
  return {
    id: `candidate-${index}`,
    tripId: "trip-1",
    revision: 0,
    updatedAt: "2026-09-01T00:01:00.000Z",
    category: "hotel",
    entity: { name: `Hotel ${index}`, address: "Shenzhen" },
    applicability: {
      dates: { start: "2026-10-03", end: "2026-10-04" },
      travelers: 2,
    },
    recommendation: {
      round: 1,
      reason: "Near the itinerary",
      preferenceRevisionIds: [],
      feedbackIds: [],
    },
    verificationState: "web_verified",
    decisionState: "tentative",
    currentEvidenceId: `evidence-${index}`,
  };
}

function candidateBatchData() {
  return [candidateData(1), candidateData(2)];
}

function createTransaction(runs) {
  const idempotency = new Map();
  return {
    idempotency,
    transaction: {
      collection(name) {
        const store = name === "trip_agent_runs" ? runs : idempotency;
        return { doc(id) { return {
          async get() { const value = store.get(id); return { data: value ? [structuredClone(value)] : [] }; },
          async set(value) { store.set(id, structuredClone(value)); },
        }; } };
      },
    },
  };
}

function verifies(publicKeyJwk, value, signature) {
  return verify(
    "sha256",
    Buffer.from(canonicalJson(value)),
    { key: createPublicKey({ key: publicKeyJwk, format: "jwk" }), dsaEncoding: "ieee-p1363" },
    Buffer.from(signature, "base64url"),
  );
}

test("prepare, claim and context use a real P-256 key without exposing secrets", async () => {
  let prepared;
  const requests = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    if (body.action === "claimAgentRun") {
      assert.equal(createHash("sha256").update(body.pairingCode).digest("base64url"), prepared.pairingCodeHash);
      const { signature, action: _action, ...signed } = body;
      assert.equal(verifies(prepared.publicKeyJwk, signed, signature), true);
      return Response.json({ ok: true, data: claimedData(body.agentRunId) });
    }
    const { signature, ...signed } = body;
    assert.equal(verifies(prepared.publicKeyJwk, signed, signature), true);
    return Response.json({ ok: true, action: "getDecisionContext", data: { tripId: "trip-1", preferences: [], candidates: [] } });
  };
  const runtime = new LocalAgentBridgeRuntime({ agentEndpoint: "https://api.example.test/api/agent", fetch: fetchImpl });

  prepared = runtime.prepare();
  assert.deepEqual(Object.keys(prepared).sort(), ["pairingCodeFingerprint", "pairingCodeHash", "publicKeyJwk"]);
  assert.equal(JSON.stringify(prepared).includes("private"), false);
  await assert.doesNotReject(runtime.claim("agent-run-1"));
  await assert.doesNotReject(runtime.getDecisionContext());
  assert.deepEqual(requests.map((request) => request.action), ["claimAgentRun", "getDecisionContext"]);
  assert.equal(requests[1].sequence, 1);
});

test("claim rejects an oversized opaque run id before sending it", async () => {
  let fetchCalls = 0;
  const runtime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    fetch: async () => {
      fetchCalls += 1;
      throw new Error("must not send");
    },
  });
  runtime.prepare();

  await assert.rejects(runtime.claim("a".repeat(300)), /INVALID_REQUEST/);
  assert.equal(fetchCalls, 0);
});

test("prepare always constrains caller input to submitProposalBatch", async () => {
  const actions = [];
  const runtime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      actions.push(body.action);
      if (body.action === "claimAgentRun") {
        return Response.json({ ok: true, data: claimedData(body.agentRunId) });
      }
      return Response.json({ ok: true, action: body.action, data: candidateBatchData() });
    },
  });

  runtime.prepare(["appendEvidenceSnapshot", "reportVerificationBlocked", "generatePreferenceSummary"]);
  await runtime.claim("agent-run-fixed-scope");

  await assert.rejects(runtime.command("appendEvidenceSnapshot", {}), /ACTION_NOT_ALLOWED/);
  await assert.rejects(runtime.command("reportVerificationBlocked", {}), /ACTION_NOT_ALLOWED/);
  await assert.rejects(runtime.command("generatePreferenceSummary", {}), /ACTION_NOT_ALLOWED/);
  await assert.doesNotReject(runtime.command("submitProposalBatch", { round: 1, candidates: [] }));
  assert.deepEqual(actions, ["claimAgentRun", "submitProposalBatch"]);
});

test("releaseUnboundClaim clears only the exactly matching idle local capability without a cloud command", async () => {
  const actions = [];
  const runtime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      actions.push(body.action);
      return Response.json({ ok: true, data: claimedData(body.agentRunId) });
    },
  });
  runtime.prepare();
  await runtime.claim("agent-run-unbound");

  assert.equal(runtime.releaseUnboundClaim("agent-run-other"), false);
  assert.equal(runtime.claimedRun?.agentRunId, "agent-run-unbound");
  assert.throws(() => runtime.prepare(), /BRIDGE_BUSY/);
  assert.equal(runtime.releaseUnboundClaim("agent-run-unbound"), true);

  assert.equal(runtime.claimedRun, undefined);
  assert.doesNotThrow(() => runtime.prepare());
  assert.deepEqual(actions, ["claimAgentRun"]);
});

test("releaseUnboundClaim refuses to clear a matching capability while runtime is busy", async () => {
  let releaseContext;
  const contextGate = new Promise((resolve) => { releaseContext = resolve; });
  const runtime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.action === "claimAgentRun") {
        return Response.json({ ok: true, data: claimedData(body.agentRunId) });
      }
      await contextGate;
      return Response.json({ ok: true, action: body.action, data: { tripId: "trip-1" } });
    },
  });
  runtime.prepare();
  await runtime.claim("agent-run-busy-unbound");
  const context = runtime.getDecisionContext();

  assert.equal(runtime.releaseUnboundClaim("agent-run-busy-unbound"), false);
  assert.equal(runtime.claimedRun?.agentRunId, "agent-run-busy-unbound");
  releaseContext();
  await context;
});

test("releaseUnboundClaim preserves an uncertain signed command until its exact replay settles", async () => {
  const commandBodies = [];
  let contextAttempts = 0;
  const runtime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.action === "claimAgentRun") {
        return Response.json({ ok: true, data: claimedData(body.agentRunId) });
      }
      commandBodies.push(init.body);
      contextAttempts += 1;
      if (contextAttempts === 1) throw new TypeError("response lost");
      return Response.json({
        ok: true,
        action: "getDecisionContext",
        data: { tripId: "trip-1", preferences: [], candidates: [] },
      });
    },
  });
  runtime.prepare();
  await runtime.claim("agent-run-pending-context");

  await assert.rejects(runtime.getDecisionContext(), {
    code: "AGENT_TRANSPORT_UNAVAILABLE",
    uncertain: true,
  });
  assert.equal(runtime.releaseUnboundClaim("agent-run-pending-context"), false);
  assert.equal(runtime.claimedRun?.agentRunId, "agent-run-pending-context");
  assert.throws(() => runtime.prepare(), /BRIDGE_BUSY/);

  await assert.doesNotReject(runtime.getDecisionContext());
  assert.equal(commandBodies.length, 2);
  assert.equal(commandBodies[0], commandBodies[1]);
  assert.equal(runtime.releaseUnboundClaim("agent-run-pending-context"), true);
  assert.doesNotThrow(() => runtime.prepare());
});

test("expireUnboundClaim preserves an exact uncertain claim for eight seconds, then clears it", async () => {
  let now = new Date("2026-09-01T00:00:00.000Z");
  const claimBodies = [];
  const runtime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    now: () => now,
    fetch: async (_url, init) => {
      claimBodies.push(init.body);
      throw new TypeError("claim response unknown");
    },
  });
  runtime.prepare();

  await assert.rejects(runtime.claim("agent-run-expiring-claim"), {
    code: "AGENT_TRANSPORT_UNAVAILABLE",
    uncertain: true,
  });
  now = new Date("2026-09-01T00:00:04.000Z");
  await assert.rejects(runtime.claim("agent-run-expiring-claim"), {
    code: "AGENT_TRANSPORT_UNAVAILABLE",
    uncertain: true,
  });

  assert.equal(claimBodies.length, 2);
  assert.equal(claimBodies[0], claimBodies[1]);
  assert.equal(runtime.expireUnboundClaim("agent-run-other"), false);
  now = new Date("2026-09-01T00:00:07.999Z");
  assert.equal(runtime.expireUnboundClaim("agent-run-expiring-claim", 1), false);
  assert.throws(() => runtime.prepare(), { code: "BRIDGE_BUSY" });

  now = new Date("2026-09-01T00:00:08.000Z");
  assert.equal(runtime.expireUnboundClaim("agent-run-expiring-claim"), true);
  assert.doesNotThrow(() => runtime.prepare());
});

test("expireUnboundClaim refuses a busy claim and later expires the matching claimed capability", async () => {
  let now = new Date("2026-09-01T00:00:00.000Z");
  let releaseClaim;
  let claimStarted;
  const claimGate = new Promise((resolve) => { releaseClaim = resolve; });
  const observedClaim = new Promise((resolve) => { claimStarted = resolve; });
  const runtime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    now: () => now,
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      claimStarted();
      await claimGate;
      return Response.json({ ok: true, data: claimedData(body.agentRunId) });
    },
  });
  runtime.prepare();
  const claim = runtime.claim("agent-run-busy-expiry");
  await observedClaim;
  now = new Date("2026-09-01T00:00:08.000Z");

  assert.equal(runtime.expireUnboundClaim("agent-run-busy-expiry"), false);
  releaseClaim();
  await claim;
  assert.equal(runtime.expireUnboundClaim("agent-run-busy-expiry"), true);
  assert.equal(runtime.claimedRun, undefined);
  assert.doesNotThrow(() => runtime.prepare());
});

test("expireUnboundClaim never clears a pending signed command", async () => {
  let now = new Date("2026-09-01T00:00:00.000Z");
  let contextAttempts = 0;
  const contextBodies = [];
  const runtime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    now: () => now,
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.action === "claimAgentRun") {
        return Response.json({ ok: true, data: claimedData(body.agentRunId) });
      }
      contextBodies.push(init.body);
      contextAttempts += 1;
      if (contextAttempts === 1) throw new TypeError("context response unknown");
      return Response.json({ ok: true, action: body.action, data: { tripId: "trip-1" } });
    },
  });
  runtime.prepare();
  await runtime.claim("agent-run-pending-command-expiry");
  await assert.rejects(runtime.getDecisionContext(), {
    code: "AGENT_TRANSPORT_UNAVAILABLE",
    uncertain: true,
  });
  now = new Date("2026-09-01T00:00:08.000Z");

  assert.equal(runtime.expireUnboundClaim("agent-run-pending-command-expiry"), false);
  assert.throws(() => runtime.prepare(), { code: "BRIDGE_BUSY" });
  await runtime.getDecisionContext();
  assert.equal(contextBodies[0], contextBodies[1]);
  assert.equal(runtime.expireUnboundClaim("agent-run-pending-command-expiry"), true);
  assert.doesNotThrow(() => runtime.prepare());
});

test("submitProposalBatch is a fixed runtime wrapper and uncertain retries reuse the pending envelope", async () => {
  const bodies = [];
  let attempt = 0;
  const runtime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.action === "claimAgentRun") {
        return Response.json({ ok: true, data: claimedData(body.agentRunId) });
      }
      bodies.push(init.body);
      attempt += 1;
      if (attempt === 1) throw new TypeError("response lost");
      return Response.json({ ok: true, action: "submitProposalBatch", data: candidateBatchData() });
    },
  });
  runtime.prepare();
  await runtime.claim("agent-run-submit-wrapper");
  const payload = { round: 1, candidates: [{ id: "safe" }] };

  await assert.rejects(runtime.submitProposalBatch(payload), {
    code: "AGENT_TRANSPORT_UNAVAILABLE",
  });
  payload.round = 999;
  await runtime.submitProposalBatch({ round: 1, candidates: [{ id: "safe" }] });

  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(JSON.parse(bodies[1]).payload.round, 1);
});

test("submitProposalBatch rejects unsafe success bodies without advancing or replacing its pending envelope", async () => {
  for (const unsafeResponse of [
    { ok: true, action: "submitProposalBatch", data: null },
    { ok: true, action: "submitProposalBatch", data: candidateBatchData(), serverSecret: "private" },
    {
      ok: true,
      action: "submitProposalBatch",
      data: [{ ...candidateData(1), unexpected: true }, candidateData(2)],
    },
    {
      ok: true,
      action: "submitProposalBatch",
      data: [
        { ...candidateData(1), applicability: { dates: { start: "not-a-date", end: "2026-10-04" } } },
        candidateData(2),
      ],
    },
  ]) {
    const bodies = [];
    let attempts = 0;
    const runtime = new LocalAgentBridgeRuntime({
      agentEndpoint: "https://api.example.test/api/agent",
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body);
        if (body.action === "claimAgentRun") {
          return Response.json({ ok: true, data: claimedData(body.agentRunId) });
        }
        bodies.push(init.body);
        attempts += 1;
        return Response.json(attempts === 1
          ? unsafeResponse
          : { ok: true, action: "submitProposalBatch", data: candidateBatchData(), replayed: true });
      },
    });
    runtime.prepare();
    await runtime.claim("agent-run-strict-submit");
    const payload = { round: 1, candidates: [{ id: "safe" }] };

    await assert.rejects(runtime.submitProposalBatch(payload), {
      code: "INVALID_AGENT_RESPONSE",
      uncertain: true,
    });
    assert.equal(runtime.nextSequence, 1);
    const replay = await runtime.submitProposalBatch(structuredClone(payload));

    assert.deepEqual(replay, {
      ok: true,
      action: "submitProposalBatch",
      data: candidateBatchData(),
      replayed: true,
    });
    assert.equal(runtime.nextSequence, 2);
    assert.equal(bodies[0], bodies[1]);
  }
});

test("an aborted submit is uncertain and replays the byte-identical pending envelope", async () => {
  const bodies = [];
  let submitAttempts = 0;
  const runtime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    timeoutMs: 5,
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.action === "claimAgentRun") {
        return Response.json({ ok: true, data: claimedData(body.agentRunId) });
      }
      bodies.push(init.body);
      submitAttempts += 1;
      if (submitAttempts === 1) {
        return new Promise((_, reject) => {
          init.signal.addEventListener("abort", () => {
            reject(Object.assign(new Error("fake fetch aborted"), { name: "AbortError" }));
          }, { once: true });
        });
      }
      return Response.json({
        ok: true,
        action: "submitProposalBatch",
        data: candidateBatchData(),
        replayed: true,
      });
    },
  });
  runtime.prepare();
  await runtime.claim("agent-run-aborted-submit");
  const payload = { round: 1, candidates: [{ id: "safe" }] };

  await assert.rejects(runtime.submitProposalBatch(payload), {
    code: "AGENT_TRANSPORT_UNAVAILABLE",
    uncertain: true,
  });
  const replay = await runtime.submitProposalBatch(structuredClone(payload));

  assert.equal(replay.replayed, true);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
});

test("prepare is idempotent only before claim work starts and never rotates active capability state", async () => {
  let claimAttempts = 0;
  const runtime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      claimAttempts += 1;
      if (claimAttempts === 1) throw new TypeError("claim response lost");
      return Response.json({ ok: true, data: claimedData(body.agentRunId) });
    },
  });

  const first = runtime.prepare();
  const expected = structuredClone(first);
  first.publicKeyJwk.x = "caller mutation";
  assert.deepEqual(runtime.prepare(), expected);

  await assert.rejects(runtime.claim("agent-run-prepare-lifecycle"), /AGENT_TRANSPORT_UNAVAILABLE/);
  assert.throws(() => runtime.prepare(), /BRIDGE_BUSY/);
  await runtime.claim("agent-run-prepare-lifecycle");
  assert.throws(() => runtime.prepare(), /BRIDGE_BUSY/);
});

test("prepare rotates capability material only after a claimed run is definitely expired", async () => {
  let now = new Date("2026-08-31T00:05:00.000Z");
  const runtime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    now: () => now,
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      return Response.json({
        ok: true,
        data: claimedData(body.agentRunId, 1, "2026-08-31T00:06:00.000Z"),
      });
    },
  });
  const first = runtime.prepare();
  await runtime.claim("agent-run-prepare-expiry");

  assert.throws(() => runtime.prepare(), /BRIDGE_BUSY/);
  now = new Date("2026-08-31T00:06:00.000Z");
  const next = runtime.prepare();

  assert.notDeepEqual(next, first);
  assert.equal(runtime.claimedRun, undefined);
  assert.equal(runtime.nextSequence, undefined);
  assert.deepEqual(runtime.prepare(), next);
});

test("prepare fails closed without clearing a claimed capability when its clock is invalid", async () => {
  let clock = "valid";
  const runtime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    now: () => {
      if (clock === "throw") throw new Error("secret prepare clock failure");
      if (clock === "invalid") return new Date(Number.NaN);
      return new Date("2026-08-31T00:05:00.000Z");
    },
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      return Response.json({
        ok: true,
        data: claimedData(body.agentRunId, 3, "2026-08-31T00:06:00.000Z"),
      });
    },
  });
  runtime.prepare();
  await runtime.claim("agent-run-prepare-clock");

  for (const mode of ["throw", "invalid"]) {
    clock = mode;
    assert.throws(runtime.prepare.bind(runtime), { code: "INVALID_CLOCK", message: "INVALID_CLOCK" });
    assert.deepEqual(runtime.claimedRun, {
      agentRunId: "agent-run-prepare-clock",
      expiresAt: "2026-08-31T00:06:00.000Z",
      nextSequence: 3,
    });
  }
  clock = "valid";
  assert.throws(() => runtime.prepare(), /BRIDGE_BUSY/);
});

test("prepare fails closed without clearing a claimed capability with an invalid stored expiry", async () => {
  let expiryReads = 0;
  const runtime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    now: () => new Date("2026-08-31T00:05:00.000Z"),
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      const data = {
        agentRunId: body.agentRunId,
        claimedAt: "2026-08-31T00:00:00.000Z",
        nextSequence: 2,
        get expiresAt() {
          expiryReads += 1;
          return expiryReads === 1 ? "2026-08-31T00:06:00.000Z" : "invalid-after-validation";
        },
      };
      return { ok: true, status: 200, async json() { return { ok: true, data }; } };
    },
  });
  runtime.prepare();
  await runtime.claim("agent-run-invalid-stored-expiry");

  assert.throws(runtime.prepare.bind(runtime), {
    code: "INVALID_AGENT_RESPONSE",
    message: "INVALID_AGENT_RESPONSE",
  });
  assert.deepEqual(runtime.claimedRun, {
    agentRunId: "agent-run-invalid-stored-expiry",
    expiresAt: "invalid-after-validation",
    nextSequence: 2,
  });
});

test("prepare stays busy for a pending command even after the claimed run expires", async () => {
  let now = new Date("2026-08-31T00:05:00.000Z");
  const runtime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    now: () => now,
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.action === "claimAgentRun") {
        return Response.json({
          ok: true,
          data: claimedData(body.agentRunId, 1, "2026-08-31T00:06:00.000Z"),
        });
      }
      throw new TypeError("command response lost");
    },
  });
  runtime.prepare();
  await runtime.claim("agent-run-pending-prepare");
  await assert.rejects(
    runtime.command("submitProposalBatch", { round: 1, candidates: [] }),
    /AGENT_TRANSPORT_UNAVAILABLE/,
  );
  now = new Date("2026-08-31T00:07:00.000Z");

  assert.throws(() => runtime.prepare(), /BRIDGE_BUSY/);
});

test("generic command rejects control actions while fixed wrappers use exact empty payloads", async () => {
  const actions = [];
  const runtime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      actions.push({ action: body.action, payload: body.payload });
      if (body.action === "claimAgentRun") {
        return Response.json({ ok: true, data: claimedData(body.agentRunId) });
      }
      if (body.action === "getDecisionContext") {
        return Response.json({ ok: true, action: body.action, data: { tripId: "trip-1" } });
      }
      return Response.json({
        ok: true,
        action: "revokeAgentRunSelf",
        data: { agentRunId: body.agentRunId, revokedAt: "2026-08-31T00:06:00.000Z" },
      });
    },
  });
  runtime.prepare();
  await runtime.claim("agent-run-controls");

  await assert.rejects(runtime.command("getDecisionContext", { injected: true }), /ACTION_NOT_ALLOWED/);
  await assert.rejects(runtime.command("revokeAgentRunSelf", { injected: true }), /ACTION_NOT_ALLOWED/);
  await runtime.getDecisionContext({ injected: true });
  await runtime.revokeSelf({ injected: true });

  assert.deepEqual(actions.map((entry) => entry.action), ["claimAgentRun", "getDecisionContext", "revokeAgentRunSelf"]);
  assert.deepEqual(actions.slice(1).map((entry) => entry.payload), [{}, {}]);
});

test("claim stores a strict future expiry and claimedRun returns an isolated safe copy", async () => {
  const now = new Date("2026-08-31T00:05:00.000Z");
  const expiresAt = "2026-08-31T00:15:00.000Z";
  const runtime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    now: () => now,
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      return Response.json({ ok: true, data: claimedData(body.agentRunId, 7, expiresAt) });
    },
  });
  runtime.prepare();
  await runtime.claim("agent-run-safe-copy");

  const snapshot = runtime.claimedRun;
  assert.deepEqual(snapshot, { agentRunId: "agent-run-safe-copy", expiresAt, nextSequence: 7 });
  assert.deepEqual(Object.keys(snapshot).sort(), ["agentRunId", "expiresAt", "nextSequence"]);
  snapshot.agentRunId = "attacker-run";
  snapshot.expiresAt = "2099-01-01T00:00:00.000Z";
  snapshot.nextSequence = 999;
  assert.deepEqual(runtime.claimedRun, { agentRunId: "agent-run-safe-copy", expiresAt, nextSequence: 7 });
  assert.equal(/private|signature|pairing/i.test(JSON.stringify(runtime.claimedRun)), false);
});

test("claim rejects missing, malformed, non-UTC and elapsed expiries", async () => {
  const invalidExpiries = [
    undefined,
    "not-a-date",
    "2026-02-30T00:15:00.000Z",
    "2026-08-31T01:15:00+01:00",
    "2026-08-31T00:05:00.000Z",
    "2026-08-31T00:04:59.999Z",
  ];
  for (const expiresAt of invalidExpiries) {
    const runtime = new LocalAgentBridgeRuntime({
      agentEndpoint: "https://api.example.test/api/agent",
      now: () => new Date("2026-08-31T00:05:00.000Z"),
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body);
        return Response.json({
          ok: true,
          data: {
            agentRunId: body.agentRunId,
            claimedAt: "2026-08-31T00:00:00.000Z",
            nextSequence: 1,
            ...(expiresAt === undefined ? {} : { expiresAt }),
          },
        });
      },
    });
    runtime.prepare();
    await assert.rejects(runtime.claim("agent-run-invalid-expiry"), /INVALID_AGENT_RESPONSE/);
    assert.equal(runtime.claimedRun, undefined);
  }
});

test("claim rejects impossible claim timing while retaining the envelope for reconciliation", async () => {
  const cases = [
    ["invalid claimedAt", "not-a-date", "2026-08-31T00:15:00.000Z"],
    ["claimedAt equals expiry", "2026-08-31T00:15:00.000Z", "2026-08-31T00:15:00.000Z"],
    ["claimedAt follows expiry", "2026-08-31T00:16:00.000Z", "2026-08-31T00:15:00.000Z"],
    ["expiry did not outlive first send", "2026-08-31T00:04:00.000Z", "2026-08-31T00:05:00.000Z"],
  ];
  for (const [index, [name, claimedAt, expiresAt]] of cases.entries()) {
    const bodies = [];
    const runtime = new LocalAgentBridgeRuntime({
      agentEndpoint: "https://api.example.test/api/agent",
      now: () => new Date("2026-08-31T00:05:00.000Z"),
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body);
        bodies.push(init.body);
        return Response.json({ ok: true, data: { agentRunId: body.agentRunId, claimedAt, expiresAt, nextSequence: 1 } });
      },
    });
    runtime.prepare();
    const agentRunId = `agent-run-impossible-timing-${index}`;
    await assert.rejects(runtime.claim(agentRunId), /INVALID_AGENT_RESPONSE/, name);
    assert.throws(() => runtime.prepare(), /BRIDGE_BUSY/);
    await assert.rejects(runtime.claim(agentRunId), /INVALID_AGENT_RESPONSE/, name);
    assert.equal(bodies[0], bodies[1]);
  }
});

test("claim accepts a strictly ordered server clock ahead of the local response clock", async () => {
  for (const claimedAt of ["2026-08-31T00:05:00.001Z", "2026-08-31T00:07:00.000Z"]) {
    const runtime = new LocalAgentBridgeRuntime({
      agentEndpoint: "https://api.example.test/api/agent",
      now: () => new Date("2026-08-31T00:05:00.000Z"),
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body);
        return Response.json({
          ok: true,
          data: {
            agentRunId: body.agentRunId,
            claimedAt,
            expiresAt: "2026-08-31T00:15:00.000Z",
            nextSequence: 1,
          },
        });
      },
    });
    runtime.prepare();

    await runtime.claim(`agent-run-server-ahead-${claimedAt}`);
    assert.equal(runtime.claimedRun?.expiresAt, "2026-08-31T00:15:00.000Z");
  }
});

test("claim fails closed with a stable error when the request clock is invalid", async () => {
  for (const now of [
    () => new Date(Number.NaN),
    () => { throw new Error("secret clock failure"); },
  ]) {
    let fetchCalls = 0;
    const runtime = new LocalAgentBridgeRuntime({
      agentEndpoint: "https://api.example.test/api/agent",
      now,
      fetch: async () => { fetchCalls += 1; throw new Error("must not fetch"); },
    });
    const prepared = runtime.prepare();
    await assert.rejects(runtime.claim("agent-run-invalid-clock"), { code: "INVALID_CLOCK", message: "INVALID_CLOCK" });
    assert.equal(fetchCalls, 0);
    assert.deepEqual(runtime.prepare(), prepared);
  }
});

test("a new command fails closed without creating an envelope when the request clock throws", async () => {
  let throwOnClock = false;
  const actions = [];
  const runtime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    now: () => {
      if (throwOnClock) throw new Error("secret command clock failure");
      return new Date("2026-08-31T00:05:00.000Z");
    },
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      actions.push(body.action);
      if (body.action === "claimAgentRun") {
        return Response.json({
          ok: true,
          data: claimedData(body.agentRunId, 1, "2026-08-31T00:15:00.000Z"),
        });
      }
      return Response.json({ ok: true, action: body.action, data: candidateBatchData() });
    },
  });
  runtime.prepare();
  await runtime.claim("agent-run-command-clock");
  throwOnClock = true;

  await assert.rejects(runtime.command("submitProposalBatch", { round: 1, candidates: [] }), {
    code: "INVALID_CLOCK",
    message: "INVALID_CLOCK",
  });
  assert.deepEqual(actions, ["claimAgentRun"]);

  throwOnClock = false;
  await runtime.command("submitProposalBatch", { round: 1, candidates: [] });
  assert.deepEqual(actions, ["claimAgentRun", "submitProposalBatch"]);
});

test("response-time clock failures are uncertain and retain claim and command envelopes", async () => {
  {
    let throwOnClock = false;
    const bodies = [];
    let attempts = 0;
    const runtime = new LocalAgentBridgeRuntime({
      agentEndpoint: "https://api.example.test/api/agent",
      now: () => {
        if (throwOnClock) {
          throwOnClock = false;
          throw new Error("secret response clock failure");
        }
        return new Date("2026-08-31T00:05:00.000Z");
      },
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body);
        bodies.push(init.body);
        attempts += 1;
        if (attempts === 1) throwOnClock = true;
        return Response.json({
          ok: true,
          data: claimedData(body.agentRunId, 1, "2026-08-31T00:15:00.000Z"),
        });
      },
    });
    runtime.prepare();

    await assert.rejects(runtime.claim("agent-run-response-clock-claim"), {
      code: "INVALID_CLOCK",
      message: "INVALID_CLOCK",
    });
    await runtime.claim("agent-run-response-clock-claim");
    assert.equal(bodies[0], bodies[1]);
  }

  {
    let throwOnClock = false;
    const commandBodies = [];
    let commandAttempts = 0;
    const runtime = new LocalAgentBridgeRuntime({
      agentEndpoint: "https://api.example.test/api/agent",
      now: () => {
        if (throwOnClock) {
          throwOnClock = false;
          throw new Error("secret response clock failure");
        }
        return new Date("2026-08-31T00:05:00.000Z");
      },
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body);
        if (body.action === "claimAgentRun") {
          return Response.json({
            ok: true,
            data: claimedData(body.agentRunId, 3, "2026-08-31T00:15:00.000Z"),
          });
        }
        commandBodies.push(init.body);
        commandAttempts += 1;
        if (commandAttempts === 1) throwOnClock = true;
        return Response.json({ ok: true, action: body.action, data: candidateBatchData() });
      },
    });
    runtime.prepare();
    await runtime.claim("agent-run-response-clock-command");
    const payload = { round: 1, candidates: [] };

    await assert.rejects(runtime.command("submitProposalBatch", payload), {
      code: "INVALID_CLOCK",
      message: "INVALID_CLOCK",
    });
    await runtime.command("submitProposalBatch", payload);
    assert.equal(commandBodies[0], commandBodies[1]);
  }
});

test("commands fail closed when the claimed AgentRun reaches its expiry", async () => {
  let now = new Date("2026-08-31T00:05:00.000Z");
  const actions = [];
  const runtime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    now: () => now,
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      actions.push(body.action);
      if (body.action === "claimAgentRun") {
        return Response.json({ ok: true, data: claimedData(body.agentRunId, 1, "2026-08-31T00:06:00.000Z") });
      }
      return Response.json({ ok: true, action: body.action, data: {} });
    },
  });
  runtime.prepare();
  await runtime.claim("agent-run-expiring");
  now = new Date("2026-08-31T00:06:00.000Z");

  await assert.rejects(runtime.getDecisionContext(), /AGENT_RUN_EXPIRED/);
  await assert.rejects(runtime.revokeSelf(), /AGENT_RUN_EXPIRED/);
  assert.deepEqual(actions, ["claimAgentRun"]);

  const unclaimed = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    fetch: async () => { throw new Error("must not fetch"); },
  });
  await assert.rejects(unclaimed.revokeSelf(), /BRIDGE_NOT_CLAIMED/);
});

test("revokeSelf fixes action and payload and replays an uncertain envelope byte-for-byte", async () => {
  const bodies = [];
  let revokeAttempts = 0;
  const runtime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    now: () => new Date("2026-08-31T00:05:00.000Z"),
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(init.body);
      if (body.action === "claimAgentRun") {
        return Response.json({ ok: true, data: claimedData(body.agentRunId, 4) });
      }
      revokeAttempts += 1;
      if (revokeAttempts === 1) throw new TypeError("response lost");
      return Response.json({
        ok: true,
        action: "revokeAgentRunSelf",
        data: { agentRunId: body.agentRunId, revokedAt: "2026-08-31T00:06:00.000Z" },
        replayed: true,
      });
    },
  });
  const prepared = runtime.prepare();
  await runtime.claim("agent-run-revoke");

  await assert.rejects(
    runtime.revokeSelf("submitProposalBatch", { candidates: [{ name: "injected" }] }),
    /AGENT_TRANSPORT_UNAVAILABLE/,
  );
  assert.equal(runtime.nextSequence, 4);
  await assert.doesNotReject(runtime.revokeSelf({ action: "getDecisionContext", payload: { injected: true } }));

  const first = JSON.parse(bodies[1]);
  assert.equal(first.action, "revokeAgentRunSelf");
  assert.deepEqual(first.payload, {});
  assert.equal(first.sequence, 4);
  assert.equal(typeof first.idempotencyKey, "string");
  assert.equal(typeof first.signature, "string");
  assert.equal(bodies[1], bodies[2]);
  assert.equal(runtime.nextSequence, undefined);
  assert.equal(runtime.claimedRun, undefined);
  await assert.rejects(runtime.command("submitProposalBatch", {}), /BRIDGE_NOT_CLAIMED/);
  const nextPrepared = runtime.prepare();
  assert.notDeepEqual(nextPrepared, prepared);
});

test("a persisted signed self-revoke envelope can be reconciled by a fresh runtime without the private key", async () => {
  const bodies = [];
  const first = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    now: () => new Date("2026-08-31T00:05:00.000Z"),
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.action === "claimAgentRun") {
        return Response.json({ ok: true, data: claimedData(body.agentRunId, 7) });
      }
      throw new Error("the first process crashes before sending revoke");
    },
  });
  first.prepare();
  await first.claim("agent-run-restart-revoke");
  const persisted = first.prepareRevokeSelf();

  const restarted = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    now: () => new Date("2026-08-31T00:05:01.000Z"),
    fetch: async (_url, init) => {
      bodies.push(init.body);
      const body = JSON.parse(init.body);
      return Response.json({
        ok: true,
        action: "revokeAgentRunSelf",
        data: { agentRunId: body.agentRunId, revokedAt: "2026-08-31T00:05:01.000Z" },
        replayed: true,
      });
    },
  });

  await assert.doesNotReject(restarted.reconcileRevokeSelf(persisted));
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0], persisted.body);
  assert.equal(JSON.parse(persisted.body).action, "revokeAgentRunSelf");
  assert.deepEqual(JSON.parse(persisted.body).payload, {});
  assert.equal(restarted.claimedRun, undefined);
});

test("an unsent prepared self-revoke can be discarded exactly after local intent persistence fails", async () => {
  let fetchCalls = 0;
  const runtime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    now: () => new Date("2026-08-31T00:05:00.000Z"),
    fetch: async (_url, init) => {
      fetchCalls += 1;
      const body = JSON.parse(init.body);
      return Response.json({ ok: true, data: claimedData(body.agentRunId, 7) });
    },
  });
  runtime.prepare();
  await runtime.claim("agent-run-persist-failed");
  const unsent = runtime.prepareRevokeSelf();

  assert.equal(runtime.discardPreparedRevokeSelf({
    ...unsent,
    expiresAt: "2099-09-01T00:15:01.000Z",
  }), false);
  assert.equal(runtime.discardPreparedRevokeSelf(unsent), true);
  assert.doesNotThrow(() => runtime.prepare());
  assert.equal(fetchCalls, 1);
  assert.equal(runtime.discardPreparedRevokeSelf(unsent), false);
});

test("a persisted self-revoke can retry its exact envelope after a definitive response failure", async () => {
  const first = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    now: () => new Date("2026-08-31T00:05:00.000Z"),
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.action === "claimAgentRun") {
        return Response.json({ ok: true, data: claimedData(body.agentRunId, 7) });
      }
      throw new Error("the first process crashes before sending revoke");
    },
  });
  first.prepare();
  await first.claim("agent-run-restart-revoke-retry");
  const persisted = first.prepareRevokeSelf();

  const bodies = [];
  let attempts = 0;
  const restarted = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    now: () => new Date("2026-08-31T00:05:01.000Z"),
    fetch: async (_url, init) => {
      bodies.push(init.body);
      attempts += 1;
      if (attempts === 1) {
        return Response.json({ ok: false, error: "INVALID_REQUEST" }, { status: 400 });
      }
      return Response.json({
        ok: true,
        action: "revokeAgentRunSelf",
        data: {
          agentRunId: persisted.agentRunId,
          revokedAt: "2026-08-31T00:05:02.000Z",
        },
      });
    },
  });

  await assert.rejects(restarted.reconcileRevokeSelf(persisted), /INVALID_REQUEST/);
  await assert.doesNotReject(restarted.reconcileRevokeSelf(persisted));
  assert.deepEqual(bodies, [persisted.body, persisted.body]);
  assert.equal(restarted.claimedRun, undefined);
});

test("the same runtime retries an exactly persisted self-revoke after a definitive response failure", async () => {
  const bodies = [];
  let revokeAttempts = 0;
  const runtime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    now: () => new Date("2026-08-31T00:05:00.000Z"),
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.action === "claimAgentRun") {
        return Response.json({ ok: true, data: claimedData(body.agentRunId, 7) });
      }
      bodies.push(init.body);
      revokeAttempts += 1;
      if (revokeAttempts === 1) {
        return Response.json({ ok: false, error: "INVALID_REQUEST" }, { status: 400 });
      }
      return Response.json({
        ok: true,
        action: "revokeAgentRunSelf",
        data: { agentRunId: body.agentRunId, revokedAt: "2026-08-31T00:05:01.000Z" },
        replayed: true,
      });
    },
  });
  runtime.prepare();
  await runtime.claim("agent-run-same-process-retry");
  const persisted = runtime.prepareRevokeSelf();

  await assert.rejects(runtime.reconcileRevokeSelf(persisted), /INVALID_REQUEST/);
  await assert.rejects(runtime.reconcileRevokeSelf({
    ...persisted,
    firstSentAt: persisted.firstSentAt + 1,
  }), /COMMAND_RETRY_REQUIRED/);
  await assert.rejects(runtime.reconcileRevokeSelf({
    ...persisted,
    expiresAt: "2099-09-01T00:15:01.000Z",
  }), /COMMAND_RETRY_REQUIRED/);
  const nextSequenceEnvelope = JSON.parse(persisted.body);
  nextSequenceEnvelope.sequence += 1;
  await assert.rejects(runtime.reconcileRevokeSelf({
    ...persisted,
    body: JSON.stringify(nextSequenceEnvelope),
  }), /COMMAND_RETRY_REQUIRED/);
  assert.deepEqual(bodies, [persisted.body]);
  await assert.doesNotReject(runtime.reconcileRevokeSelf(persisted));

  assert.deepEqual(bodies, [persisted.body, persisted.body]);
  assert.equal(runtime.claimedRun, undefined);
});

test("a definitive self-revoke failure clears its pending envelope", async () => {
  const revokeBodies = [];
  let revokeAttempts = 0;
  const runtime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    now: () => new Date("2026-08-31T00:05:00.000Z"),
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.action === "claimAgentRun") {
        return Response.json({ ok: true, data: claimedData(body.agentRunId, 2) });
      }
      revokeBodies.push(init.body);
      revokeAttempts += 1;
      if (revokeAttempts === 1) return Response.json({ ok: false, error: "INVALID_REQUEST" }, { status: 400 });
      return Response.json({
        ok: true,
        action: "revokeAgentRunSelf",
        data: { agentRunId: body.agentRunId, revokedAt: "2026-08-31T00:06:00.000Z" },
      });
    },
  });
  runtime.prepare();
  await runtime.claim("agent-run-revoke-definitive");

  await assert.rejects(runtime.revokeSelf(), /INVALID_REQUEST/);
  await assert.doesNotReject(runtime.revokeSelf());
  assert.notEqual(revokeBodies[0], revokeBodies[1]);
  assert.equal(runtime.nextSequence, undefined);
});

test("a definitive inactive self-revoke clears the claimed capability and allows a fresh prepare", async () => {
  const runtime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.action === "claimAgentRun") {
        return Response.json({ ok: true, data: claimedData(body.agentRunId, 2) });
      }
      return Response.json({ ok: false, error: "INVALID_AGENT_CLAIM" }, { status: 403 });
    },
  });
  const firstMaterial = runtime.prepare();
  await runtime.claim("agent-run-externally-revoked");

  await assert.rejects(runtime.revokeSelf(), { code: "INVALID_AGENT_CLAIM", uncertain: false });

  assert.equal(runtime.claimedRun, undefined);
  const nextMaterial = runtime.prepare();
  assert.notDeepEqual(nextMaterial, firstMaterial);
});

test("an uncertain self-revoke failure retains the claimed capability and stays busy", async () => {
  const runtime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.action === "claimAgentRun") {
        return Response.json({ ok: true, data: claimedData(body.agentRunId, 2) });
      }
      throw new TypeError("response lost");
    },
  });
  runtime.prepare();
  await runtime.claim("agent-run-uncertain-revoke");

  await assert.rejects(runtime.revokeSelf(), { code: "AGENT_TRANSPORT_UNAVAILABLE", uncertain: true });

  assert.equal(runtime.claimedRun?.agentRunId, "agent-run-uncertain-revoke");
  assert.throws(() => runtime.prepare(), { code: "BRIDGE_BUSY" });
});

test("invalid self-revoke success data keeps the capability and pending envelope intact", async () => {
  const cases = [
    ["empty data", {}],
    ["wrong run", { agentRunId: "different-run", revokedAt: "2026-08-31T00:06:00.000Z" }],
    ["invalid time", { agentRunId: "agent-run-strict-revoke", revokedAt: "not-a-date" }],
    ["non-UTC time", { agentRunId: "agent-run-strict-revoke", revokedAt: "2026-08-31T08:06:00+08:00" }],
  ];
  for (const [name, invalidData] of cases) {
    const revokeBodies = [];
    let attempts = 0;
    const runtime = new LocalAgentBridgeRuntime({
      agentEndpoint: "https://api.example.test/api/agent",
      now: () => new Date("2026-08-31T00:05:00.000Z"),
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body);
        if (body.action === "claimAgentRun") {
          return Response.json({ ok: true, data: claimedData(body.agentRunId, 2) });
        }
        revokeBodies.push(init.body);
        attempts += 1;
        return Response.json({
          ok: true,
          action: "revokeAgentRunSelf",
          data: attempts === 1
            ? invalidData
            : { agentRunId: body.agentRunId, revokedAt: "2026-08-31T00:06:00.000Z" },
        });
      },
    });
    runtime.prepare();
    await runtime.claim("agent-run-strict-revoke");

    await assert.rejects(runtime.revokeSelf(), /INVALID_AGENT_RESPONSE/, name);
    assert.deepEqual(runtime.claimedRun, {
      agentRunId: "agent-run-strict-revoke",
      expiresAt: FUTURE_EXPIRES_AT,
      nextSequence: 2,
    });
    assert.throws(() => runtime.prepare(), /BRIDGE_BUSY/);
    await runtime.revokeSelf();

    assert.equal(revokeBodies[0], revokeBodies[1]);
    assert.equal(runtime.claimedRun, undefined);
  }
});

test("self-revoke rejects surplus response fields and returns only a safe exact projection", async () => {
  const invalidResponses = [
    {
      ok: true,
      action: "revokeAgentRunSelf",
      data: { agentRunId: "agent-run-revoke-projection", revokedAt: "2026-08-31T00:06:00.000Z" },
      signature: "server-secret",
    },
    {
      ok: true,
      action: "revokeAgentRunSelf",
      data: {
        agentRunId: "agent-run-revoke-projection",
        revokedAt: "2026-08-31T00:06:00.000Z",
        pairingCode: "server-secret",
      },
    },
  ];
  for (const [index, invalidResponse] of invalidResponses.entries()) {
    const revokeBodies = [];
    let response = invalidResponse;
    const runtime = new LocalAgentBridgeRuntime({
      agentEndpoint: "https://api.example.test/api/agent",
      now: () => new Date("2026-08-31T00:05:00.000Z"),
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body);
        if (body.action === "claimAgentRun") {
          return Response.json({ ok: true, data: claimedData(body.agentRunId, 4) });
        }
        revokeBodies.push(init.body);
        return Response.json(response);
      },
    });
    runtime.prepare();
    await runtime.claim("agent-run-revoke-projection");

    await assert.rejects(runtime.revokeSelf(), /INVALID_AGENT_RESPONSE/, `case ${index}`);
    assert.equal(runtime.claimedRun?.nextSequence, 4);
    assert.throws(() => runtime.prepare(), /BRIDGE_BUSY/);
    response = {
      ok: true,
      action: "revokeAgentRunSelf",
      data: { agentRunId: "agent-run-revoke-projection", revokedAt: "2026-08-31T00:06:00.000Z" },
      replayed: true,
    };
    const result = await runtime.revokeSelf();

    assert.equal(revokeBodies[0], revokeBodies[1]);
    assert.deepEqual(result, response);
    assert.deepEqual(Object.keys(result).sort(), ["action", "data", "ok", "replayed"]);
    assert.deepEqual(Object.keys(result.data).sort(), ["agentRunId", "revokedAt"]);
    assert.equal(JSON.stringify(result).includes("server-secret"), false);
    assert.equal(runtime.claimedRun, undefined);
  }
});

test("a lost response replays the identical signed envelope before advancing sequence", async () => {
  const bodies = [];
  let contextAttempts = 0;
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(init.body);
    if (body.action === "claimAgentRun") {
      return Response.json({ ok: true, data: claimedData(body.agentRunId, 7) });
    }
    contextAttempts += 1;
    if (contextAttempts === 1) throw new TypeError("response lost");
    return Response.json({ ok: true, action: "getDecisionContext", data: { tripId: "trip-1" }, replayed: true });
  };
  const runtime = new LocalAgentBridgeRuntime({ agentEndpoint: "https://api.example.test/api/agent", fetch: fetchImpl });
  runtime.prepare();
  await runtime.claim("agent-run-1");

  await assert.rejects(runtime.getDecisionContext(), { message: "AGENT_TRANSPORT_UNAVAILABLE" });
  assert.equal(runtime.nextSequence, 7);
  await assert.doesNotReject(runtime.getDecisionContext());
  assert.equal(bodies[1], bodies[2]);
  assert.equal(runtime.nextSequence, 8);
});

test("a lost claim response reuses the nonce, pairing code and signature", async () => {
  const bodies = [];
  let attempts = 0;
  const runtime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(init.body);
      attempts += 1;
      if (attempts === 1) throw new TypeError("response lost");
      return Response.json({ ok: true, data: claimedData(body.agentRunId) });
    },
  });
  runtime.prepare();

  await assert.rejects(runtime.claim("agent-run-1"), { message: "AGENT_TRANSPORT_UNAVAILABLE" });
  await assert.doesNotReject(runtime.claim("agent-run-1"));

  assert.equal(bodies[0], bodies[1]);
});

test("a pending claim reconciles after local expiry when the run was valid at first send", async () => {
  let now = new Date("2026-08-31T00:05:00.000Z");
  const bodies = [];
  let attempts = 0;
  const runtime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    now: () => now,
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(init.body);
      attempts += 1;
      if (attempts === 1) throw new TypeError("claim response lost");
      return Response.json({
        ok: true,
        data: {
          agentRunId: body.agentRunId,
          claimedAt: "2026-08-31T00:06:00.000Z",
          expiresAt: "2026-08-31T00:15:00.000Z",
          nextSequence: 1,
        },
      });
    },
  });
  runtime.prepare();

  await assert.rejects(runtime.claim("agent-run-cross-expiry-claim"), /AGENT_TRANSPORT_UNAVAILABLE/);
  now = new Date("2026-08-31T00:20:00.000Z");
  await runtime.claim("agent-run-cross-expiry-claim");

  assert.equal(bodies[0], bodies[1]);
  assert.deepEqual(runtime.claimedRun, {
    agentRunId: "agent-run-cross-expiry-claim",
    expiresAt: "2026-08-31T00:15:00.000Z",
    nextSequence: 1,
  });
  await assert.rejects(runtime.command("submitProposalBatch", {}), /AGENT_RUN_EXPIRED/);
});

test("pending command and revoke envelopes reconcile byte-for-byte after local expiry", async () => {
  for (const action of ["submitProposalBatch", "revokeAgentRunSelf"]) {
    let now = new Date("2026-08-31T00:05:00.000Z");
    const commandBodies = [];
    let attempts = 0;
    const runtime = new LocalAgentBridgeRuntime({
      agentEndpoint: "https://api.example.test/api/agent",
      now: () => now,
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body);
        if (body.action === "claimAgentRun") {
          return Response.json({
            ok: true,
            data: claimedData(body.agentRunId, 1, "2026-08-31T00:06:00.000Z"),
          });
        }
        commandBodies.push(init.body);
        attempts += 1;
        if (attempts === 1) throw new TypeError("command response lost");
        return action === "revokeAgentRunSelf"
          ? Response.json({
            ok: true,
            action,
            data: { agentRunId: body.agentRunId, revokedAt: "2026-08-31T00:07:00.000Z" },
          })
          : Response.json({ ok: true, action, data: candidateBatchData() });
      },
    });
    runtime.prepare();
    await runtime.claim(`agent-run-cross-expiry-${action}`);

    const first = action === "revokeAgentRunSelf"
      ? runtime.revokeSelf()
      : runtime.command(action, { round: 1, candidates: [] });
    await assert.rejects(first, /AGENT_TRANSPORT_UNAVAILABLE/);
    now = new Date("2026-08-31T00:07:00.000Z");
    if (action === "revokeAgentRunSelf") await runtime.revokeSelf();
    else await runtime.command(action, { round: 1, candidates: [] });

    assert.equal(commandBodies[0], commandBodies[1]);
    assert.equal(runtime.nextSequence, action === "revokeAgentRunSelf" ? undefined : 2);
  }
});

test("only expired read-only or revoke pending envelopes can release the local capability", async () => {
  for (const action of ["getDecisionContext", "revokeAgentRunSelf", "submitProposalBatch"]) {
    let now = new Date("2026-08-31T00:05:00.000Z");
    const commandBodies = [];
    let commandAttempts = 0;
    const runtime = new LocalAgentBridgeRuntime({
      agentEndpoint: "https://api.example.test/api/agent",
      now: () => now,
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body);
        if (body.action === "claimAgentRun") {
          return Response.json({
            ok: true,
            data: claimedData(body.agentRunId, 1, "2026-08-31T00:06:00.000Z"),
          });
        }
        commandBodies.push(init.body);
        commandAttempts += 1;
        if (commandAttempts === 1) throw new TypeError("response permanently unknown");
        assert.equal(action, "submitProposalBatch");
        return Response.json({
          ok: true,
          action,
          data: candidateBatchData(),
          replayed: true,
        });
      },
    });
    runtime.prepare();
    await runtime.claim(`agent-run-release-${action}`);

    const first = action === "getDecisionContext"
      ? runtime.getDecisionContext()
      : action === "revokeAgentRunSelf"
        ? runtime.revokeSelf()
        : runtime.submitProposalBatch({ round: 1, candidates: [] });
    await assert.rejects(first, { code: "AGENT_TRANSPORT_UNAVAILABLE", uncertain: true });
    now = new Date("2026-08-31T00:07:00.000Z");

    const released = runtime.releaseExpiredReadOnlyPending();

    assert.equal(released, action !== "submitProposalBatch", action);
    if (action === "submitProposalBatch") {
      assert.throws(() => runtime.prepare(), { code: "BRIDGE_BUSY" });
      await runtime.submitProposalBatch({ round: 1, candidates: [] });
      assert.equal(commandBodies[0], commandBodies[1]);
    } else {
      assert.equal(runtime.claimedRun, undefined, action);
      assert.doesNotThrow(() => runtime.prepare(), action);
      assert.equal(commandBodies.length, 1, action);
    }
  }
});

test("claim replays one envelope across truncated and structurally invalid 2xx responses", async () => {
  const bodies = [];
  let attempts = 0;
  const runtime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(init.body);
      attempts += 1;
      if (attempts === 1) {
        return new Response("{", { status: 200, headers: { "content-type": "application/json" } });
      }
      if (attempts === 2) {
        return Response.json({ ok: true, data: claimedData("different-agent-run") });
      }
      return Response.json({ ok: true, data: claimedData(body.agentRunId, 9) });
    },
  });
  runtime.prepare();

  await assert.rejects(runtime.claim("agent-run-uncertain-claim"), /INVALID_AGENT_RESPONSE/);
  await assert.rejects(runtime.claim("agent-run-uncertain-claim"), /INVALID_AGENT_RESPONSE/);
  assert.equal(runtime.claimedRun, undefined);
  await runtime.claim("agent-run-uncertain-claim");

  assert.equal(bodies[0], bodies[1]);
  assert.equal(bodies[1], bodies[2]);
  assert.deepEqual(runtime.claimedRun, {
    agentRunId: "agent-run-uncertain-claim",
    expiresAt: FUTURE_EXPIRES_AT,
    nextSequence: 9,
  });
});

test("command replays one envelope across truncated and structurally invalid 2xx responses", async () => {
  const commandBodies = [];
  let attempts = 0;
  const runtime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.action === "claimAgentRun") {
        return Response.json({ ok: true, data: claimedData(body.agentRunId, 6) });
      }
      commandBodies.push(init.body);
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
      }
      if (attempts === 2) {
        return new Response("{", { status: 200, headers: { "content-type": "application/json" } });
      }
      if (attempts === 3) {
        return Response.json({ ok: true, action: body.action, data: candidateBatchData(), replayed: "yes" });
      }
      return Response.json({ ok: true, action: body.action, data: candidateBatchData(), replayed: true });
    },
  });
  runtime.prepare();
  await runtime.claim("agent-run-uncertain-command");
  const payload = { round: 1, candidates: [] };

  await assert.rejects(runtime.command("submitProposalBatch", payload), /AGENT_TRANSPORT_UNAVAILABLE/);
  assert.equal(runtime.nextSequence, 6);
  await assert.rejects(runtime.command("submitProposalBatch", payload), /INVALID_AGENT_RESPONSE/);
  assert.equal(runtime.nextSequence, 6);
  await assert.rejects(runtime.command("submitProposalBatch", payload), /INVALID_AGENT_RESPONSE/);
  assert.equal(runtime.nextSequence, 6);
  await runtime.command("submitProposalBatch", payload);

  assert.equal(commandBodies[0], commandBodies[1]);
  assert.equal(commandBodies[1], commandBodies[2]);
  assert.equal(commandBodies[2], commandBodies[3]);
  assert.equal(runtime.nextSequence, 7);
});

test("command rejects non-JSON payloads before creating a pending envelope", async () => {
  const commandBodies = [];
  const runtime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.action === "claimAgentRun") {
        return Response.json({ ok: true, data: claimedData(body.agentRunId) });
      }
      commandBodies.push(init.body);
      return Response.json({ ok: true, action: body.action, data: candidateBatchData() });
    },
  });
  runtime.prepare();
  await runtime.claim("agent-run-invalid-payloads");

  const circular = {};
  circular.self = circular;
  const sparse = [];
  sparse[1] = "value";
  const invalidPayloads = [
    circular,
    1n,
    undefined,
    () => "value",
    { nested: undefined },
    { nested: () => "value" },
    { sparse },
  ];
  for (const payload of invalidPayloads) {
    await assert.rejects(runtime.command("submitProposalBatch", payload), {
      code: "INVALID_REQUEST",
      message: "INVALID_REQUEST",
    });
  }

  await runtime.command("submitProposalBatch", { round: 1, candidates: [] });
  assert.equal(commandBodies.length, 1);
  assert.equal(runtime.nextSequence, 2);
});

test("pending command owns an immutable payload snapshot and raw request body", async () => {
  const commandBodies = [];
  let attempts = 0;
  const runtime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.action === "claimAgentRun") {
        return Response.json({ ok: true, data: claimedData(body.agentRunId, 4) });
      }
      commandBodies.push(init.body);
      attempts += 1;
      if (attempts === 1) throw new TypeError("response lost");
      return Response.json({ ok: true, action: body.action, data: candidateBatchData() });
    },
  });
  runtime.prepare();
  await runtime.claim("agent-run-immutable-payload");
  const payload = { round: 1, candidates: [{ entity: { name: "original" } }] };
  const original = structuredClone(payload);

  await assert.rejects(runtime.command("submitProposalBatch", payload), /AGENT_TRANSPORT_UNAVAILABLE/);
  payload.candidates[0].entity.name = "mutated";
  payload.candidates.push({ entity: { name: "injected" } });
  await runtime.command("submitProposalBatch", original);

  assert.equal(commandBodies[0], commandBodies[1]);
  assert.equal(commandBodies[0].includes("mutated"), false);
  assert.equal(commandBodies[0].includes("injected"), false);
});

test("revokeSelf replays one envelope across truncated and structurally invalid 2xx responses", async () => {
  const revokeBodies = [];
  let attempts = 0;
  const runtime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.action === "claimAgentRun") {
        return Response.json({ ok: true, data: claimedData(body.agentRunId, 3) });
      }
      revokeBodies.push(init.body);
      attempts += 1;
      if (attempts === 1) {
        return new Response("{", { status: 200, headers: { "content-type": "application/json" } });
      }
      if (attempts === 2) {
        return Response.json({ ok: true, action: "submitProposalBatch", data: {} });
      }
      return Response.json({
        ok: true,
        action: "revokeAgentRunSelf",
        data: { agentRunId: body.agentRunId, revokedAt: "2026-08-31T00:06:00.000Z" },
      });
    },
  });
  runtime.prepare();
  await runtime.claim("agent-run-uncertain-revoke");

  await assert.rejects(runtime.revokeSelf(), /INVALID_AGENT_RESPONSE/);
  assert.equal(runtime.nextSequence, 3);
  await assert.rejects(runtime.revokeSelf(), /INVALID_AGENT_RESPONSE/);
  assert.equal(runtime.nextSequence, 3);
  await runtime.revokeSelf();

  assert.equal(revokeBodies[0], revokeBodies[1]);
  assert.equal(revokeBodies[1], revokeBodies[2]);
  assert.equal(runtime.nextSequence, undefined);
});

test("runtime rejects non-HTTPS public transports", () => {
  assert.throws(() => new LocalAgentBridgeRuntime({ agentEndpoint: "http://api.example.test/api/agent" }), /INVALID_AGENT_ENDPOINT/);
  assert.throws(() => new LocalAgentBridgeRuntime({ agentEndpoint: "https://user:secret@api.example.test/api/agent" }), /INVALID_AGENT_ENDPOINT/);
  assert.throws(() => new LocalAgentBridgeRuntime({ agentEndpoint: "https://api.example.test/api/agent?debug=1" }), /INVALID_AGENT_ENDPOINT/);
  assert.throws(() => new LocalAgentBridgeRuntime({ agentEndpoint: "https://api.example.test/api/agent#debug" }), /INVALID_AGENT_ENDPOINT/);
  assert.throws(() => new LocalAgentBridgeRuntime({ agentEndpoint: "https://api.example.test/api/agent", timeoutMs: 0 }), /INVALID_TIMEOUT/);
  assert.throws(() => new LocalAgentBridgeRuntime({ agentEndpoint: "https://api.example.test/api/agent", timeoutMs: 1.5 }), /INVALID_TIMEOUT/);
});

test("public fetches refuse redirects", async () => {
  const runtime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    fetch: async (_url, init) => {
      assert.equal(init.redirect, "error");
      const body = JSON.parse(init.body);
      return Response.json({ ok: true, data: claimedData(body.agentRunId) });
    },
  });
  runtime.prepare();
  await runtime.claim("agent-run-1");
});

test("malformed HTTP responses clear only definite non-transient 4xx envelopes", async () => {
  const cases = [
    [400, false, "INVALID_AGENT_RESPONSE"],
    [408, true, "AGENT_TRANSPORT_UNAVAILABLE"],
    [425, true, "AGENT_TRANSPORT_UNAVAILABLE"],
    [429, true, "AGENT_TRANSPORT_UNAVAILABLE"],
    [500, true, "AGENT_TRANSPORT_UNAVAILABLE"],
    [200, true, "INVALID_AGENT_RESPONSE"],
  ];
  for (const [status, retainsEnvelope, expectedCode] of cases) {
    const commandBodies = [];
    let attempts = 0;
    const runtime = new LocalAgentBridgeRuntime({
      agentEndpoint: "https://api.example.test/api/agent",
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body);
        if (body.action === "claimAgentRun") {
          return Response.json({ ok: true, data: claimedData(body.agentRunId) });
        }
        commandBodies.push(init.body);
        attempts += 1;
        if (attempts === 1) {
          return new Response("{", { status, headers: { "content-type": "application/json" } });
        }
        return Response.json({ ok: true, action: body.action, data: candidateBatchData() });
      },
    });
    runtime.prepare();
    await runtime.claim(`agent-run-http-${status}`);
    const originalPayload = { round: 1, candidates: [] };

    await assert.rejects(runtime.command("submitProposalBatch", originalPayload), {
      code: expectedCode,
      message: expectedCode,
    });
    const retryPayload = retainsEnvelope ? originalPayload : { round: 2, candidates: [] };
    await runtime.command("submitProposalBatch", retryPayload);

    assert.equal(commandBodies.length, 2);
    if (retainsEnvelope) assert.equal(commandBodies[0], commandBodies[1]);
    else assert.notEqual(commandBodies[0], commandBodies[1]);
  }
});

test("prepare, claim and commands are mutually exclusive", async () => {
  let releaseClaim;
  let releaseCommand;
  const claimResponse = new Promise((resolve) => { releaseClaim = resolve; });
  const commandResponse = new Promise((resolve) => { releaseCommand = resolve; });
  const runtime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.action === "claimAgentRun") return claimResponse;
      return commandResponse;
    },
  });
  runtime.prepare();
  const claiming = runtime.claim("agent-run-1");
  assert.throws(() => runtime.prepare(), /BRIDGE_BUSY/);
  await assert.rejects(runtime.claim("agent-run-1"), /BRIDGE_BUSY/);
  releaseClaim(Response.json({ ok: true, data: claimedData("agent-run-1") }));
  await claiming;

  const originalFetch = runtime.command("submitProposalBatch", { proposals: [] });
  await assert.rejects(runtime.command("submitProposalBatch", { proposals: [] }), /BRIDGE_BUSY/);
  assert.throws(() => runtime.prepare(), /BRIDGE_BUSY/);
  releaseCommand(Response.json({ ok: true, action: "submitProposalBatch", data: candidateBatchData() }));
  await originalFetch;
});

test("explicit non-transient 4xx failures clear pending claim and command envelopes", async () => {
  const bodies = [];
  let claimAttempts = 0;
  let commandAttempts = 0;
  const runtime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(init.body);
      if (body.action === "claimAgentRun") {
        claimAttempts += 1;
        if (claimAttempts === 1) return Response.json({ ok: false, error: "INVALID_AGENT_CLAIM" }, { status: 403 });
        return Response.json({ ok: true, data: claimedData(body.agentRunId) });
      }
      commandAttempts += 1;
      if (commandAttempts === 1) return Response.json({ ok: false, error: "INVALID_REQUEST" }, { status: 400 });
      return Response.json({ ok: true, action: body.action, data: candidateBatchData() });
    },
  });
  runtime.prepare();

  await assert.rejects(runtime.claim("agent-run-1"), /INVALID_AGENT_CLAIM/);
  await runtime.claim("agent-run-1");
  assert.notEqual(bodies[0], bodies[1]);

  await assert.rejects(runtime.command("submitProposalBatch", { proposals: [] }), /INVALID_REQUEST/);
  await runtime.command("submitProposalBatch", { proposals: [{ title: "fixed" }] });
  assert.notEqual(bodies[2], bodies[3]);
  assert.equal(runtime.nextSequence, 2);
});

test("an explicit ok-false protocol response clears the pending envelope even with a 2xx status", async () => {
  const bodies = [];
  let attempts = 0;
  const runtime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(init.body);
      attempts += 1;
      if (attempts === 1) {
        return Response.json({ ok: false, error: "INVALID_AGENT_CLAIM" });
      }
      return Response.json({ ok: true, data: claimedData(body.agentRunId) });
    },
  });
  runtime.prepare();

  await assert.rejects(runtime.claim("agent-run-explicit-failure"), /INVALID_AGENT_CLAIM/);
  await runtime.claim("agent-run-explicit-failure");

  assert.notEqual(bodies[0], bodies[1]);
});

test("remote failure codes are allowlisted and injected values are sanitized", async () => {
  for (const [status, remoteCode, expectedCode] of [
    [403, "ADMIN_REQUIRED", "ADMIN_REQUIRED"],
    [403, "REMOTE_SECRET_CODE", "INVALID_AGENT_RESPONSE"],
    [200, "REMOTE_SECRET_CODE", "INVALID_AGENT_RESPONSE"],
  ]) {
    const bodies = [];
    let attempts = 0;
    const runtime = new LocalAgentBridgeRuntime({
      agentEndpoint: "https://api.example.test/api/agent",
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body);
        bodies.push(init.body);
        attempts += 1;
        if (attempts === 1) return Response.json({ ok: false, error: remoteCode }, { status });
        return Response.json({ ok: true, data: claimedData(body.agentRunId) });
      },
    });
    runtime.prepare();

    await assert.rejects(runtime.claim(`agent-run-remote-${status}-${remoteCode}`), (error) => {
      assert.equal(error.code, expectedCode);
      assert.equal(error.message, expectedCode);
      assert.equal(error.message.includes("REMOTE_SECRET_CODE"), false);
      return true;
    });
    await runtime.claim(`agent-run-remote-${status}-${remoteCode}`);
    assert.notEqual(bodies[0], bodies[1]);
  }
});

test("scope, response shape and sequence boundary are enforced before advancing", async () => {
  let commandAttempts = 0;
  const runtime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.action === "claimAgentRun") {
        return Response.json({ ok: true, data: claimedData(body.agentRunId, 3) });
      }
      commandAttempts += 1;
      if (commandAttempts === 1) return Response.json({ ok: true, action: body.action });
      return Response.json({ ok: true, action: body.action, data: candidateBatchData() });
    },
  });
  runtime.prepare();
  await runtime.claim("agent-run-1");

  await assert.rejects(runtime.command("appendEvidenceSnapshot", {}), /ACTION_NOT_ALLOWED/);
  await assert.rejects(runtime.command("submitProposalBatch", { proposals: [] }), /INVALID_AGENT_RESPONSE/);
  assert.equal(runtime.nextSequence, 3);
  await runtime.command("submitProposalBatch", { proposals: [] });
  assert.equal(runtime.nextSequence, 4);

  const exhausted = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      return Response.json({ ok: true, data: claimedData(body.agentRunId, Number.MAX_SAFE_INTEGER) });
    },
  });
  exhausted.prepare();
  await exhausted.claim("agent-run-max");
  await assert.rejects(exhausted.command("submitProposalBatch", {}), /SEQUENCE_EXHAUSTED/);
});

test("a response lost after public-adapter commit replays once without rerunning the operation", async () => {
  const backendBridge = createDecisionAgentBridge({ now: () => new Date("2026-08-31T00:05:00.000Z") });
  const runs = new Map();
  const { transaction } = createTransaction(runs);
  let operationCalls = 0;
  const handler = createTripHandler({
    commands: {
      async executeAgent(input) {
        if (input.action === "claimAgentRun") return backendBridge.claim(transaction, input);
        const result = await backendBridge.run(transaction, input, async () => {
          operationCalls += 1;
          return { context: { tripId: "trip-1" } };
        });
        return { ...result.result, replayed: result.replayed };
      },
    },
  });
  const publicAdapter = createAgentHttpHandler({ handler });
  const commandBodies = [];
  let discardFirstCommittedResponse = true;
  const runtime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    now: () => new Date("2026-08-31T00:05:00.000Z"),
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      const result = await publicAdapter({
        httpMethod: "POST",
        path: "/api/agent",
        headers: { "content-type": "application/json" },
        body: init.body,
      });
      if (body.action !== "claimAgentRun") {
        commandBodies.push(init.body);
        if (discardFirstCommittedResponse) {
          discardFirstCommittedResponse = false;
          throw new TypeError("response lost after commit");
        }
      }
      return new Response(result.body, { status: result.statusCode, headers: result.headers });
    },
  });
  const prepared = runtime.prepare();
  runs.set("agent-run-1", {
    id: "agent-run-1",
    tripId: "trip-1",
    creatorUid: "member-1",
    publicKeyJwk: prepared.publicKeyJwk,
    pairingCodeHash: prepared.pairingCodeHash,
    scope: ["submitProposalBatch"],
    status: "pending_claim",
    lastSequence: 0,
    revision: 1,
    expiresAt: "2026-08-31T00:15:00.000Z",
  });
  await runtime.claim("agent-run-1");

  await assert.rejects(runtime.getDecisionContext(), /AGENT_TRANSPORT_UNAVAILABLE/);
  assert.equal(runtime.nextSequence, 1);
  const replayedContext = await runtime.getDecisionContext();

  assert.equal(replayedContext.tripId, "trip-1");
  assert.equal(operationCalls, 1);
  assert.equal(commandBodies[0], commandBodies[1]);
  assert.equal(runtime.nextSequence, 2);
});

test("runtime envelopes pass the backend canonical and signature verifier", async () => {
  let transaction;
  const backendBridge = createDecisionAgentBridge({ now: () => new Date("2026-08-31T00:05:00.000Z") });
  const runtime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    now: () => new Date("2026-08-31T00:05:00.000Z"),
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.action === "claimAgentRun") {
        const data = await backendBridge.claim(transaction, body);
        return Response.json({ ok: true, data });
      }
      const result = await backendBridge.run(transaction, body, async () => ({ context: { tripId: "trip-1" } }));
      return Response.json({ ok: true, action: body.action, data: result.result.context, replayed: result.replayed });
    },
  });
  const prepared = runtime.prepare();
  const runs = new Map([["agent-run-1", {
    id: "agent-run-1",
    tripId: "trip-1",
    publicKeyJwk: prepared.publicKeyJwk,
    pairingCodeHash: prepared.pairingCodeHash,
    scope: ["submitProposalBatch"],
    status: "pending_claim",
    lastSequence: 0,
    revision: 1,
    expiresAt: "2026-08-31T00:15:00.000Z",
  }]]);
  const idempotency = new Map();
  transaction = {
    collection(name) {
      const store = name === "trip_agent_runs" ? runs : idempotency;
      return { doc(id) { return {
        async get() { const value = store.get(id); return { data: value ? [structuredClone(value)] : [] }; },
        async set(value) { store.set(id, structuredClone(value)); },
      }; } };
    },
  };

  await runtime.claim("agent-run-1");
  await assert.doesNotReject(runtime.getDecisionContext());
  assert.equal(runs.get("agent-run-1").lastSequence, 1);
  assert.equal(sha256Base64Url("known"), createHash("sha256").update("known").digest("base64url"));
});
