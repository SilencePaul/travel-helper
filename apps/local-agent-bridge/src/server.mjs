import { createServer } from "node:http";

import { safeResearchStatus } from "./travel-research-service.mjs";

const PREPARE_PATH = "/v1/agent-runs/prepare";
const CLAIM_PATH = "/v1/agent-runs/claim";
const EXECUTE_PATH = "/v1/agent-runs/execute-travel-research";
const STATUS_PATH = "/v1/agent-runs/research-status";
const RESUME_PATH = "/v1/agent-runs/resume-travel-research";
const CANCEL_PATH = "/v1/agent-runs/cancel-research";
const CATEGORIES = new Set(["hotel", "restaurant", "attraction"]);
const RESUME_ACTIONS = new Set(["retry_codex_auth", "skip_blocked_source"]);
const BUSINESS_ERRORS = new Set([
  "CODEX_NOT_AVAILABLE",
  "CODEX_NOT_AUTHENTICATED",
  "CODEX_ISOLATION_UNAVAILABLE",
  "CODEX_USAGE_UNAVAILABLE",
  "CODEX_RESEARCH_TIMEOUT",
  "CODEX_OUTPUT_INVALID",
  "CODEX_INSUFFICIENT_EVIDENCE",
  "INVALID_RESEARCH_TARGET",
  "DISCLOSURE_CONTEXT_CHANGED",
  "CODEX_RESEARCH_CANCELLED",
  "AGENT_RUN_INACTIVE",
  "AGENT_TRANSPORT_UNAVAILABLE",
  "CODEX_RESEARCH_FAILED",
]);

function codedError(code) {
  return Object.assign(new Error(code), { code });
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys) {
  return plainObject(value)
    && Reflect.ownKeys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function opaqueIdentifier(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 1_024;
}

function validAppUrl(value, allowInsecureLoopbackApp = false) {
  try {
    const url = new URL(value);
    const allowedProtocol = url.protocol === "https:"
      || (allowInsecureLoopbackApp && url.protocol === "http:" && url.hostname === "127.0.0.1");
    if (!allowedProtocol || url.username || url.password || url.origin === "null" || url.hostname.includes("*") || url.hash) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function json(response, status, body, headers = {}) {
  const value = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(value),
    "cache-control": "no-store",
    ...headers,
  });
  response.end(value);
}

function readBody(request, maxBodyBytes, bodyTimeoutMs) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      request.resume();
      reject(error);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        fail(codedError("REQUEST_TOO_LARGE"));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onError = () => fail(codedError("INVALID_REQUEST"));
    const timeout = setTimeout(() => fail(codedError("REQUEST_TIMEOUT")), bodyTimeoutMs);
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
  });
}

function validPrepare(value) {
  return exactKeys(value, []);
}

function validClaim(value) {
  return exactKeys(value, ["agentRunId"]) && opaqueIdentifier(value.agentRunId);
}

function validExecute(value) {
  return exactKeys(value, ["agentRunId", "targetCategory", "targetScopeId", "disclosureFingerprint"])
    && opaqueIdentifier(value.agentRunId)
    && CATEGORIES.has(value.targetCategory)
    && typeof value.targetScopeId === "string"
    && /^scope_[a-f0-9]{64}$/u.test(value.targetScopeId)
    && typeof value.disclosureFingerprint === "string"
    && /^[a-f0-9]{64}$/u.test(value.disclosureFingerprint);
}

function validResume(value) {
  return exactKeys(value, ["agentRunId", "researchTaskId", "resumeAction"])
    && opaqueIdentifier(value.agentRunId)
    && opaqueIdentifier(value.researchTaskId)
    && RESUME_ACTIONS.has(value.resumeAction);
}

function validCancel(value) {
  return exactKeys(value, ["researchTaskId"]) && opaqueIdentifier(value.researchTaskId);
}

function projectPrepared(value) {
  const key = value?.publicKeyJwk;
  if (!plainObject(value) || !plainObject(key)
    || key.kty !== "EC" || key.crv !== "P-256"
    || typeof key.x !== "string" || key.x.length === 0
    || typeof key.y !== "string" || key.y.length === 0
    || typeof value.pairingCodeHash !== "string" || value.pairingCodeHash.length !== 43
    || typeof value.pairingCodeFingerprint !== "string"
    || value.pairingCodeFingerprint.length === 0 || value.pairingCodeFingerprint.length > 128) {
    throw codedError("CODEX_RESEARCH_FAILED");
  }
  return {
    publicKeyJwk: { kty: "EC", crv: "P-256", x: key.x, y: key.y },
    pairingCodeHash: value.pairingCodeHash,
    pairingCodeFingerprint: value.pairingCodeFingerprint,
  };
}

