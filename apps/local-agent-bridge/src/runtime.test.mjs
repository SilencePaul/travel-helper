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
      return Response.json({ ok: true, action: body.action, data: {} });
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

test("claim fails closed when the clock cannot prove the expiry is in the future", async () => {
  const runtime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.example.test/api/agent",
    now: () => new Date(Number.NaN),
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      return Response.json({ ok: true, data: claimedData(body.agentRunId) });
    },
  });
  runtime.prepare();
  await assert.rejects(runtime.claim("agent-run-invalid-clock"), /INVALID_AGENT_RESPONSE/);
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
  runtime.prepare();
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
  assert.equal(runtime.nextSequence, 5);
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
      return Response.json({ ok: true, action: "revokeAgentRunSelf", data: { agentRunId: body.agentRunId } });
    },
  });
  runtime.prepare();
  await runtime.claim("agent-run-revoke-definitive");

  await assert.rejects(runtime.revokeSelf(), /INVALID_REQUEST/);
  await assert.doesNotReject(runtime.revokeSelf());
  assert.notEqual(revokeBodies[0], revokeBodies[1]);
  assert.equal(runtime.nextSequence, 3);
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
  releaseCommand(Response.json({ ok: true, action: "submitProposalBatch", data: [] }));
  await originalFetch;
});

test("definitive errors clear pending envelopes while transient failures retain them", async () => {
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
      return Response.json({ ok: true, action: body.action, data: {} });
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
      return Response.json({ ok: true, action: body.action, data: {} });
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

  await assert.rejects(runtime.command("getDecisionContext", {}), /AGENT_TRANSPORT_UNAVAILABLE/);
  assert.equal(runtime.nextSequence, 1);
  const replay = await runtime.command("getDecisionContext", {});

  assert.equal(replay.replayed, true);
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
