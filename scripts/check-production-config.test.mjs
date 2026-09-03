import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateProductionConfig } from "./check-production-config.mjs";

const scriptPath = fileURLToPath(new URL("./check-production-config.mjs", import.meta.url));
const requiredNames = [
  "VITE_DATA_MODE",
  "VITE_CLOUDBASE_ENV_ID",
  "VITE_AUTH_SERVICE_URL",
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "FEISHU_REDIRECT_URI",
  "ADMIN_BOOTSTRAP_CODE",
  "CLOUDBASE_CUSTOM_LOGIN_CREDENTIALS_BASE64",
  "TENCENTCLOUD_SECRET_ID",
  "TENCENTCLOUD_SECRET_KEY",
  "PUBLIC_APP_URL",
  "AGENT_API_URL",
];

function run(environment) {
  try {
    return {
      status: 0,
      output: execFileSync(process.execPath, [scriptPath], {
        env: { PATH: process.env.PATH, ...environment },
        encoding: "utf8",
      }),
    };
  } catch (error) {
    return {
      status: error.status,
      output: error.stdout,
    };
  }
}

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const credential = Buffer.from(JSON.stringify({ env_id: "env", private_key_id: "key-id", private_key: privateKeyPem })).toString("base64");
const validEnvironment = {
    VITE_DATA_MODE: "cloudbase",
    VITE_CLOUDBASE_ENV_ID: "env",
    VITE_AUTH_SERVICE_URL: "https://auth.example.com",
    FEISHU_APP_ID: "cli",
    FEISHU_APP_SECRET: "secret",
    FEISHU_REDIRECT_URI: "https://auth.example.com/api/auth/callback",
    ADMIN_BOOTSTRAP_CODE: "code",
    CLOUDBASE_CUSTOM_LOGIN_CREDENTIALS_BASE64: credential,
    TENCENTCLOUD_SECRET_ID: "secret-id",
    TENCENTCLOUD_SECRET_KEY: "secret-key",
    PUBLIC_APP_URL: "https://trip.example",
    AGENT_API_URL: "https://api.example.com/api/agent",
  };
assert.deepEqual(
  validateProductionConfig(validEnvironment),
  { ok: true, missing: [], invalid: [] },
);
assert.deepEqual(validateProductionConfig({}), {
  ok: false,
  missing: requiredNames,
  invalid: [],
});
assert.deepEqual(
  validateProductionConfig({
    ...validEnvironment,
    CLOUDBASE_CUSTOM_LOGIN_CREDENTIALS_BASE64: Buffer.from(JSON.stringify({ env_id: "another-env", private_key_id: "key-id", private_key: privateKeyPem })).toString("base64"),
  }),
  { ok: false, missing: [], invalid: ["CLOUDBASE_CUSTOM_LOGIN_CREDENTIALS_BASE64"] },
);
assert.deepEqual(
  validateProductionConfig({
    ...validEnvironment,
    CLOUDBASE_CUSTOM_LOGIN_CREDENTIALS_BASE64: Buffer.from(JSON.stringify({ env_id: "env", private_key_id: "key-id", private_key: "not-a-private-key" })).toString("base64"),
  }),
  { ok: false, missing: [], invalid: ["CLOUDBASE_CUSTOM_LOGIN_CREDENTIALS_BASE64"] },
);
assert.deepEqual(
  validateProductionConfig({ ...validEnvironment, VITE_DATA_MODE: "local" }),
  { ok: false, missing: [], invalid: ["VITE_DATA_MODE"] },
);
assert.deepEqual(
  validateProductionConfig({ ...validEnvironment, PUBLIC_APP_URL: "https://trip.example/path" }),
  { ok: false, missing: [], invalid: ["PUBLIC_APP_URL"] },
);
assert.deepEqual(
  validateProductionConfig({ ...validEnvironment, VITE_AUTH_SERVICE_URL: "http://auth.example.com" }),
  { ok: false, missing: [], invalid: ["VITE_AUTH_SERVICE_URL", "FEISHU_REDIRECT_URI"] },
);
assert.deepEqual(
  validateProductionConfig({ ...validEnvironment, FEISHU_REDIRECT_URI: "https://auth.example.com/wrong-callback" }),
  { ok: false, missing: [], invalid: ["FEISHU_REDIRECT_URI"] },
);
assert.deepEqual(
  validateProductionConfig({ ...validEnvironment, AGENT_API_URL: "http://api.example.com/api/agent" }),
  { ok: false, missing: [], invalid: ["AGENT_API_URL"] },
);
assert.deepEqual(
  validateProductionConfig({ ...validEnvironment, AGENT_API_URL: "https://api.example.com/api/member" }),
  { ok: false, missing: [], invalid: ["AGENT_API_URL"] },
);