function projectClaimed(value, requestBody) {
  if (!plainObject(value) || value.agentRunId !== requestBody.agentRunId || value.status !== "claimed") {
    throw codedError("CODEX_RESEARCH_FAILED");
  }
  return { agentRunId: value.agentRunId, status: "claimed" };
}

const ROUTES = new Map([
  [PREPARE_PATH, {
    method: "POST",
    validate: validPrepare,
    invoke: (runtime) => runtime.prepare(),
    project: projectPrepared,
    prepared: true,
  }],
  [CLAIM_PATH, {
    method: "POST",
    validate: validClaim,
    invoke: (runtime, body) => runtime.claim(body.agentRunId),
    project: projectClaimed,
  }],
  [EXECUTE_PATH, {
    method: "POST",
    validate: validExecute,
    invoke: (runtime, body) => runtime.executeTravelResearch(body),
    project: safeResearchStatus,
  }],
  [STATUS_PATH, {
    method: "GET",
    invoke: (runtime) => runtime.getResearchStatus(),
    project: safeResearchStatus,
  }],
  [RESUME_PATH, {
    method: "POST",
    validate: validResume,
    invoke: (runtime, body) => runtime.resumeTravelResearch(body),
    project: safeResearchStatus,
  }],
  [CANCEL_PATH, {
    method: "POST",
    validate: validCancel,
    invoke: (runtime, body) => runtime.cancelResearch(body),
    project: safeResearchStatus,
  }],
]);

