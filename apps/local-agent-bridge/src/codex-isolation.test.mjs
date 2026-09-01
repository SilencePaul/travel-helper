import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
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

async function passthroughPathVerifier(request) {
  return { ...request, probePaths: { ...request.probePaths } };
}

const PROBE_OPTIONS = {
  codexPath: "/controlled/codex",
  isolatedDir: "/isolated",
  projectDir: "/project",
  probePaths: {
    isolatedFile: "/isolated/inside.txt",
    outsideFile: "/outside/probe.txt",
    projectFile: "/project/project.txt",
  },
  pathVerifier: passthroughPathVerifier,
};

function successfulProbeResponse(request) {
  return {
    exitCode: 0,
    stdout: `${JSON.stringify({
      check: request.check.name,
      ...(Object.hasOwn(request.check, "target") ? { target: request.check.target } : {}),
      observed: request.check.expected,
      ...(request.check.name === "persistenceAvailable" ? { capability: "thread_history_integrity" } : {}),
    })}\n`,
  };
}

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
      pathVerifier: passthroughPathVerifier,
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
          ...(request.check.name === "persistenceAvailable" ? { capability: "thread_history_integrity" } : {}),
        })}\n`,
      };
    },
    pathVerifier: passthroughPathVerifier,
  });

  assert.deepEqual(result, COMPLETE_REPORT);
  assert.equal(calls.length, 6);
  assert.deepEqual(calls.map((call) => call.check), [
    { name: "isolatedDirectoryReadable", target: probePaths.isolatedFile, expected: "readable" },
    { name: "outsideDirectoryUnreadable", target: probePaths.outsideFile, expected: "denied" },
    { name: "projectDirectoryUnreadable", target: probePaths.projectFile, expected: "denied" },
    { name: "httpsNetworkAvailable", target: "https://chatgpt.com/", expected: "available" },
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
    pathVerifier: passthroughPathVerifier,
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

test("probe response exitCode and stdout must be own properties", async () => {
  await assert.rejects(isolation.probeCodexIsolation({
    ...PROBE_OPTIONS,
    probeAdapter: async (request) => Object.create(successfulProbeResponse(request)),
  }), { code: "CODEX_ISOLATION_UNAVAILABLE" });
});

test("parsed evidence required fields must be own properties", async () => {
  const originalParse = JSON.parse;
  JSON.parse = (text) => {
    const parsed = originalParse(text);
    if (parsed.check !== "isolatedDirectoryReadable") return parsed;
    const { check, ...own } = parsed;
    return Object.assign(Object.create({ check }), own);
  };
  try {
    await assert.rejects(isolation.probeCodexIsolation({
      ...PROBE_OPTIONS,
      probeAdapter: async (request) => successfulProbeResponse(request),
    }), { code: "CODEX_ISOLATION_UNAVAILABLE" });
  } finally {
    JSON.parse = originalParse;
  }
});

test("persistence capability evidence must be an own property", async () => {
  const originalParse = JSON.parse;
  JSON.parse = (text) => {
    const parsed = originalParse(text);
    if (parsed.check !== "persistenceAvailable") return parsed;
    const { capability, ...own } = parsed;
    return Object.assign(Object.create({ capability }), own);
  };
  try {
    await assert.rejects(isolation.probeCodexIsolation({
      ...PROBE_OPTIONS,
      probeAdapter: async (request) => successfulProbeResponse(request),
    }), { code: "CODEX_ISOLATION_UNAVAILABLE" });
  } finally {
    JSON.parse = originalParse;
  }
});

function createProbeSpawn(outcomes) {
  const calls = [];
  const spawnImpl = (executable, args, options) => {
    const outcome = outcomes[calls.length] ?? {};
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.signals = [];
    child.stdin = { end() {} };
    child.kill = (signal) => {
      child.signals.push(signal);
      if (outcome.closeOnSignal === signal) queueMicrotask(() => child.emit("close", null, signal));
      return true;
    };
    calls.push({ executable, args, options, child });
    queueMicrotask(() => {
      if (outcome.stdout !== undefined) child.stdout.emit("data", Buffer.from(outcome.stdout));
      if (outcome.stderr !== undefined) child.stderr.emit("data", Buffer.from(outcome.stderr));
      if (!outcome.hang) child.emit("close", outcome.code ?? 0, null);
    });
    return child;
  };
  return { calls, spawnImpl };
}

function doctorOutput() {
  return JSON.stringify({
    schemaVersion: 1,
    overallStatus: "warning",
    checks: {
      "auth.credentials": { status: "ok", details: { "stored ChatGPT tokens": "true" } },
      "sandbox.helpers": { status: "ok", details: {} },
      "state.paths": { status: "ok", details: { "thread history DB integrity": "ok" } },
      "network.websocket_reachability": { status: "ok", details: {} },
    },
  });
}

test("the default probe adapter runs fixed doctor and sandbox commands without a model task", async (context) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codex-default-probe-test-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const codexPath = join(root, "codex");
  const isolatedDir = join(root, "isolated");
  const projectDir = join(root, "project");
  await Promise.all([mkdir(isolatedDir), mkdir(projectDir)]);
  await writeFile(codexPath, "#!/bin/sh\nexit 0\n");
  await chmod(codexPath, 0o700);
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
  const fake = createProbeSpawn([
    { code: 0 },
    { code: 1 },
    { code: 1 },
    { code: 0 },
    { code: 0, stdout: doctorOutput() },
  ]);

  assert.deepEqual(await isolation.probeCodexIsolation({
    codexPath,
    isolatedDir,
    projectDir,
    probePaths,
    spawnImpl: fake.spawnImpl,
    sourceEnv: { PATH: "/usr/bin:/bin", HOME: "/Users/owner", PROJECT_SECRET: "no" },
  }), COMPLETE_REPORT);

  const permissionArgs = EXPECTED_OVERRIDES.flatMap((value) => ["-c", value]);
  assert.deepEqual(fake.calls.map((call) => call.args), [
    ["sandbox", "-P", "travel_research", "-C", isolatedDir, ...permissionArgs, "--", "/bin/cat", probePaths.isolatedFile],
    ["sandbox", "-P", "travel_research", "-C", isolatedDir, ...permissionArgs, "--", "/bin/cat", probePaths.outsideFile],
    ["sandbox", "-P", "travel_research", "-C", isolatedDir, ...permissionArgs, "--", "/bin/cat", probePaths.projectFile],
    ["sandbox", "-P", "travel_research", "-C", isolatedDir, ...permissionArgs, "--", "/usr/bin/curl", "--fail", "--silent", "--show-error", "--max-time", "5", "--head", "https://chatgpt.com/"],
    ["doctor", ...permissionArgs, "--json"],
  ]);
  for (const call of fake.calls) {
    assert.equal(call.executable, codexPath);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.cwd, isolatedDir);
    assert.deepEqual(call.options.env, { PATH: "/usr/bin:/bin", HOME: "/Users/owner" });
  }
});

test("the default probe adapter times out with TERM then KILL and fails closed", async (context) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codex-default-probe-timeout-test-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const codexPath = join(root, "codex");
  const isolatedDir = join(root, "isolated");
  const projectDir = join(root, "project");
  await Promise.all([mkdir(isolatedDir), mkdir(projectDir)]);
  await writeFile(codexPath, "#!/bin/sh\nexit 0\n");
  await chmod(codexPath, 0o700);
  const probePaths = {
    isolatedFile: join(isolatedDir, "inside.txt"),
    outsideFile: join(root, "outside.txt"),
    projectFile: join(projectDir, "project.txt"),
  };
  await Promise.all(Object.values(probePaths).map((path) => writeFile(path, "probe")));
  const fake = createProbeSpawn([{ hang: true, closeOnSignal: "SIGKILL" }]);

  await assert.rejects(isolation.probeCodexIsolation({
    codexPath,
    isolatedDir,
    projectDir,
    probePaths,
    spawnImpl: fake.spawnImpl,
    probeTimeoutMs: 10,
    probeKillGraceMs: 10,
  }), { code: "CODEX_ISOLATION_UNAVAILABLE" });
  assert.deepEqual(fake.calls[0].child.signals, ["SIGTERM", "SIGKILL"]);
});

test("the isolation probe rejects canonical probe paths that cross a boundary through symlinks", async (context) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codex-isolation-canonical-test-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const codexPath = join(root, "codex");
  const isolatedDir = join(root, "isolated");
  const projectDir = join(root, "project");
  const outsideDir = join(root, "outside");
  await Promise.all([mkdir(isolatedDir), mkdir(projectDir), mkdir(outsideDir)]);
  await writeFile(codexPath, "#!/bin/sh\nexit 0\n");
  await chmod(codexPath, 0o700);
  const probePaths = {
    isolatedFile: join(isolatedDir, "inside.txt"),
    outsideFile: join(outsideDir, "outside-link.txt"),
    projectFile: join(projectDir, "project.txt"),
  };
  await Promise.all([
    writeFile(probePaths.isolatedFile, "inside"),
    writeFile(probePaths.projectFile, "project"),
    symlink(probePaths.isolatedFile, probePaths.outsideFile),
  ]);
  let adapterCalls = 0;

  await assert.rejects(isolation.probeCodexIsolation({
    codexPath,
    isolatedDir,
    projectDir,
    probePaths,
    probeAdapter: async (request) => {
      adapterCalls += 1;
      return successfulProbeResponse(request);
    },
  }), { code: "CODEX_ISOLATION_UNAVAILABLE" });
  assert.equal(adapterCalls, 0);
});
