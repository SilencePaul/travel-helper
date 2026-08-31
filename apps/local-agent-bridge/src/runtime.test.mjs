import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

import { LocalAgentBridgeRuntime, canonicalJson } from "./runtime.mjs";

const require = createRequire(import.meta.url);
const { createDecisionAgentBridge, sha256Base64Url } = require("../../../functions/trip-api/lib/decision-agent-bridge.js");
const { createAgentHttpHandler, createTripHandler } = require("../../../functions/trip-api/index.js");

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
      return Response.json({ ok: true, data: { agentRunId: body.agentRunId, claimedAt: "2026-08-31T00:00:00.000Z", nextSequence: 1 } });
    }
    const { signature, ...signed } = body;
    assert.equal(verifies(prepared.publicKeyJwk, signed, signature), true);
    return Response.json({ ok: true, action: "getDecisionContext", data: { tripId: "trip-1", preferences: [], candidates: [] } });
  };
  const runtime = new LocalAgentBridgeRuntime({ agentEndpoint: "https://api.example.test/api/agent", fetch: fetchImpl });

  prepared = runtime.prepare(["submitProposalBatch"]);
  assert.deepEqual(Object.keys(prepared).sort(), ["pairingCodeFingerprint", "pairingCodeHash", "publicKeyJwk"]);
  assert.equal(JSON.stringify(prepared).includes("private"), false);
  await assert.doesNotReject(runtime.claim("agent-run-1"));
  await assert.doesNotReject(runtime.getDecisionContext());
  assert.deepEqual(requests.map((request) => request.action), ["claimAgentRun", "getDecisionContext"]);
  assert.equal(requests[1].sequence, 1);
});

test("a lost response replays the identical signed envelope before advancing sequence", async () => {
  const bodies = [];
  let contextAttempts = 0;
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(init.body);
    if (body.action === "claimAgentRun") {
      return Response.json({ ok: true, data: { agentRunId: body.agentRunId, claimedAt: "2026-08-31T00:00:00.000Z", nextSequence: 7 } });
    }
    contextAttempts += 1;
    if (contextAttempts === 1) throw new TypeError("response lost");
    return Response.json({ ok: true, action: "getDecisionContext", data: { tripId: "trip-1" }, replayed: true });
  };
  const runtime = new LocalAgentBridgeRuntime({ agentEndpoint: "https://api.example.test/api/agent", fetch: fetchImpl });
  runtime.prepare(["submitProposalBatch"]);
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
      return Response.json({ ok: true, data: { agentRunId: body.agentRunId, claimedAt: "2026-08-31T00:00:00.000Z", nextSequence: 1 } });
    },
  });
  runtime.prepare(["submitProposalBatch"]);

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
      return Response.json({ ok: true, data: { agentRunId: body.agentRunId, claimedAt: "2026-08-31T00:00:00.000Z", nextSequence: 1 } });
    },
  });
  runtime.prepare(["submitProposalBatch"]);
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
  runtime.prepare(["submitProposalBatch"]);
  const claiming = runtime.claim("agent-run-1");
  assert.throws(() => runtime.prepare(["submitProposalBatch"]), /BRIDGE_BUSY/);
  await assert.rejects(runtime.claim("agent-run-1"), /BRIDGE_BUSY/);
  releaseClaim(Response.json({ ok: true, data: { agentRunId: "agent-run-1", claimedAt: "2026-08-31T00:00:00.000Z", nextSequence: 1 } }));
  await claiming;

  const originalFetch = runtime.command("submitProposalBatch", { proposals: [] });
  await assert.rejects(runtime.command("submitProposalBatch", { proposals: [] }), /BRIDGE_BUSY/);
  assert.throws(() => runtime.prepare(["submitProposalBatch"]), /BRIDGE_BUSY/);
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
        return Response.json({ ok: true, data: { agentRunId: body.agentRunId, claimedAt: "2026-08-31T00:00:00.000Z", nextSequence: 1 } });
      }
      commandAttempts += 1;
      if (commandAttempts === 1) return Response.json({ ok: false, error: "INVALID_REQUEST" }, { status: 400 });
      return Response.json({ ok: true, action: body.action, data: {} });
    },
  });
  runtime.prepare(["submitProposalBatch"]);

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
        return Response.json({ ok: true, data: { agentRunId: body.agentRunId, claimedAt: "2026-08-31T00:00:00.000Z", nextSequence: 3 } });
      }
      commandAttempts += 1;
      if (commandAttempts === 1) return Response.json({ ok: true, action: body.action });
      return Response.json({ ok: true, action: body.action, data: {} });
    },
  });
  runtime.prepare(["submitProposalBatch"]);
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
      return Response.json({ ok: true, data: { agentRunId: body.agentRunId, claimedAt: "2026-08-31T00:00:00.000Z", nextSequence: Number.MAX_SAFE_INTEGER } });
    },
  });
  exhausted.prepare(["submitProposalBatch"]);
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
  const prepared = runtime.prepare(["submitProposalBatch"]);
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
  const prepared = runtime.prepare(["submitProposalBatch"]);
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
