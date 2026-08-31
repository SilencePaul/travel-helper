import assert from "node:assert/strict";
import test from "node:test";

import * as isolation from "./codex-isolation.mjs";

const EXPECTED_OVERRIDES = [
  'permissions.travel_research.filesystem={":minimal"="read",":workspace_roots"="read"}',
  "permissions.travel_research.network.enabled=true",
  'default_permissions="travel_research"',
];

test("the isolation module exposes only its fixed public surface", () => {
  assert.deepEqual(Object.keys(isolation).sort(), [
    "CODEX_ISOLATION_ERROR",
    "buildPermissionOverrides",
    "discoverCodexExecutable",
    "minimalCodexEnvironment",
    "probeCodexIsolation",
  ]);
  assert.equal(isolation.CODEX_ISOLATION_ERROR, "CODEX_ISOLATION_UNAVAILABLE");
});

test("Codex discovery considers only controlled absolute executable candidates", () => {
  const checked = [];
  const result = isolation.discoverCodexExecutable({
    candidates: ["relative/codex", "/controlled/missing-codex", "/controlled/codex"],
    isExecutable(candidate) {
      checked.push(candidate);
      return candidate === "/controlled/codex";
    },
  });

  assert.equal(result, "/controlled/codex");
  assert.deepEqual(checked, ["/controlled/missing-codex", "/controlled/codex"]);
  assert.throws(
    () => isolation.discoverCodexExecutable({ candidates: ["codex"], isExecutable: () => true }),
    { code: "CODEX_NOT_AVAILABLE" },
  );
});

test("the permission profile is fixed to read-only workspace roots and HTTPS network access", () => {
  assert.deepEqual(isolation.buildPermissionOverrides(), EXPECTED_OVERRIDES);
  const first = isolation.buildPermissionOverrides();
  first.push("permissions.dangerous=true");
  assert.deepEqual(isolation.buildPermissionOverrides(), EXPECTED_OVERRIDES);
});

test("the child environment keeps only system launch, locale and proxy variables", () => {
  const filtered = isolation.minimalCodexEnvironment({
    PATH: "/usr/bin:/bin",
    HOME: "/Users/owner",
    CODEX_HOME: "/Users/owner/.codex",
    LANG: "zh_CN.UTF-8",
    LANGUAGE: "zh_CN:en",
    LC_ALL: "zh_CN.UTF-8",
    LC_CTYPE: "UTF-8",
    HTTP_PROXY: "http://proxy.example:8080",
    HTTPS_PROXY: "http://proxy.example:8080",
    NO_PROXY: "127.0.0.1,localhost",
    http_proxy: "http://legacy-proxy.example:8080",
    https_proxy: "http://legacy-proxy.example:8080",
    no_proxy: "::1",
    OPENAI_API_TOKEN: "token",
    PROJECT_SECRET: "secret",
    DATABASE_PASSWORD: "password",
    CLOUDBASE_SECRET_KEY: "cloudbase",
    TENCENTCLOUD_SECRETID: "tencent",
    AWS_ACCESS_KEY_ID: "aws",
    BRIDGE_PAIRING_CODE: "pairing",
    AGENT_SIGNATURE: "signature",
    NODE_OPTIONS: "--require ./project-hook.cjs",
    DOTENV_CONFIG_PATH: "/project/.env",
    npm_config_userconfig: "/project/.npmrc",
  });

  assert.deepEqual(filtered, {
    PATH: "/usr/bin:/bin",
    HOME: "/Users/owner",
    CODEX_HOME: "/Users/owner/.codex",
    LANG: "zh_CN.UTF-8",
    LANGUAGE: "zh_CN:en",
    LC_ALL: "zh_CN.UTF-8",
    LC_CTYPE: "UTF-8",
    HTTP_PROXY: "http://proxy.example:8080",
    HTTPS_PROXY: "http://proxy.example:8080",
    NO_PROXY: "127.0.0.1,localhost",
    http_proxy: "http://legacy-proxy.example:8080",
    https_proxy: "http://legacy-proxy.example:8080",
    no_proxy: "::1",
  });
});

test("the isolation probe requires affirmative evidence for every boundary", async () => {
  const calls = [];
  const report = {
    isolatedDirectoryReadable: true,
    outsideDirectoryUnreadable: true,
    projectDirectoryUnreadable: true,
    httpsNetworkAvailable: true,
    authenticationAvailable: true,
    persistenceAvailable: true,
  };

  const result = await isolation.probeCodexIsolation({
    isolatedDir: "/isolated",
    projectDir: "/project",
    runner: async (request) => {
      calls.push(request);
      return report;
    },
  });

  assert.deepEqual(result, report);
  assert.deepEqual(calls, [{
    isolatedDir: "/isolated",
    projectDir: "/project",
    permissionOverrides: EXPECTED_OVERRIDES,
    requiredChecks: Object.keys(report),
  }]);
});

test("the isolation probe fails closed without exposing raw probe details", async () => {
  const complete = {
    isolatedDirectoryReadable: true,
    outsideDirectoryUnreadable: true,
    projectDirectoryUnreadable: true,
    httpsNetworkAvailable: true,
    authenticationAvailable: true,
    persistenceAvailable: true,
  };

  for (const runner of [
    async () => ({ ...complete, projectDirectoryUnreadable: false }),
    async () => {
      const incomplete = { ...complete };
      delete incomplete.persistenceAvailable;
      return incomplete;
    },
    async () => ({ ...complete, httpsNetworkAvailable: "uncertain" }),
    async () => { throw new Error("raw token and /private/project/path"); },
  ]) {
    await assert.rejects(
      isolation.probeCodexIsolation({ isolatedDir: "/isolated", projectDir: "/project", runner }),
      (error) => {
        assert.equal(error.code, "CODEX_ISOLATION_UNAVAILABLE");
        assert.equal(error.message, "CODEX_ISOLATION_UNAVAILABLE");
        assert.equal(JSON.stringify(error).includes("raw token"), false);
        assert.equal(JSON.stringify(error).includes("/private/project/path"), false);
        return true;
      },
    );
  }
});

test("the isolation probe rejects missing, relative or project-overlapping boundaries", async () => {
  const complete = {
    isolatedDirectoryReadable: true,
    outsideDirectoryUnreadable: true,
    projectDirectoryUnreadable: true,
    httpsNetworkAvailable: true,
    authenticationAvailable: true,
    persistenceAvailable: true,
  };
  let runnerCalls = 0;
  const runner = async () => { runnerCalls += 1; return complete; };

  for (const boundaries of [
    { projectDir: "/project" },
    { isolatedDir: "relative", projectDir: "/project" },
    { isolatedDir: "/isolated", projectDir: "relative" },
    { isolatedDir: "/project", projectDir: "/project" },
    { isolatedDir: "/project/isolated", projectDir: "/project" },
  ]) {
    await assert.rejects(isolation.probeCodexIsolation({ ...boundaries, runner }), {
      code: "CODEX_ISOLATION_UNAVAILABLE",
    });
  }
  assert.equal(runnerCalls, 0);
});
