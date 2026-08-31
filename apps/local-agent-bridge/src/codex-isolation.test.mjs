import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as isolation from "./codex-isolation.mjs";

const EXPECTED_OVERRIDES = [
  'permissions.travel_research.filesystem={":minimal"="read",":workspace_roots"="read"}',
  "permissions.travel_research.network.enabled=true",
  'default_permissions="travel_research"',
];

const COMPLETE_REPORT = {
  isolatedDirectoryReadable: true,
  outsideDirectoryUnreadable: true,
  projectDirectoryUnreadable: true,
  httpsNetworkAvailable: true,
  authenticationAvailable: true,
  persistenceAvailable: true,
};

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

test("the isolation probe does not trust a legacy affirmative boolean report", async () => {
  let runnerCalls = 0;
  await assert.rejects(isolation.probeCodexIsolation({
    codexPath: "/controlled/codex",
    isolatedDir: "/isolated",
    projectDir: "/project",
    runner: async () => { runnerCalls += 1; return COMPLETE_REPORT; },
  }), { code: "CODEX_ISOLATION_UNAVAILABLE" });
  assert.equal(runnerCalls, 0);
});

test("the isolation probe fails closed without exposing raw probe details", async () => {
  await assert.rejects(
    isolation.probeCodexIsolation({
      codexPath: "/controlled/codex",
      isolatedDir: "/isolated",
      projectDir: "/project",
      probePaths: {
        isolatedFile: "/isolated/inside.txt",
        outsideFile: "/outside/probe.txt",
        projectFile: "/project/project.txt",
      },
      probeAdapter: async () => { throw new Error("raw token and /private/project/path"); },
    }),
    (error) => {
      assert.equal(error.code, "CODEX_ISOLATION_UNAVAILABLE");
      assert.equal(error.message, "CODEX_ISOLATION_UNAVAILABLE");
      assert.equal(JSON.stringify(error).includes("raw token"), false);
      assert.equal(JSON.stringify(error).includes("/private/project/path"), false);
      return true;
    },
  );
});

test("the isolation probe rejects missing, relative or project-overlapping boundaries", async () => {
  let adapterCalls = 0;
  const probeAdapter = async () => { adapterCalls += 1; return { exitCode: 0, stdout: "{}\n" }; };

  for (const boundaries of [
    { projectDir: "/project" },
    { isolatedDir: "relative", projectDir: "/project" },
    { isolatedDir: "/isolated", projectDir: "relative" },
    { isolatedDir: "/project", projectDir: "/project" },
    { isolatedDir: "/project/isolated", projectDir: "/project" },
  ]) {
    await assert.rejects(isolation.probeCodexIsolation({
      codexPath: "/controlled/codex",
      probePaths: {
        isolatedFile: "/isolated/inside.txt",
        outsideFile: "/outside/probe.txt",
        projectFile: "/project/project.txt",
      },
      ...boundaries,
      probeAdapter,
    }), {
      code: "CODEX_ISOLATION_UNAVAILABLE",
    });
  }
  assert.equal(adapterCalls, 0);
});

test("the isolation probe executes and parses evidence for synthetic file, HTTPS, auth and persistence checks", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "codex-isolation-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const isolatedDir = join(root, "isolated");
  const projectDir = join(root, "project");
  await Promise.all([mkdir(isolatedDir), mkdir(projectDir)]);
  const probePaths = {
    isolatedFile: join(isolatedDir, "inside.txt"),
    outsideFile: join(root, "outside.txt"),
    projectFile: join(projectDir, "project.txt"),
  };
  await Promise.all([
    writeFile(probePaths.isolatedFile, "inside"),
    writeFile(probePaths.outsideFile, "outside"),
    writeFile(probePaths.projectFile, "project"),
  ]);
  const calls = [];

  const result = await isolation.probeCodexIsolation({
    codexPath: "/controlled/codex",
    isolatedDir,
    projectDir,
    probePaths,
    sourceEnv: { PATH: "/usr/bin", HOME: "/Users/owner", PROJECT_SECRET: "must-not-leak" },
    probeAdapter: async (request) => {
      calls.push(request);
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({
          check: request.check.name,
          target: request.check.target,
          observed: request.check.expected,
          ...(request.check.name === "persistenceAvailable" ? { codexThreadId: "probe-thread-1" } : {}),
        })}\n`,
      };
    },
  });

  assert.deepEqual(result, COMPLETE_REPORT);
  assert.equal(calls.length, 6);
  assert.deepEqual(calls.map((call) => call.check), [
    { name: "isolatedDirectoryReadable", target: probePaths.isolatedFile, expected: "readable" },
    { name: "outsideDirectoryUnreadable", target: probePaths.outsideFile, expected: "denied" },
    { name: "projectDirectoryUnreadable", target: probePaths.projectFile, expected: "denied" },
    { name: "httpsNetworkAvailable", target: "https://example.com/", expected: "available" },
    { name: "authenticationAvailable", expected: "authenticated" },
    { name: "persistenceAvailable", expected: "persistent" },
  ]);
  for (const call of calls) {
    assert.equal(call.executable, "/controlled/codex");
    assert.equal(call.cwd, isolatedDir);
    assert.deepEqual(call.permissionOverrides, EXPECTED_OVERRIDES);
    assert.deepEqual(call.env, { PATH: "/usr/bin", HOME: "/Users/owner" });
  }
});

test("low-level probe evidence fails closed when it is mismatched, incomplete or raw-invalid", async () => {
  const base = {
    codexPath: "/controlled/codex",
    isolatedDir: "/isolated",
    projectDir: "/project",
    probePaths: {
      isolatedFile: "/isolated/inside.txt",
      outsideFile: "/outside/probe.txt",
      projectFile: "/project/project.txt",
    },
  };
  for (const response of [
    { exitCode: 1, stdout: "" },
    { exitCode: 0, stdout: "not-json\n" },
    { exitCode: 0, stdout: `${JSON.stringify({ check: "wrong", target: "/isolated/inside.txt", observed: "readable" })}\n` },
    { exitCode: 0, stdout: `${JSON.stringify({ check: "isolatedDirectoryReadable", target: "/wrong", observed: "readable" })}\n` },
  ]) {
    await assert.rejects(isolation.probeCodexIsolation({
      ...base,
      probeAdapter: async () => response,
    }), { code: "CODEX_ISOLATION_UNAVAILABLE" });
  }
});
