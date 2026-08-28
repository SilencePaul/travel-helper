const assert = require("node:assert/strict");
const test = require("node:test");

const { createAuthHandler, cloudbaseInitConfig } = require("./index.js");
const { createMemoryAuthStore } = require("./lib/authStore.js");

test("CloudBase initialization includes the custom login private credentials", () => {
  const credentials = { env_id: "env", private_key_id: "key-id", private_key: "private-key" };
  assert.deepEqual(cloudbaseInitConfig({
    VITE_CLOUDBASE_ENV_ID: "env",
    CLOUDBASE_SERVER_SECRET_ID: "secret-id",
    CLOUDBASE_SERVER_SECRET_KEY: "secret-key",
    CLOUDBASE_CUSTOM_LOGIN_CREDENTIALS: JSON.stringify(credentials),
  }), {
    env: "env",
    secretId: "secret-id",
    secretKey: "secret-key",
    credentials,
  });
});

test("CloudBase initialization accepts base64-encoded custom login credentials", () => {
  const credentials = { env_id: "env", private_key_id: "key-id", private_key: "private-key" };
  assert.deepEqual(cloudbaseInitConfig({
    VITE_CLOUDBASE_ENV_ID: "env",
    CLOUDBASE_SERVER_SECRET_ID: "secret-id",
    CLOUDBASE_SERVER_SECRET_KEY: "secret-key",
    CLOUDBASE_CUSTOM_LOGIN_CREDENTIALS_BASE64: Buffer.from(JSON.stringify(credentials)).toString("base64"),
  }).credentials, credentials);
});

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

test("OAuth callback redirects with a single-use ticket exchange code", async () => {
  const requests = [];
  let ticketAttempts = 0;
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
    createTicket: () => {
      ticketAttempts += 1;
      if (ticketAttempts === 1) throw new Error("temporary ticket failure");
      return "pending-ticket";
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
  assert.equal(callbackUrl.pathname, "/");
  assert.equal(callbackUrl.searchParams.get("auth_callback"), "1");
  assert.equal(callbackUrl.searchParams.get("status"), "bootstrap");
  assert.equal(callbackUrl.searchParams.get("state"), state);
  const exchangeCode = callbackUrl.searchParams.get("exchange_code");
  assert.equal(typeof exchangeCode, "string");
  const failedExchange = await makeRequest(handler, "POST", "/api/auth/exchange", { code: exchangeCode });
  assert.equal(failedExchange.statusCode, 503);
  assert.deepEqual(responseBody(failedExchange), { error: "AUTH_SERVICE_UNAVAILABLE" });
  const exchange = await makeRequest(handler, "POST", "/api/auth/exchange", { code: exchangeCode });
  assert.equal(exchange.statusCode, 200);
  assert.equal(responseBody(exchange).ticket, "pending-ticket");
  assert.equal(responseBody(exchange).member.role, "pending");
  const replayedExchange = await makeRequest(handler, "POST", "/api/auth/exchange", { code: exchangeCode });
  assert.equal(replayedExchange.statusCode, 400);
  assert.equal(callback.headers["set-cookie"].startsWith("auth_session="), true);
  assert.equal(requests.length, 3);
  const ticket = await makeRequest(handler, "POST", "/api/auth/ticket", undefined, {
    cookie: callback.headers["set-cookie"].split(";")[0],
  });
  assert.equal(ticket.statusCode, 403);
  assert.deepEqual(responseBody(ticket), { error: "PENDING_APPROVAL" });
});

test("an approved member callback does not create an unused server session", async () => {
  let createSessionCalls = 0;
  const member = {
    uid: "fs_existing_admin",
    displayName: "一鸣",
    role: "admin",
    version: 1,
    createdAt: "2026-08-27T00:00:00.000Z",
    approvedAt: "2026-08-27T00:00:00.000Z",
  };
  const handler = createAuthHandler({
    env: {
      FEISHU_APP_ID: "cli_test",
      FEISHU_APP_SECRET: "secret",
      FEISHU_REDIRECT_URI: "https://auth.example/callback",
      PUBLIC_APP_URL: "https://trip.example",
      VITE_CLOUDBASE_ENV_ID: "env",
    },
    memberStore: {
      upsertPending: async () => member,
      findByUid: async () => member,
    },
    authStore: {
      consumeState: async () => true,
      createSession: async () => { createSessionCalls += 1; return "unused-session"; },
      createExchange: async () => "exchange-code",
    },
    fetchImpl: async (url) => String(url).includes("tenant_access_token")
      ? new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant" }))
      : String(url).includes("access_token")
        ? new Response(JSON.stringify({ code: 0, data: { access_token: "user-token" } }))
        : new Response(JSON.stringify({ code: 0, data: { open_id: "ou_existing", name: "一鸣" } })),
  });

  const callback = await makeRequest(handler, "GET", "/api/auth/callback?code=code&state=state", undefined, { cookie: "oauth_state=state" });

  assert.equal(callback.statusCode, 302);
  assert.equal(new URL(callback.headers.location).searchParams.get("status"), "approved");
  assert.equal(callback.headers["set-cookie"], undefined);
  assert.equal(createSessionCalls, 0);
});

test("accepts paths after the CloudBase gateway strips its route prefix", async () => {
  const handler = createAuthHandler({
    env: { FEISHU_APP_ID: "cli", FEISHU_APP_SECRET: "secret", FEISHU_REDIRECT_URI: "https://auth/callback", PUBLIC_APP_URL: "https://trip", ADMIN_BOOTSTRAP_CODE: "code", AUTH_SESSION_SECRET: "secret", VITE_CLOUDBASE_ENV_ID: "env" },
    fetchImpl: async () => new Response("{}"),
  });

  assert.equal((await makeRequest(handler, "GET", "/start")).statusCode, 302);
});

test("reads OAuth callback parameters from the CloudBase gateway query object", async () => {
  const handler = createAuthHandler({
    env: { FEISHU_APP_ID: "cli", FEISHU_APP_SECRET: "secret", FEISHU_REDIRECT_URI: "https://auth/callback", PUBLIC_APP_URL: "https://trip", ADMIN_BOOTSTRAP_CODE: "code", AUTH_SESSION_SECRET: "secret", VITE_CLOUDBASE_ENV_ID: "env" },
    fetchImpl: async (url) => String(url).includes("tenant_access_token")
      ? new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant" }))
      : String(url).includes("access_token")
        ? new Response(JSON.stringify({ code: 0, data: { access_token: "user-token" } }))
        : new Response(JSON.stringify({ code: 0, data: { open_id: "ou-cloudbase", name: "cloudbase" } })),
  });
  const start = await makeRequest(handler, "GET", "/start");
  const state = new URL(start.headers.location).searchParams.get("state");
  const callback = await handler({
    httpMethod: "GET",
    path: "/callback",
    queryString: { code: "feishu-code", state },
    headers: { cookie: start.headers["set-cookie"].split(";")[0] },
  });

  assert.equal(callback.statusCode, 302);
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
      CLOUDBASE_SERVER_SECRET_ID: "secret-id",
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
