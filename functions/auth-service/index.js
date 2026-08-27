const crypto = require("node:crypto");
const { createFeishuClient } = require("./lib/feishu");
const { createMemoryMemberStore, createCloudBaseMemberStore } = require("./lib/members");
const { createTicketService } = require("./lib/tickets");

const STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const b64 = (value) => Buffer.from(value).toString("base64url");
const safeEqual = (a, b) => { const left = Buffer.from(a); const right = Buffer.from(b); return left.length === right.length && crypto.timingSafeEqual(left, right); };

function createSessionManager({ secret, now = () => Date.now(), randomBytes = crypto.randomBytes } = {}) {
  const sessions = new Map();
  function issue({ uid, oauthState }) {
    const payload = { uid, oauthState, nonce: randomBytes(18).toString("base64url"), exp: now() + SESSION_TTL_MS };
    const encoded = b64(JSON.stringify(payload));
    const signature = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
    sessions.set(payload.nonce, payload);
    return encoded + "." + signature;
  }
  function verify(token) {
    if (typeof token !== "string") return undefined;
    const [encoded, signature] = token.split(".");
    if (!encoded || !signature || !safeEqual(signature, crypto.createHmac("sha256", secret).update(encoded).digest("base64url"))) return undefined;
    let payload;
    try { payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); } catch { return undefined; }
    const stored = payload && sessions.get(payload.nonce);
    return stored && stored.exp > now() && stored.uid === payload.uid ? stored : undefined;
  }
  function revoke(token) { const payload = verify(token); if (payload) sessions.delete(payload.nonce); }
  return { issue, verify, revoke };
}

function createStateManager({ now = () => Date.now(), randomBytes = crypto.randomBytes } = {}) {
  const states = new Map();
  return {
    issue() { const state = randomBytes(32).toString("base64url"); states.set(state, now() + STATE_TTL_MS); return state; },
    consume(state) { const expiry = states.get(state); states.delete(state); return Boolean(expiry && expiry > now()); },
  };
}
function header(headers = {}, name) { const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase()); return key ? headers[key] : undefined; }
function cookies(headers) {
  return String(header(headers, "cookie") || "").split(";").reduce((result, item) => { const i = item.indexOf("="); if (i > 0) result[item.slice(0, i).trim()] = decodeURIComponent(item.slice(i + 1).trim()); return result; }, {});
}
function setCookie(name, value, secure, maxAge = SESSION_TTL_MS / 1000) {
  return name + "=" + encodeURIComponent(value) + "; Path=/; HttpOnly; SameSite=" + (secure ? "None; Secure" : "Lax") + "; Max-Age=" + Math.floor(maxAge);
}
function json(statusCode, body, headers = {}) { return { statusCode, headers: { "content-type": "application/json; charset=utf-8", ...headers }, body: JSON.stringify(body) }; }
function pathOf(event) { return new URL(event.path || event.requestContext?.http?.path || event.requestContext?.path || "/", "http://auth.local"); }
function bodyOf(event) { if (!event.body) return {}; try { return typeof event.body === "string" ? JSON.parse(event.body) : event.body; } catch { return undefined; } }
function errorCode(error) { return error && typeof error.code === "string" ? error.code : "AUTH_REQUEST_FAILED"; }

