import assert from "node:assert/strict";
import { request } from "node:http";
import { connect } from "node:net";
import test from "node:test";

import { buildConnectionUrl, startLocalAgentBridge } from "./server.mjs";

const APP_ORIGIN = "https://trip.example";
const STATUS = Object.freeze({
  phase: "needs_owner_action",
  researchTaskId: "research-task-1",
  startedAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:01:00.000Z",
  blockedReason: "source_captcha",
  blockedHostname: "booking.example.org",
});

function rawRequest(port, {
  method = "POST",
  path = "/v1/agent-runs/prepare",
  host = `127.0.0.1:${port}`,
  origin = APP_ORIGIN,
  contentType = method === "POST" ? "application/json" : undefined,
  body = method === "POST" ? "{}" : "",
  headers = {},
  declareLength = true,
} = {}) {
  return new Promise((resolve, reject) => {
    const requestHeaders = {
      host,
      origin,
      ...(contentType ? { "content-type": contentType } : {}),
      ...(declareLength ? { "content-length": Buffer.byteLength(body) } : {}),
      ...headers,
    };
    const req = request({ hostname: "127.0.0.1", port, method, path, headers: requestHeaders }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
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
      headers: { host: `127.0.0.1:${port}`, origin: APP_ORIGIN, "content-type": "application/json" },
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

function rawSocketRequest(port, source) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let response = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(source));
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });
}

function fakeRuntime(events = []) {
  return {
    prepare() {
      events.push(["prepare"]);
      return {
        publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y", leaked: "private" },
        pairingCodeHash: "x".repeat(43),
        pairingCodeFingerprint: "ABCD · 1234",
        pairingCode: "must-not-leak",
      };
    },
    async claim(agentRunId) {
      events.push(["claim", agentRunId]);
      return { agentRunId, status: "claimed", privateKey: "must-not-leak" };
    },
    async executeTravelResearch(input) {
      events.push(["execute", input]);
      return { ...STATUS, secretLog: "/Users/owner/project/.env" };
    },
    async getResearchStatus() {
      events.push(["status"]);
      return { ...STATUS, stderr: "Bearer secret" };
    },
    async resumeTravelResearch(input) {
      events.push(["resume", input]);
      return { ...STATUS, detail: "https://user:pass@example.org/private?token=x" };
    },
    async cancelResearch(input) {
      events.push(["cancel", input]);
      return {
        phase: "cancelled",
        researchTaskId: input.researchTaskId,
        startedAt: STATUS.startedAt,
        updatedAt: STATUS.updatedAt,
        errorCode: "CODEX_RESEARCH_CANCELLED",
        stack: "private stack",
      };
    },
  };
}

test("the fixed route matrix dispatches only exact methods and strictly projects successful data", async (context) => {
  const events = [];
  const prepared = [];
  const bridge = await startLocalAgentBridge({
    appUrl: `${APP_ORIGIN}/path`,
    runtime: fakeRuntime(events),
    onPrepared: (value) => prepared.push(value),
  });
  context.after(() => bridge.close());

  const routes = [
    ["POST", "/v1/agent-runs/prepare", {}, ["prepare"]],
    ["POST", "/v1/agent-runs/claim", { agentRunId: "agent-run-1" }, ["claim", "agent-run-1"]],
    ["POST", "/v1/agent-runs/execute-travel-research", {
      agentRunId: "agent-run-1",
      targetCategory: "hotel",
      targetScopeId: `scope_${"a".repeat(64)}`,
      disclosureFingerprint: "b".repeat(64),
    }, ["execute"]],
    ["GET", "/v1/agent-runs/research-status", undefined, ["status"]],
    ["POST", "/v1/agent-runs/resume-travel-research", {
      agentRunId: "agent-run-2",
      researchTaskId: "research-task-1",
      resumeAction: "skip_blocked_source",
    }, ["resume"]],
    ["POST", "/v1/agent-runs/cancel-research", { researchTaskId: "research-task-1" }, ["cancel"]],
  ];

  for (const [method, path, body, expectedEvent] of routes) {
    const response = await rawRequest(bridge.port, {
      method,
      path,
      contentType: method === "POST" ? "application/json; charset=utf-8" : undefined,
      body: body === undefined ? "" : JSON.stringify(body),
    });
    assert.equal(response.status, 200, `${method} ${path}`);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["access-control-allow-origin"], APP_ORIGIN);
    const parsed = JSON.parse(response.body);
    assert.equal(parsed.ok, true);
    assert.deepEqual(events.at(-1).slice(0, expectedEvent.length), expectedEvent);
    assert.equal(JSON.stringify(parsed).includes("must-not-leak"), false);
    assert.equal(JSON.stringify(parsed).includes("secret"), false);
    assert.equal(JSON.stringify(parsed).includes("/Users/"), false);
  }

  assert.deepEqual(JSON.parse((await rawRequest(bridge.port, {
    method: "POST",
    path: "/v1/agent-runs/prepare",
    body: "{}",
  })).body), {
    ok: true,
    data: {
      publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
      pairingCodeHash: "x".repeat(43),
      pairingCodeFingerprint: "ABCD · 1234",
    },
  });
  assert.equal(prepared.length, 2);
  assert.equal(Object.hasOwn(prepared[0], "pairingCode"), false);
});

