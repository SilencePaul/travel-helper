const assert = require("node:assert/strict");
const test = require("node:test");

const { createAuthHandler } = require("./index.js");
const { createMemoryAuthStore } = require("./lib/authStore.js");

function responseBody(response) {
  return JSON.parse(response.body);
}

function makeRequest(handler, method, path, body, headers = {}) {
  return handler({
    httpMethod: method,
    path,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("OAuth callback redirects the browser to the app auth route without issuing a custom ticket", async () => {
  const requests = [];
  const handler = createAuthHandler({
    env: {
      FEISHU_APP_ID: "cli_test",
      FEISHU_APP_SECRET: "secret",
      FEISHU_REDIRECT_URI: "https://auth.example/callback",
      PUBLIC_APP_URL: "https://trip.example",
      ADMIN_BOOTSTRAP_CODE: "correct",
      AUTH_SESSION_SECRET: "session-secret",
      VITE_CLOUDBASE_ENV_ID: "env",
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (String(url).includes("tenant_access_token")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant" }), { status: 200 });
      }
      if (String(url).includes("access_token")) {
        return new Response(JSON.stringify({ code: 0, data: { access_token: "user-token" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 0, data: { open_id: "ou_pending", name: "美垚" } }), { status: 200 });
    },
  });

  const start = await makeRequest(handler, "GET", "/api/auth/start");
  assert.equal(start.statusCode, 302);
  const startUrl = new URL(start.headers.location);
  const state = startUrl.searchParams.get("state");
  const callback = await makeRequest(handler, "GET", `/api/auth/callback?code=feishu-code&state=${state}`, undefined, {
    cookie: start.headers["set-cookie"].split(";")[0],
  });

  assert.equal(callback.statusCode, 302);
  const callbackUrl = new URL(callback.headers.location);
  assert.equal(callbackUrl.origin, "https://trip.example");
  assert.equal(callbackUrl.pathname, "/auth/callback");
  assert.equal(callbackUrl.searchParams.get("status"), "bootstrap");
  assert.equal(callbackUrl.searchParams.get("state"), state);
  assert.equal(callback.headers["set-cookie"].startsWith("auth_session="), true);
  assert.equal(requests.length, 3);
  const ticket = await makeRequest(handler, "POST", "/api/auth/ticket", undefined, {
    cookie: callback.headers["set-cookie"].split(";")[0],
  });
  assert.equal(ticket.statusCode, 403);
  assert.deepEqual(responseBody(ticket), { error: "PENDING_APPROVAL" });
});

test("bootstrap code is consumed once and creates exactly one administrator", async () => {
  const issuedTickets = [];
  const handler = createAuthHandler({
    env: {
      FEISHU_APP_ID: "cli_test",
      FEISHU_APP_SECRET: "secret",
      FEISHU_REDIRECT_URI: "https://auth.example/callback",
      PUBLIC_APP_URL: "https://trip.example",
      ADMIN_BOOTSTRAP_CODE: "correct",
      AUTH_SESSION_SECRET: "session-secret",
      VITE_CLOUDBASE_ENV_ID: "env",
    },
    fetchImpl: async (url) => {
      if (String(url).includes("tenant_access_token")) return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant" }));
      if (String(url).includes("access_token")) return new Response(JSON.stringify({ code: 0, data: { access_token: "user-token" } }));
      return new Response(JSON.stringify({ code: 0, data: { open_id: "ou_admin", name: "一鸣" } }));
    },
    createTicket: (uid) => { issuedTickets.push(uid); return "custom-ticket"; },
  });

  const start = await makeRequest(handler, "GET", "/api/auth/start");
  const state = new URL(start.headers.location).searchParams.get("state");
  const stateCookie = start.headers["set-cookie"].split(";")[0];
  const callback = await makeRequest(handler, "GET", `/api/auth/callback?code=code&state=${state}`, undefined, { cookie: stateCookie });
  const authCookie = callback.headers["set-cookie"].split(";")[0];

  const first = await makeRequest(handler, "POST", "/api/auth/bootstrap", { code: "correct", oauthState: state }, { cookie: authCookie });
  assert.equal(first.statusCode, 200);
  assert.equal(responseBody(first).role, "admin");
  const ticket = await makeRequest(handler, "POST", "/api/auth/ticket", undefined, { cookie: authCookie });
  assert.equal(ticket.statusCode, 200);
  assert.deepEqual(responseBody(ticket), { ticket: "custom-ticket" });
  assert.equal(issuedTickets.length, 1);
  const second = await makeRequest(handler, "POST", "/api/auth/bootstrap", { code: "correct", oauthState: state }, { cookie: authCookie });
  assert.equal(second.statusCode, 409);
});

test("OAuth state is single-use and expires after ten minutes", async () => {
  let now = 1_000;
  const handler = createAuthHandler({
    now: () => now,
    randomBytes: () => Buffer.alloc(32, 7),
    env: { FEISHU_APP_ID: "cli", FEISHU_APP_SECRET: "secret", FEISHU_REDIRECT_URI: "https://auth/callback", PUBLIC_APP_URL: "https://trip", ADMIN_BOOTSTRAP_CODE: "code", AUTH_SESSION_SECRET: "secret", VITE_CLOUDBASE_ENV_ID: "env" },
    fetchImpl: async (url) => String(url).includes("tenant_access_token")
      ? new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant" }))
      : String(url).includes("access_token")
        ? new Response(JSON.stringify({ code: 0, data: { access_token: "user-token" } }))
        : new Response(JSON.stringify({ code: 0, data: { open_id: "ou", name: "user" } })),
  });
  const start = await makeRequest(handler, "GET", "/api/auth/start");
  const state = new URL(start.headers.location).searchParams.get("state");
  const cookie = start.headers["set-cookie"].split(";")[0];
  const first = await makeRequest(handler, "GET", "/api/auth/callback?code=x&state=" + state, undefined, { cookie });
  assert.equal(first.statusCode, 302);
  const replay = await makeRequest(handler, "GET", `/api/auth/callback?code=x&state=${state}`, undefined, { cookie });
  assert.equal(replay.statusCode, 400);

  const secondStart = await makeRequest(handler, "GET", "/api/auth/start");
  const secondState = new URL(secondStart.headers.location).searchParams.get("state");
  now += 10 * 60 * 1000 + 1;
  const expired = await makeRequest(handler, "GET", `/api/auth/callback?code=x&state=${secondState}`, undefined, { cookie: secondStart.headers["set-cookie"].split(";")[0] });
  assert.equal(expired.statusCode, 400);
});

test("state and session records are shared across service instances and expire", async () => {
  let now = 1_000;
  const authStore = createMemoryAuthStore({ now: () => now, randomBytes: () => Buffer.alloc(32, 9) });
  const memberStore = require("./lib/members").createMemoryMemberStore({ bootstrapCode: "code" });
  const env = { FEISHU_APP_ID: "cli", FEISHU_APP_SECRET: "secret", FEISHU_REDIRECT_URI: "https://auth/callback", PUBLIC_APP_URL: "https://trip", ADMIN_BOOTSTRAP_CODE: "code", AUTH_SESSION_SECRET: "secret", VITE_CLOUDBASE_ENV_ID: "env" };
  const fetchImpl = async (url) => String(url).includes("tenant_access_token")
    ? new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant" }))
    : String(url).includes("access_token")
      ? new Response(JSON.stringify({ code: 0, data: { access_token: "user-token" } }))
      : new Response(JSON.stringify({ code: 0, data: { open_id: "ou-shared", name: "shared" } }));
  const firstInstance = createAuthHandler({ env, fetchImpl, authStore, memberStore });
  const secondInstance = createAuthHandler({ env, fetchImpl, authStore, memberStore });
  const start = await makeRequest(firstInstance, "GET", "/api/auth/start");
  const state = new URL(start.headers.location).searchParams.get("state");
  const stateCookie = start.headers["set-cookie"].split(";")[0];
  const callback = await makeRequest(secondInstance, "GET", "/api/auth/callback?code=x&state=" + state, undefined, { cookie: stateCookie });
  assert.equal(callback.statusCode, 302);
  const sessionCookie = callback.headers["set-cookie"].split(";")[0];
  assert.match(sessionCookie, /^auth_session=[A-Za-z0-9_-]+$/);
  const ticket = await makeRequest(firstInstance, "POST", "/api/auth/ticket", undefined, { cookie: sessionCookie });
  assert.equal(ticket.statusCode, 403);
  const replay = await makeRequest(firstInstance, "GET", "/api/auth/callback?code=x&state=" + state, undefined, { cookie: stateCookie });
  assert.equal(replay.statusCode, 400);
  now += 24 * 60 * 60 * 1000 + 1;
  const expired = await makeRequest(secondInstance, "POST", "/api/auth/ticket", undefined, { cookie: sessionCookie });
  assert.equal(expired.statusCode, 401);
});

test("CloudBase mode fails closed when CloudBase initialization is unavailable", () => {
  assert.throws(() => createAuthHandler({
    env: {
      VITE_DATA_MODE: "cloudbase",
      VITE_CLOUDBASE_ENV_ID: "travel-prod",
      TENCENTCLOUD_SECRET_ID: "secret-id",
      FEISHU_APP_ID: "cli",
      FEISHU_APP_SECRET: "secret",
      FEISHU_REDIRECT_URI: "https://auth/callback",
      PUBLIC_APP_URL: "https://trip",
      ADMIN_BOOTSTRAP_CODE: "code",
      AUTH_SESSION_SECRET: "secret",
    },
    fetchImpl: async () => new Response("{}"),
  }), (error) => error && error.code === "AUTH_SERVICE_UNAVAILABLE");
});

test("a callback without a code does not consume a valid OAuth state", async () => {
  const handler = createAuthHandler({
    env: { FEISHU_APP_ID: "cli", FEISHU_APP_SECRET: "secret", FEISHU_REDIRECT_URI: "https://auth/callback", PUBLIC_APP_URL: "https://trip", ADMIN_BOOTSTRAP_CODE: "code", AUTH_SESSION_SECRET: "secret", VITE_CLOUDBASE_ENV_ID: "env" },
    fetchImpl: async (url) => String(url).includes("tenant_access_token")
      ? new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant" }))
      : String(url).includes("access_token")
        ? new Response(JSON.stringify({ code: 0, data: { access_token: "user-token" } }))
        : new Response(JSON.stringify({ code: 0, data: { open_id: "ou-valid", name: "valid" } })),
  });
  const start = await makeRequest(handler, "GET", "/api/auth/start");
  const state = new URL(start.headers.location).searchParams.get("state");
  const cookie = start.headers["set-cookie"].split(";")[0];
  const malformed = await makeRequest(handler, "GET", "/api/auth/callback?state=" + state, undefined, { cookie });
  assert.equal(malformed.statusCode, 400);
  const valid = await makeRequest(handler, "GET", "/api/auth/callback?code=valid&state=" + state, undefined, { cookie });
  assert.equal(valid.statusCode, 302);
});

test("CloudBase member store refuses a database without transactions", () => {
  const { createCloudBaseMemberStore } = require("./lib/members");
  assert.throws(() => createCloudBaseMemberStore({ db: { collection: () => ({ doc: () => ({}) }) } }), (error) => error && error.code === "CLOUDBASE_TRANSACTION_UNAVAILABLE");
});