function parseRequestTarget(value) {
  if (typeof value !== "string" || !value.startsWith("/")) return undefined;
  try {
    const parsed = new URL(value, "http://127.0.0.1");
    if (parsed.origin !== "http://127.0.0.1" || parsed.hash) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function requestError(error) {
  if (error?.code === "REQUEST_TOO_LARGE") return { status: 413, code: "INVALID_REQUEST" };
  if (error?.code === "REQUEST_TIMEOUT") return { status: 408, code: "INVALID_REQUEST" };
  if (error?.code === "INVALID_REQUEST") return { status: 400, code: "INVALID_REQUEST" };
  if (BUSINESS_ERRORS.has(error?.code)) return { status: 409, code: error.code };
  return { status: 500, code: "CODEX_RESEARCH_FAILED" };
}

export function buildConnectionUrl(appUrl, bridgeOrigin, { allowInsecureLoopbackApp = false } = {}) {
  const url = validAppUrl(appUrl, allowInsecureLoopbackApp);
  if (!url) throw codedError("INVALID_APP_URL");
  const bridge = new URL(bridgeOrigin);
  if (bridge.protocol !== "http:" || bridge.hostname !== "127.0.0.1" || !bridge.port || bridge.pathname !== "/" || bridge.search || bridge.hash) {
    throw codedError("INVALID_BRIDGE_URL");
  }
  url.hash = new URLSearchParams({ agentBridge: bridge.origin }).toString();
  return url.toString();
}

export async function startLocalAgentBridge({
  appUrl,
  runtime,
  host = "127.0.0.1",
  port = 0,
  maxBodyBytes = 16 * 1024,
  bodyTimeoutMs = 5_000,
  allowInsecureLoopbackApp = false,
  onPrepared,
  onClose,
} = {}) {
  const app = validAppUrl(appUrl, allowInsecureLoopbackApp);
  if (!app) throw codedError("INVALID_APP_URL");
  if (host !== "127.0.0.1") throw codedError("INVALID_BIND_ADDRESS");
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw codedError("INVALID_PORT");
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) throw codedError("INVALID_MAX_BODY_BYTES");
  if (!Number.isSafeInteger(bodyTimeoutMs) || bodyTimeoutMs <= 0) throw codedError("INVALID_BODY_TIMEOUT");
  const requiredMethods = [
    "prepare", "claim", "executeTravelResearch", "getResearchStatus", "resumeTravelResearch", "cancelResearch",
  ];
  if (!runtime || requiredMethods.some((method) => typeof runtime[method] !== "function")) throw codedError("INVALID_RUNTIME");
  if (onPrepared !== undefined && typeof onPrepared !== "function") throw codedError("INVALID_PREPARE_CALLBACK");
  if (onClose !== undefined && typeof onClose !== "function") throw codedError("INVALID_CLOSE_CALLBACK");
  if (runtime.close !== undefined && typeof runtime.close !== "function") throw codedError("INVALID_RUNTIME");

  let actualPort;
  const server = createServer(async (request, response) => {
    const corsHeaders = {
      "access-control-allow-origin": app.origin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      vary: "Origin",
    };
    const expectedHost = `127.0.0.1:${actualPort}`;
    const originAllowed = request.headers.origin === app.origin;
    const hostAllowed = request.headers.host === expectedHost;
    const target = parseRequestTarget(request.url);
    const route = target && ROUTES.get(target.pathname);
    if (!originAllowed || !hostAllowed || !route) {
      json(response, 403, { ok: false, error: "INVALID_REQUEST" });
      return;
    }
    if (target.search || request.url !== target.pathname) {
      json(response, 400, { ok: false, error: "INVALID_REQUEST" }, corsHeaders);
      return;
    }
    if (request.method === "OPTIONS") {
      const preflightLength = request.headers["content-length"];
      if (request.headers["access-control-request-method"] !== route.method
        || request.headers["transfer-encoding"] !== undefined
        || (preflightLength !== undefined && preflightLength !== "0")) {
        request.resume();
        json(response, 400, { ok: false, error: "INVALID_REQUEST" }, corsHeaders);
        return;
      }
      const privateNetwork = request.headers["access-control-request-private-network"] === "true"
        ? { "access-control-allow-private-network": "true" }
        : {};
      response.writeHead(204, { ...corsHeaders, ...privateNetwork, "cache-control": "no-store" });
      response.end();
      return;
    }
    if (request.method !== route.method) {
      request.resume();
      json(response, 405, { ok: false, error: "INVALID_REQUEST" }, corsHeaders);
      return;
    }
    if (request.headers.cookie !== undefined || request.headers.authorization !== undefined) {
      request.resume();
      json(response, 400, { ok: false, error: "INVALID_REQUEST" }, corsHeaders);
      return;
    }
    if (route.method === "POST"
      && !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(String(request.headers["content-type"] || ""))) {
      request.resume();
      json(response, 400, { ok: false, error: "INVALID_REQUEST" }, corsHeaders);
      return;
    }
    const declaredHeader = request.headers["content-length"];
    const declaredLength = declaredHeader === undefined ? undefined : Number(declaredHeader);
    if (declaredLength !== undefined && (!Number.isSafeInteger(declaredLength) || declaredLength < 0)) {
      request.resume();
      json(response, 400, { ok: false, error: "INVALID_REQUEST" }, corsHeaders);
      return;
    }
    if (declaredLength !== undefined && declaredLength > maxBodyBytes) {
      request.resume();
      json(response, 413, { ok: false, error: "INVALID_REQUEST" }, corsHeaders);
      return;
    }
    if (route.method === "GET" && declaredLength !== undefined && declaredLength > 0) {
      request.resume();
      json(response, 400, { ok: false, error: "INVALID_REQUEST" }, corsHeaders);
      return;
    }
    try {
      const source = await readBody(request, maxBodyBytes, bodyTimeoutMs);
      let body;
      if (route.method === "GET") {
        if (source.length !== 0) throw codedError("INVALID_REQUEST");
      } else {
        try {
          body = JSON.parse(source);
        } catch {
          throw codedError("INVALID_REQUEST");
        }
        if (!route.validate(body)) throw codedError("INVALID_REQUEST");
      }
      const rawData = await route.invoke(runtime, body);
      const data = route.project(rawData, body);
      if (route.prepared) await onPrepared?.(data);
      json(response, 200, { ok: true, data }, corsHeaders);
    } catch (error) {
      const failure = requestError(error);
      json(response, failure.status, { ok: false, error: failure.code }, corsHeaders);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  actualPort = typeof address === "object" && address ? address.port : undefined;
  if (!actualPort) {
    server.close();
    throw codedError("BRIDGE_START_FAILED");
  }
  const origin = `http://127.0.0.1:${actualPort}`;
  let closePromise;
  return {
    port: actualPort,
    origin,
    connectionUrl: buildConnectionUrl(app.toString(), origin, { allowInsecureLoopbackApp }),
    close: () => {
      if (closePromise) return closePromise;
      const serverClose = server.listening
        ? new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
        : Promise.resolve();
      const cleanup = Promise.resolve()
        .then(() => runtime.close?.())
        .then(() => onClose?.());
      closePromise = Promise.all([serverClose, cleanup]).then(() => undefined);
      return closePromise;
    },
  };
}