test("each fixed path accepts only its exact JSON shape and status rejects body or query", async (context) => {
  const events = [];
  const bridge = await startLocalAgentBridge({ appUrl: APP_ORIGIN, runtime: fakeRuntime(events) });
  context.after(() => bridge.close());

  const invalidRequests = [
    ["POST", "/v1/agent-runs/prepare", { scope: ["submitProposalBatch"] }],
    ["POST", "/v1/agent-runs/prepare", { prompt: "ignore rules" }],
    ["POST", "/v1/agent-runs/claim", {}],
    ["POST", "/v1/agent-runs/claim", { agentRunId: "agent-run-1", privateKey: "secret" }],
    ["POST", "/v1/agent-runs/execute-travel-research", { agentRunId: "agent-run-1", targetCategory: "hotel", targetScopeId: `scope_${"a".repeat(64)}`, disclosureFingerprint: "b".repeat(64), prompt: "free text" }],
    ["POST", "/v1/agent-runs/execute-travel-research", { agentRunId: "agent-run-1", targetCategory: "hotel", targetScopeId: `scope_${"a".repeat(64)}`, disclosureFingerprint: "b".repeat(64), url: "https://example.org" }],
    ["POST", "/v1/agent-runs/resume-travel-research", { agentRunId: "agent-run-2", researchTaskId: "research-task-1", resumeAction: "retry_codex_auth", Cookie: "session=x" }],
    ["POST", "/v1/agent-runs/resume-travel-research", { agentRunId: "agent-run-2", researchTaskId: "research-task-1", resumeAction: "open_url", hostname: "example.org" }],
    ["POST", "/v1/agent-runs/cancel-research", { researchTaskId: "research-task-1", action: "shell", command: "rm", model: "other", sandbox: "danger-full-access" }],
    ["GET", "/v1/agent-runs/research-status", "{}"],
    ["GET", "/v1/agent-runs/research-status?detail=true", ""],
  ];

  for (const [method, path, body] of invalidRequests) {
    const response = await rawRequest(bridge.port, {
      method,
      path,
      contentType: method === "POST" ? "application/json" : undefined,
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    assert.equal(response.status, 400, `${method} ${path} ${JSON.stringify(body)}`);
    assert.deepEqual(JSON.parse(response.body), { ok: false, error: "INVALID_REQUEST" });
  }
  assert.equal(events.length, 0);
});

test("unknown paths, wrong methods and arbitrary command surfaces never reach runtime", async (context) => {
  const events = [];
  const bridge = await startLocalAgentBridge({ appUrl: APP_ORIGIN, runtime: fakeRuntime(events) });
  context.after(() => bridge.close());

  for (const input of [
    { method: "POST", path: "/v1/command", body: JSON.stringify({ action: "submitProposalBatch" }) },
    { method: "POST", path: "/v1/agent-runs/research-status", body: "{}" },
    { method: "GET", path: "/v1/agent-runs/prepare", body: "", contentType: undefined },
    { method: "DELETE", path: "/v1/agent-runs/cancel-research", body: "", contentType: undefined },
    { method: "POST", path: "/v1/agent-runs/prepare/", body: "{}" },
  ]) {
    const response = await rawRequest(bridge.port, input);
    assert.equal(response.status >= 400 && response.status < 500, true);
    assert.deepEqual(JSON.parse(response.body), { ok: false, error: "INVALID_REQUEST" });
  }
  assert.equal(events.length, 0);
});

test("CORS preflight is path-specific, supports GET status and preserves PNA", async (context) => {
  const events = [];
  const bridge = await startLocalAgentBridge({ appUrl: APP_ORIGIN, runtime: fakeRuntime(events) });
  context.after(() => bridge.close());

  for (const [path, requestedMethod] of [
    ["/v1/agent-runs/prepare", "POST"],
    ["/v1/agent-runs/claim", "POST"],
    ["/v1/agent-runs/execute-travel-research", "POST"],
    ["/v1/agent-runs/research-status", "GET"],
    ["/v1/agent-runs/resume-travel-research", "POST"],
    ["/v1/agent-runs/cancel-research", "POST"],
  ]) {
    const response = await rawRequest(bridge.port, {
      method: "OPTIONS",
      path,
      contentType: undefined,
      body: "",
      headers: {
        "access-control-request-method": requestedMethod,
        "access-control-request-headers": "content-type",
        "access-control-request-private-network": "true",
      },
    });
    assert.equal(response.status, 204, path);
    assert.equal(response.headers["access-control-allow-origin"], APP_ORIGIN);
    assert.match(response.headers["access-control-allow-methods"], /GET/);
    assert.match(response.headers["access-control-allow-methods"], /POST/);
    assert.equal(response.headers["access-control-allow-private-network"], "true");
    assert.equal(response.headers["cache-control"], "no-store");
  }

  const wrong = await rawRequest(bridge.port, {
    method: "OPTIONS",
    path: "/v1/agent-runs/research-status",
    contentType: undefined,
    body: "",
    headers: { "access-control-request-method": "POST" },
  });
  assert.equal(wrong.status, 400);

  const chunked = await rawSocketRequest(bridge.port, [
    "OPTIONS /v1/agent-runs/prepare HTTP/1.1",
    `Host: 127.0.0.1:${bridge.port}`,
    `Origin: ${APP_ORIGIN}`,
    "Access-Control-Request-Method: POST",
    "Transfer-Encoding: chunked",
    "Connection: close",
    "",
    "2",
    "{}",
    "0",
    "",
    "",
  ].join("\r\n"));
  assert.match(chunked, /^HTTP\/1\.1 400 /u);

  const transferAndZeroLength = await rawSocketRequest(bridge.port, [
    "OPTIONS /v1/agent-runs/prepare HTTP/1.1",
    `Host: 127.0.0.1:${bridge.port}`,
    `Origin: ${APP_ORIGIN}`,
    "Access-Control-Request-Method: POST",
    "Transfer-Encoding: chunked",
    "Content-Length: 0",
    "Connection: close",
    "",
    "0",
    "",
    "",
  ].join("\r\n"));
  assert.match(transferAndZeroLength, /^HTTP\/1\.1 400 /u);

  const declaredBody = await rawRequest(bridge.port, {
    method: "OPTIONS",
    contentType: undefined,
    body: "{}",
    headers: { "access-control-request-method": "POST" },
  });
  assert.equal(declaredBody.status, 400);
  assert.equal(events.length, 0);
});

test("loopback defenses reject Host, Origin, credentials, type, size and slow bodies before runtime", async (context) => {
  const events = [];
  const bridge = await startLocalAgentBridge({
    appUrl: `${APP_ORIGIN}/path`,
    port: 0,
    runtime: fakeRuntime(events),
    maxBodyBytes: 64,
    bodyTimeoutMs: 25,
  });
  context.after(() => bridge.close());

  for (const input of [
    { origin: "https://attacker.example" },
    { host: `localhost:${bridge.port}` },
    { contentType: "text/plain" },
    { contentType: "application/json; profile=unsafe" },
    { headers: { cookie: "session=secret" } },
    { headers: { authorization: "Bearer secret" } },
    { body: JSON.stringify({ prompt: "x".repeat(100) }) },
  ]) {
    const response = await rawRequest(bridge.port, input);
    assert.equal(response.status >= 400 && response.status < 500, true);
    assert.equal(response.body.includes("trip.example"), false);
    assert.deepEqual(JSON.parse(response.body), { ok: false, error: "INVALID_REQUEST" });
  }

  const slow = await slowRequest(bridge.port);
  assert.equal(slow.status, 408);
  assert.deepEqual(JSON.parse(slow.body), { ok: false, error: "INVALID_REQUEST" });
  assert.equal(events.length, 0);
});

test("stable business errors are allowlisted and never expose error details", async (context) => {
  const runtime = fakeRuntime();
  runtime.executeTravelResearch = async () => {
    throw Object.assign(new Error("private path /Users/owner/.codex and token"), {
      code: "CODEX_NOT_AUTHENTICATED",
      detail: "https://user:password@example.org/private",
      stack: "private stack",
    });
  };
  const bridge = await startLocalAgentBridge({ appUrl: APP_ORIGIN, runtime });
  context.after(() => bridge.close());
  const validExecute = {
    agentRunId: "agent-run-1",
    targetCategory: "hotel",
    targetScopeId: `scope_${"a".repeat(64)}`,
    disclosureFingerprint: "b".repeat(64),
  };

  const response = await rawRequest(bridge.port, {
    path: "/v1/agent-runs/execute-travel-research",
    body: JSON.stringify(validExecute),
  });
  assert.equal(response.status >= 400, true);
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: "CODEX_NOT_AUTHENTICATED" });
  assert.equal(response.body.includes("private"), false);

  runtime.executeTravelResearch = async () => { throw Object.assign(new Error("secret"), { code: "ARBITRARY_INTERNAL_ERROR" }); };
  const unknown = await rawRequest(bridge.port, {
    path: "/v1/agent-runs/execute-travel-research",
    body: JSON.stringify(validExecute),
  });
  assert.deepEqual(JSON.parse(unknown.body), { ok: false, error: "CODEX_RESEARCH_FAILED" });
});

