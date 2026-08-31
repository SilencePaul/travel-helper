import { createServer } from "node:http";

const PREPARE_PATH = "/v1/agent-runs/prepare";
const CLAIM_PATH = "/v1/agent-runs/claim";

function codedError(code) {
  return Object.assign(new Error(code), { code });
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
} = {}) {
  const app = validAppUrl(appUrl, allowInsecureLoopbackApp);
  if (!app) throw codedError("INVALID_APP_URL");
  if (host !== "127.0.0.1") throw codedError("INVALID_BIND_ADDRESS");
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw codedError("INVALID_PORT");
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) throw codedError("INVALID_MAX_BODY_BYTES");
  if (!Number.isSafeInteger(bodyTimeoutMs) || bodyTimeoutMs <= 0) throw codedError("INVALID_BODY_TIMEOUT");
  if (!runtime || typeof runtime.prepare !== "function" || typeof runtime.claim !== "function") throw codedError("INVALID_RUNTIME");
  if (onPrepared !== undefined && typeof onPrepared !== "function") throw codedError("INVALID_PREPARE_CALLBACK");

  let actualPort;
  const server = createServer(async (request, response) => {
    const corsHeaders = {
      "access-control-allow-origin": app.origin,
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      vary: "Origin",
    };
    const expectedHost = `127.0.0.1:${actualPort}`;
    const originAllowed = request.headers.origin === app.origin;
    const hostAllowed = request.headers.host === expectedHost;
    const pathAllowed = request.url === PREPARE_PATH || request.url === CLAIM_PATH;
    if (!originAllowed || !hostAllowed || !pathAllowed) {
      json(response, 403, { ok: false, error: "INVALID_REQUEST" });
      return;
    }
    if (request.method === "OPTIONS") {
      if (request.headers["access-control-request-method"] !== "POST") {
        json(response, 400, { ok: false, error: "INVALID_REQUEST" });
        return;
      }
      const privateNetwork = request.headers["access-control-request-private-network"] === "true"
        ? { "access-control-allow-private-network": "true" }
        : {};
      response.writeHead(204, { ...corsHeaders, ...privateNetwork, "cache-control": "no-store" });
      response.end();
      return;
    }
    if (request.method !== "POST" || !/^application\/json(?:\s*;|$)/i.test(String(request.headers["content-type"] || ""))) {
      json(response, 405, { ok: false, error: "INVALID_REQUEST" }, corsHeaders);
      return;
    }
    const declaredLength = Number(request.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
      request.resume();
      json(response, 413, { ok: false, error: "INVALID_REQUEST" }, corsHeaders);
      return;
    }
    try {
      const source = await readBody(request, maxBodyBytes, bodyTimeoutMs);
      const body = JSON.parse(source);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw codedError("INVALID_REQUEST");
      const data = request.url === PREPARE_PATH
        ? await runtime.prepare(body.scope)
        : await runtime.claim(body.agentRunId);
      if (request.url === PREPARE_PATH) await onPrepared?.(data);
      json(response, 200, { ok: true, data }, corsHeaders);
    } catch (error) {
      const status = error?.code === "REQUEST_TOO_LARGE" ? 413 : error?.code === "REQUEST_TIMEOUT" ? 408 : 400;
      json(response, status, { ok: false, error: "INVALID_REQUEST" }, corsHeaders);
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
      if (!server.listening) return Promise.resolve();
      closePromise = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      return closePromise;
    },
  };
}
