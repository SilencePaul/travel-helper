import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateProductionConfig } from "./check-production-config.mjs";

const scriptPath = fileURLToPath(new URL("./check-production-config.mjs", import.meta.url));
const requiredNames = [
  "VITE_CLOUDBASE_ENV_ID",
  "VITE_AUTH_SERVICE_URL",
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "FEISHU_REDIRECT_URI",
  "ADMIN_BOOTSTRAP_CODE",
  "AUTH_SESSION_SECRET",
  "CLOUDBASE_CUSTOM_LOGIN_CREDENTIALS_BASE64",
  "PUBLIC_APP_URL",
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

assert.deepEqual(
  validateProductionConfig({
    VITE_CLOUDBASE_ENV_ID: "env",
    VITE_AUTH_SERVICE_URL: "https://auth.example.com",
    FEISHU_APP_ID: "cli",
    FEISHU_APP_SECRET: "secret",
    FEISHU_REDIRECT_URI: "https://auth.example.com/callback",
    ADMIN_BOOTSTRAP_CODE: "code",
    AUTH_SESSION_SECRET: "session",
    CLOUDBASE_CUSTOM_LOGIN_CREDENTIALS_BASE64: "e30=",
    PUBLIC_APP_URL: "https://trip.example",
  }),
  { ok: true, missing: [] },
);
assert.deepEqual(validateProductionConfig({}), {
  ok: false,
  missing: requiredNames,
});

const missing = run({});
assert.equal(missing.status, 1);
assert.equal(missing.output, `MISSING ${requiredNames.join(" ")}\n`);

const configured = run(Object.fromEntries(requiredNames.map((name) => [name, "not-a-real-secret"])));
assert.equal(configured.status, 0);
assert.equal(configured.output, "PASS\n");
assert.equal(configured.output.includes("not-a-real-secret"), false);

console.log("production config checker tests passed");