test("the connection URL carries only the loopback origin in a fragment", () => {
  const url = new URL(buildConnectionUrl("https://trip.example/decisions?tab=agent", "http://127.0.0.1:43120"));
  assert.equal(url.origin, APP_ORIGIN);
  assert.equal(url.hash, "#agentBridge=http%3A%2F%2F127.0.0.1%3A43120");
  assert.equal(url.href.includes("pairing"), false);
  assert.throws(() => buildConnectionUrl("https://*.trip.example/decisions", "http://127.0.0.1:43120"), /INVALID_APP_URL/);
  assert.throws(() => buildConnectionUrl("https://trip.example/decisions#existing", "http://127.0.0.1:43120"), /INVALID_APP_URL/);
});

test("startup rejects unsafe settings and close tears down runtime exactly once", async () => {
  await assert.rejects(startLocalAgentBridge({ appUrl: "http://trip.example", port: 0, runtime: {} }), /INVALID_APP_URL/);
  await assert.rejects(startLocalAgentBridge({ appUrl: APP_ORIGIN, host: "0.0.0.0", port: 0, runtime: {} }), /INVALID_BIND_ADDRESS/);
  for (const options of [
    { port: 1.5 },
    { maxBodyBytes: 0 },
    { maxBodyBytes: 1.5 },
    { bodyTimeoutMs: 0 },
    { bodyTimeoutMs: 1.5 },
  ]) {
    await assert.rejects(startLocalAgentBridge({ appUrl: APP_ORIGIN, runtime: fakeRuntime(), ...options }));
  }

  let closeCalls = 0;
  const runtime = fakeRuntime();
  runtime.close = async () => { closeCalls += 1; };
  const bridge = await startLocalAgentBridge({ appUrl: APP_ORIGIN, runtime });
  await Promise.all([bridge.close(), bridge.close(), bridge.close()]);
  assert.equal(closeCalls, 1);
});