const missing = run({});
assert.equal(missing.status, 1);
assert.equal(missing.output, `MISSING ${requiredNames.join(" ")}\n`);

const configured = run(validEnvironment);
assert.equal(configured.status, 0);
assert.equal(configured.output, "PASS\n");
assert.equal(configured.output.includes("not-a-real-secret"), false);

const cloudbaseConfig = JSON.parse(readFileSync(new URL("../cloudbaserc.json", import.meta.url), "utf8"));
const functionByName = Object.fromEntries(cloudbaseConfig.functions.map((item) => [item.name, item]));
assert.ok(functionByName["auth-service"].timeout >= 20, "auth-service must allow enough time for the three-step Feishu callback");
assert.ok(functionByName["trip-api"].timeout >= 10, "trip-api must allow enough time for transactional saves");
assert.equal("aclRule" in functionByName["auth-service"], false, "CloudBase CLI v2 gateway routes replace deprecated function ACL rules");
assert.equal("aclRule" in functionByName["trip-api"], false, "CloudBase CLI v2 gateway routes replace deprecated function ACL rules");
assert.equal(functionByName["trip-api"].handler, "index.main");
assert.equal(functionByName["agent-api"].dir, "functions/trip-api");
assert.equal(functionByName["agent-api"].handler, "index.agentMain");
assert.equal("aclRule" in functionByName["agent-api"], false, "CloudBase CLI v2 gateway routes replace deprecated function ACL rules");
const routeByPath = Object.fromEntries(cloudbaseConfig.gateway.routes.map((route) => [route.path, route]));
assert.deepEqual(routeByPath["/api/auth"].qpsPolicy, { qpsTotal: 100, qpsPerClient: { limitBy: "ClientIP", limitValue: 3 } });
assert.equal(routeByPath["/api/agent"].target, "function:agent-api");
assert.equal(routeByPath["/api/agent"].enableAuth, false);
assert.deepEqual(routeByPath["/api/agent"].qpsPolicy, { qpsTotal: 100, qpsPerClient: { limitBy: "ClientIP", limitValue: 4 } });
assert.equal(functionByName["auth-service"].envVariables.CLOUDBASE_SERVER_SECRET_ID, "{{env.TENCENTCLOUD_SECRET_ID}}");
assert.equal(functionByName["auth-service"].envVariables.CLOUDBASE_SERVER_SECRET_KEY, "{{env.TENCENTCLOUD_SECRET_KEY}}");
assert.equal(functionByName["trip-api"].envVariables.CLOUDBASE_SERVER_SECRET_ID, "{{env.TENCENTCLOUD_SECRET_ID}}");
assert.equal(functionByName["trip-api"].envVariables.CLOUDBASE_SERVER_SECRET_KEY, "{{env.TENCENTCLOUD_SECRET_KEY}}");
assert.equal(functionByName["agent-api"].envVariables.CLOUDBASE_SERVER_SECRET_ID, "{{env.TENCENTCLOUD_SECRET_ID}}");
assert.equal(functionByName["agent-api"].envVariables.CLOUDBASE_SERVER_SECRET_KEY, "{{env.TENCENTCLOUD_SECRET_KEY}}");

console.log("production config checker tests passed");