function createAuthHandler({ env = process.env, fetchImpl, memberStore, cloudbase, now = () => Date.now(), randomBytes = crypto.randomBytes, createTicket } = {}) {
  let effectiveCloudbase = cloudbase;
  if (!effectiveCloudbase && env.CLOUDBASE_CUSTOM_LOGIN_CREDENTIALS && env.VITE_CLOUDBASE_ENV_ID) {
    try { effectiveCloudbase = require("@cloudbase/node-sdk").init({ env: env.VITE_CLOUDBASE_ENV_ID, credentials: JSON.parse(env.CLOUDBASE_CUSTOM_LOGIN_CREDENTIALS) }); } catch { effectiveCloudbase = undefined; }
  }
  const store = memberStore || (effectiveCloudbase ? createCloudBaseMemberStore({ db: effectiveCloudbase.database(), bootstrapCode: env.ADMIN_BOOTSTRAP_CODE }) : createMemoryMemberStore({ bootstrapCode: env.ADMIN_BOOTSTRAP_CODE }));
  const feishu = createFeishuClient({ env, fetchImpl });
  const sessions = createSessionManager({ secret: env.AUTH_SESSION_SECRET || "development-only-secret", now, randomBytes });
  const states = createStateManager({ now, randomBytes });
  const tickets = createTicketService({ cloudbase: effectiveCloudbase, memberStore: store, createTicket: createTicket || ((uid) => effectiveCloudbase?.auth().createTicket(uid)) });
  const secure = String(env.PUBLIC_APP_URL || "").startsWith("https://");
  const cors = { "access-control-allow-origin": env.PUBLIC_APP_URL || "*", "access-control-allow-credentials": "true", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type", vary: "Origin" };
  return async function handler(event = {}) {
    const url = pathOf(event); const method = String(event.httpMethod || event.method || "GET").toUpperCase(); const headers = { ...cors };
    if (method === "OPTIONS") return { statusCode: 204, headers, body: "" };
    try {
      if (url.pathname === "/api/auth/start" && method === "GET") {
        const state = states.issue(); const redirect = new URL("https://open.feishu.cn/open-apis/authen/v1/authorize");
        redirect.searchParams.set("app_id", env.FEISHU_APP_ID); redirect.searchParams.set("redirect_uri", env.FEISHU_REDIRECT_URI); redirect.searchParams.set("state", state);
        return { statusCode: 302, headers: { ...headers, location: redirect.toString(), "set-cookie": setCookie("oauth_state", state, secure, STATE_TTL_MS / 1000) }, body: "" };
      }
      if (url.pathname === "/api/auth/callback" && method === "GET") {
        const state = url.searchParams.get("state"); const stateCookie = cookies(event.headers).oauth_state;
        if (!state || !stateCookie || state !== stateCookie || !states.consume(state)) return json(400, { error: "INVALID_OAUTH_STATE" }, headers);
        const code = url.searchParams.get("code"); if (!code) return json(400, { error: "MISSING_OAUTH_CODE" }, headers);
        const identity = await feishu.resolveAuthorizationCode(code); const member = await store.upsertPending(identity);
        const session = sessions.issue({ uid: member.uid, oauthState: state });
        const status = member.role === "pending" ? ((await store.hasAdmin?.()) ? "pending" : "bootstrap") : "approved";
        const appUrl = new URL(env.PUBLIC_APP_URL);
        appUrl.pathname = "/auth/callback";
        appUrl.search = "";
        appUrl.searchParams.set("state", state);
        appUrl.searchParams.set("status", status);
        return { statusCode: 302, headers: { ...headers, location: appUrl.toString(), "set-cookie": setCookie("auth_session", session, secure) }, body: "" };
      }
      const sessionToken = cookies(event.headers).auth_session; const session = sessions.verify(sessionToken);
      if (url.pathname === "/api/auth/bootstrap" && method === "POST") {
        const body = bodyOf(event);
        if (!session || !body || body.oauthState !== session.oauthState || typeof body.code !== "string" || !body.code) return json(400, { error: "INVALID_BOOTSTRAP_REQUEST" }, headers);
        const member = await store.findByUid(session.uid);
        if (!member) return json(400, { error: "INVALID_BOOTSTRAP_REQUEST" }, headers);
        try {
          // openIdHash is intentionally not reversible; memory stores retain the provider identity internally.
          const admin = await store.consumeBootstrap({ uid: session.uid, member, code: body.code });
          return json(200, { role: admin.role }, headers);
        } catch (error) { const codeName = errorCode(error); return json(codeName === "BOOTSTRAP_ALREADY_CONSUMED" ? 409 : 403, { error: codeName }, headers); }
      }
      if (url.pathname === "/api/auth/ticket" && method === "POST") {
        if (!session) return json(401, { error: "AUTH_REQUIRED" }, headers);
        try { return json(200, { ticket: await tickets.issueForUid(session.uid) }, headers); } catch (error) { const codeName = errorCode(error); return json(codeName === "PENDING_APPROVAL" ? 403 : 401, { error: codeName }, headers); }
      }
      if (url.pathname === "/api/auth/logout" && method === "POST") {
        sessions.revoke(sessionToken);
        return json(200, { status: "logged_out" }, { ...headers, "set-cookie": "auth_session=; Path=/; HttpOnly; Max-Age=0" });
      }
      return json(404, { error: "NOT_FOUND" }, headers);
    } catch (error) { return json(errorCode(error) === "AUTH_PROVIDER_ERROR" ? 502 : 500, { error: errorCode(error) === "AUTH_PROVIDER_ERROR" ? "AUTH_PROVIDER_ERROR" : "AUTH_REQUEST_FAILED" }, headers); }
  };
}

exports.createAuthHandler = createAuthHandler;
exports.createSessionManager = createSessionManager;
exports.createStateManager = createStateManager;
exports.main = createAuthHandler();

if (require.main === module) {
  const http = require("node:http");
  const port = Number(process.env.PORT || 9000);

  http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const result = await exports.main({ path: request.url, httpMethod: request.method, headers: request.headers, body: chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined });
    response.writeHead(result.statusCode, result.headers);
    response.end(result.body);
  }).listen(port, "0.0.0.0");
}
