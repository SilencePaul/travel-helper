import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";

import { buildConnectionUrl, startLocalAgentBridge } from "./server.mjs";

function rawRequest(port, { method = "POST", path = "/v1/agent-runs/prepare", host = `127.0.0.1:${port}`, origin = "https://trip.example", contentType = "application/json", body = "{}", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, method, path, headers: { host, origin, ...(contentType ? { "content-type": contentType } : {}), "content-length": Buffer.byteLength(body), ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function slowRequest(port) {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: "127.0.0.1",
      port,
      method: "POST",
      path: "/v1/agent-runs/prepare",
      headers: { host: `127.0.0.1:${port}`, origin: "https://trip.example", "content-type": "application/json" },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        req.destroy();
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.on("error", reject);
    req.write("{");
  });
}

test("loopback HTTP enforces Host, Origin, method, type and body size before runtime access", async (context) => {
  let prepareCalls = 0;
  const runtime = {
    prepare() { prepareCalls += 1; return { publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" }, pairingCodeHash: "x".repeat(43), pairingCodeFingerprint: "ABCD · 1234" }; },
    async claim(agentRunId) { return { agentRunId, status: "claimed" }; },
  };
  const bridge = await startLocalAgentBridge({ appUrl: "https://trip.example/path", port: 0, runtime, maxBodyBytes: 64 });
  context.after(() => bridge.close());

  const preflight = await rawRequest(bridge.port, { method: "OPTIONS", contentType: undefined, body: "", headers: { "access-control-request-method": "POST", "access-control-request-headers": "content-type", "access-control-request-private-network": "true" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], "https://trip.example");
  assert.equal(preflight.headers["access-control-allow-private-network"], "true");

  for (const input of [
    { origin: "https://attacker.example" },
    { host: `localhost:${bridge.port}` },
    { method: "GET" },
    { contentType: "text/plain" },
    { body: JSON.stringify({ scope: ["x".repeat(100)] }) },
  ]) {
    const response = await rawRequest(bridge.port, input);
    assert.equal(response.status >= 400 && response.status < 500, true);
    assert.equal(response.body.includes("trip.example"), false);
  }
  assert.equal(prepareCalls, 0);

  const accepted = await rawRequest(bridge.port, { body: JSON.stringify({ scope: ["submitProposalBatch"] }) });
  assert.equal(accepted.status, 200);
  assert.equal(prepareCalls, 1);
});

test("the connection URL carries only the loopback origin in a fragment", () => {
  const url = new URL(buildConnectionUrl("https://trip.example/decisions?tab=agent", "http://127.0.0.1:43120"));
  assert.equal(url.origin, "https://trip.example");
  assert.equal(url.hash, "#agentBridge=http%3A%2F%2F127.0.0.1%3A43120");
  assert.equal(url.href.includes("pairing"), false);
  assert.throws(() => buildConnectionUrl("https://*.trip.example/decisions", "http://127.0.0.1:43120"), /INVALID_APP_URL/);
  assert.throws(() => buildConnectionUrl("https://trip.example/decisions#existing", "http://127.0.0.1:43120"), /INVALID_APP_URL/);
});

test("startup rejects non-HTTPS apps and non-loopback bind addresses", async () => {
  await assert.rejects(startLocalAgentBridge({ appUrl: "http://trip.example", port: 0, runtime: {} }), /INVALID_APP_URL/);
  await assert.rejects(startLocalAgentBridge({ appUrl: "https://trip.example", host: "0.0.0.0", port: 0, runtime: {} }), /INVALID_BIND_ADDRESS/);
});

test("startup validates numeric limits and times out a slow request body", async (context) => {
  const runtime = {
    prepare() { return { pairingCodeFingerprint: "ABCD · 1234" }; },
    async claim(agentRunId) { return { agentRunId }; },
  };
  for (const options of [
    { port: 1.5 },
    { maxBodyBytes: 0 },
    { maxBodyBytes: 1.5 },
    { bodyTimeoutMs: 0 },
    { bodyTimeoutMs: 1.5 },
  ]) {
    await assert.rejects(startLocalAgentBridge({ appUrl: "https://trip.example", runtime, ...options }));
  }
  const bridge = await startLocalAgentBridge({ appUrl: "https://trip.example", runtime, bodyTimeoutMs: 25 });
  context.after(() => bridge.close());

  const response = await slowRequest(bridge.port);
  assert.equal(response.status, 408);
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: "INVALID_REQUEST" });

  await Promise.all([bridge.close(), bridge.close(), bridge.close()]);
});
