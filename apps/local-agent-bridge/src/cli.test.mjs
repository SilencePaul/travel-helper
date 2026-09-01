import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createManagedCodexRunnerFactory,
  parseCliArguments,
  runCli,
} from "./cli.mjs";

function trustedTempBoundary(overrides = {}) {
  let quarantineSequence = 0;
  return {
    trustedTempRoot: "/private/tmp",
    canonicalizePath: (path) => path,
    inspectPath: () => ({
      dev: 10,
      ino: 20,
      isDirectory: () => true,
      isSymbolicLink: () => false,
    }),
    moveDirectory: async () => {},
    moveDirectorySync: () => {},
    quarantineToken: () => `test-${++quarantineSequence}`,
    ...overrides,
  };
}

test("CLI accepts only app URL, Agent endpoint and port zero", () => {
  assert.deepEqual(parseCliArguments([
    "--app-url", "https://trip.example",
    "--agent-endpoint", "https://api.example/api/agent",
    "--port", "0",
  ]), {
    appUrl: "https://trip.example",
    agentEndpoint: "https://api.example/api/agent",
    port: 0,
  });
  for (const argv of [
    ["--app-url", "https://trip.example", "--port", "wildcard"],
    ["--app-url", "https://trip.example", "--agent-endpoint", "https://api.example/api/agent", "--port", "43120"],
    ["--app-url", "https://trip.example", "--app-url", "https://other.example", "--agent-endpoint", "https://api.example/api/agent"],
    ["--app-url", "https://trip.example", "--unknown", "value"],
    ["--app-url", "https://trip.example", "--agent-endpoint", "https://api.example/api/agent", "--model", "gpt-5"],
    ["--app-url", "https://trip.example", "--agent-endpoint", "https://api.example/api/agent", "--prompt", "free text"],
    ["--app-url", "https://trip.example", "--agent-endpoint", "https://api.example/api/agent", "--codex-account", "other"],
    ["--app-url", "https://trip.example", "--agent-endpoint", "https://api.example/api/agent", "--sandbox", "danger-full-access"],
    ["--app-url", "https://trip.example", "--agent-endpoint", "https://api.example/api/agent", "--approval-policy", "never"],
  ]) assert.throws(() => parseCliArguments(argv), /INVALID_ARGUMENTS/);
});

test("CLI module import is safe when process.argv has no entry script", () => {
  const cliUrl = new URL(`./cli.mjs?guard=${Date.now()}`, import.meta.url).href;
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `process.argv[1] = undefined; await import(${JSON.stringify(cliUrl)});`,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("CLI composes transport, managed runner, store, notifier and research service before starting HTTP", async () => {
  const events = [];
  const signalTarget = new EventEmitter();
  const transport = { name: "transport" };
  const runner = {
    name: "runner",
    async cleanupIdle() { events.push("runner.cleanupIdle"); },
    async close() { events.push("runner.close"); },
  };
  const store = { name: "store" };
  const notifier = { name: "notifier" };
  const service = {
    prepare() { events.push("service.prepare"); return {}; },
    async claim(value) { events.push(`service.claim:${value}`); return {}; },
    async executeTravelResearch(value) { events.push(["service.execute", value]); return { phase: "idle" }; },
    async getResearchStatus() { events.push("service.status"); return { phase: "idle" }; },
    async resumeTravelResearch(value) { events.push(["service.resume", value]); return { phase: "idle" }; },
    async cancelResearch(value) { events.push(["service.cancel", value]); return { phase: "idle" }; },
  };
  const clock = () => new Date("2026-09-01T00:00:00.000Z");
  const idGenerator = () => "research-task-id";
  let serviceDependencies;
  let bridgeOptions;
  let exitCode;
  const output = { write(value) { events.push(`output:${value.trim()}`); } };
  const bridge = {
    connectionUrl: "https://trip.example/#agentBridge=http://127.0.0.1:43120",
    async close() {
      events.push("bridge.close");
      await bridgeOptions.onClose();
    },
  };

  const result = await runCli([
    "--app-url", "https://trip.example/decisions",
    "--agent-endpoint", "https://api.example/api/agent",
    "--port", "0",
  ], output, {
    createTransport(options) { events.push(`transport:${options.agentEndpoint}`); return transport; },
    createRunnerFactory(options) { events.push(`runner:${options.projectDir}:${options.schemaPath}`); return runner; },
    createStore(options) { events.push(`store:${options.directory}`); return store; },
    createNotifier() { events.push("notifier"); return notifier; },
    createService(dependencies) { events.push("service"); serviceDependencies = dependencies; return service; },
    async startBridge(options) { events.push("server"); bridgeOptions = options; return bridge; },
    clock,
    idGenerator,
    projectDir: "/safe/project",
    schemaPath: "/safe/project/schema.json",
    stateDirectory: "/Users/owner/Library/Application Support/travel-agent-bridge/research-state",
    signalTarget,
    setExitCode(value) { exitCode = value; },
  });

  assert.equal(result, bridge);
  assert.deepEqual(serviceDependencies, { transport, runner, store, notifier, clock, idGenerator });
  assert.notEqual(bridgeOptions.runtime, service);
  assert.deepEqual(Object.keys(bridgeOptions.runtime).sort(), [
    "cancelResearch",
    "claim",
    "executeTravelResearch",
    "getResearchStatus",
    "prepare",
    "resumeTravelResearch",
  ]);
  assert.equal(Object.hasOwn(bridgeOptions.runtime, "command"), false);
  assert.equal(bridgeOptions.appUrl, "https://trip.example/decisions");
  assert.equal(bridgeOptions.port, 0);
  assert.equal(typeof bridgeOptions.onClose, "function");
  assert.deepEqual(events.slice(0, 6).map((event) => event.split(":")[0]), ["transport", "runner", "store", "notifier", "service", "server"]);
  assert.match(events.at(-1), /^output:请在浏览器中打开：/);

  const request = { agentRunId: "agent-run-1" };
  assert.deepEqual(await bridgeOptions.runtime.executeTravelResearch(request), { phase: "idle" });
  assert.deepEqual(events.slice(-2), [["service.execute", request], "runner.cleanupIdle"]);

  signalTarget.emit("SIGTERM");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.filter((event) => event === "bridge.close").length, 1);
  assert.equal(events.filter((event) => event === "runner.close").length, 1);
  assert.equal(exitCode, 0);
});

test("SIGTERM on the real HTTP bridge cancels active research before runner close and prevents a later cloud write", async () => {
  const events = [];
  const signalTarget = new EventEmitter();
  let phase = "idle";
  let cancelled = false;
  let releaseExecution;
  let markExecutionStarted;
  const executionGate = new Promise((resolve) => { releaseExecution = resolve; });
  const executionStarted = new Promise((resolve) => { markExecutionStarted = resolve; });
  const timestamps = {
    researchTaskId: "research-task-1",
    startedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:01:00.000Z",
  };
  const runner = {
    async cleanupIdle() { events.push("runner.cleanupIdle"); },
    async close() { events.push("runner.close"); },
  };
  const service = {
    prepare() { throw new Error("not used"); },
    async claim() { throw new Error("not used"); },
    async executeTravelResearch() {
      phase = "researching";
      events.push("service.execute.started");
      markExecutionStarted();
      await executionGate;
      if (!cancelled) events.push("cloud.write");
      phase = "cancelled";
      events.push("service.execute.finished");
      return { phase, ...timestamps, errorCode: "CODEX_RESEARCH_CANCELLED" };
    },
    async getResearchStatus() {
      events.push(`service.status:${phase}`);
      return phase === "idle" ? { phase } : { phase, ...timestamps };
    },
    async resumeTravelResearch() { throw new Error("not used"); },
    async cancelResearch(input) {
      events.push(["service.cancel", input]);
      cancelled = true;
      phase = "cancelling";
      releaseExecution();
      return { phase: "cancelled", ...timestamps, errorCode: "CODEX_RESEARCH_CANCELLED" };
    },
  };
  let resolveExit;
  const exited = new Promise((resolve) => { resolveExit = resolve; });
  const bridge = await runCli([
    "--app-url", "https://trip.example/decisions",
    "--agent-endpoint", "https://api.example/api/agent",
    "--port", "0",
  ], { write() {} }, {
    createTransport: () => ({}),
    createRunnerFactory: () => runner,
    createStore: () => ({}),
    createNotifier: () => ({}),
    createService: () => service,
    signalTarget,
    setExitCode: resolveExit,
  });

  const execution = fetch(`${bridge.origin}/v1/agent-runs/execute-travel-research`, {
    method: "POST",
    headers: { origin: "https://trip.example", "content-type": "application/json", connection: "close" },
    body: JSON.stringify({
      agentRunId: "agent-run-1",
      targetCategory: "hotel",
      targetScopeId: `scope_${"a".repeat(64)}`,
      disclosureFingerprint: "b".repeat(64),
    }),
  });
  await executionStarted;
  signalTarget.emit("SIGTERM");

  assert.equal(await exited, 0);
  const response = await execution;
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.phase, "cancelled");
  assert.equal(events.includes("cloud.write"), false);
  const cancelIndex = events.findIndex((event) => Array.isArray(event) && event[0] === "service.cancel");
  assert.equal(cancelIndex >= 0, true);
  assert.equal(events.indexOf("runner.close") > cancelIndex, true);
  assert.deepEqual(events[cancelIndex], ["service.cancel", { researchTaskId: "research-task-1" }]);
});

test("shutdown preserves owner-action state and propagates active cancellation failure after closing the runner", async () => {
  async function createHarness(status, cancelResearch) {
    const events = [];
    const signalTarget = new EventEmitter();
    const runner = {
      async cleanupIdle() {},
      async close() { events.push("runner.close"); },
    };
    const service = {
      prepare() { return {}; },
      async claim() { return {}; },
      async executeTravelResearch() { return status; },
      async getResearchStatus() { events.push(`service.status:${status.phase}`); return status; },
      async resumeTravelResearch() { return status; },
      async cancelResearch(input) { events.push(["service.cancel", input]); return cancelResearch(input); },
    };
    let bridgeOptions;
    const bridge = await runCli([
      "--app-url", "https://trip.example/decisions",
      "--agent-endpoint", "https://api.example/api/agent",
      "--port", "0",
    ], { write() {} }, {
      createTransport: () => ({}),
      createRunnerFactory: () => runner,
      createStore: () => ({}),
      createNotifier: () => ({}),
      createService: () => service,
      async startBridge(options) {
        bridgeOptions = options;
        return {
          connectionUrl: "https://trip.example/#agentBridge=http://127.0.0.1:43120",
          close: () => bridgeOptions.onClose(),
        };
      },
      signalTarget,
    });
    return { bridge, events };
  }

  const blocked = await createHarness({
    phase: "needs_owner_action",
    researchTaskId: "research-task-blocked",
  }, () => { throw new Error("must preserve owner action"); });
  await blocked.bridge.close();
  assert.deepEqual(blocked.events, ["service.status:needs_owner_action", "runner.close"]);

  const cancellationError = Object.assign(new Error("terminal reconciliation failed"), {
    code: "AGENT_TRANSPORT_UNAVAILABLE",
  });
  const active = await createHarness({
    phase: "writing",
    researchTaskId: "research-task-writing",
  }, async () => { throw cancellationError; });
  await assert.rejects(active.bridge.close(), cancellationError);
  assert.deepEqual(active.events, [
    "service.status:writing",
    ["service.cancel", { researchTaskId: "research-task-writing" }],
    "runner.close",
  ]);

  const terminalFailure = await createHarness({
    phase: "cancelling",
    researchTaskId: "research-task-terminal-failure",
  }, async () => ({ phase: "failed", errorCode: "AGENT_TRANSPORT_UNAVAILABLE" }));
  await assert.rejects(terminalFailure.bridge.close(), { code: "AGENT_TRANSPORT_UNAVAILABLE" });
  assert.deepEqual(terminalFailure.events, [
    "service.status:cancelling",
    ["service.cancel", { researchTaskId: "research-task-terminal-failure" }],
    "runner.close",
  ]);
});

test("SIGTERM reports exit failure when active terminal reconciliation cannot finish", async () => {
  const events = [];
  const signalTarget = new EventEmitter();
  const failure = Object.assign(new Error("reconciliation uncertain"), { code: "AGENT_TRANSPORT_UNAVAILABLE" });
  const runner = {
    async cleanupIdle() {},
    async close() { events.push("runner.close"); },
  };
  const service = {
    prepare() { return {}; },
    async claim() { return {}; },
    async executeTravelResearch() { return {}; },
    async getResearchStatus() {
      return { phase: "cancelling", researchTaskId: "research-task-1" };
    },
    async resumeTravelResearch() { return {}; },
    async cancelResearch() { events.push("service.cancel"); throw failure; },
  };
  let bridgeOptions;
  let resolveExit;
  const exited = new Promise((resolve) => { resolveExit = resolve; });
  await runCli([
    "--app-url", "https://trip.example/decisions",
    "--agent-endpoint", "https://api.example/api/agent",
    "--port", "0",
  ], { write() {} }, {
    createTransport: () => ({}),
    createRunnerFactory: () => runner,
    createStore: () => ({}),
    createNotifier: () => ({}),
    createService: () => service,
    async startBridge(options) {
      bridgeOptions = options;
      return {
        connectionUrl: "https://trip.example/#agentBridge=http://127.0.0.1:43120",
        close: () => bridgeOptions.onClose(),
      };
    },
    signalTarget,
    setExitCode: resolveExit,
  });

  signalTarget.emit("SIGTERM");
  assert.equal(await exited, 1);
  assert.deepEqual(events, ["service.cancel", "runner.close"]);
});

test("managed runner factory forwards Task7 options, isolates each session and cleans on cancel and close", async () => {
  const events = [];
  const sessionOptions = [];
  const directories = [
    "/private/tmp/travel-research-task-a",
    "/private/tmp/travel-research-task-b",
    "/private/tmp/travel-research-task-c",
  ];
  const factory = createManagedCodexRunnerFactory({
    ...trustedTempBoundary(),
    projectDir: "/safe/project",
    schemaPath: "/safe/project/schema.json",
    projectProbePath: "/safe/project/package.json",
    outsideProbePath: "/etc/hosts",
    sourceEnv: { HOME: "/Users/owner", PATH: "/usr/bin:/bin" },
    discoverCodex: () => { events.push("discover"); return "/Applications/ChatGPT.app/Contents/Resources/codex"; },
    makeTempDirectory: () => { const value = directories.shift(); events.push(`mkdir:${value}`); return value; },
    writeProbeFile(path, value, options) { events.push(["probe", path, value, options]); },
    moveDirectory: async (from, to) => { events.push(`move:${from}:${to}`); },
    moveDirectorySync(from, to) { events.push(`move-sync:${from}:${to}`); },
    removeDirectory: async (path) => { events.push(`rm:${path}`); },
    removeDirectorySync(path) { events.push(`rm-sync:${path}`); },
    createRunner(options) {
      sessionOptions.push(options);
      return {
        getState() { return { codexThreadId: undefined, correctionUsed: false, activeDurationMs: 0 }; },
        async runInitial() { return { codexThreadId: "thread-1", output: { status: "completed" }, activeDurationMs: 1 }; },
        async resume() { return { codexThreadId: "thread-1", output: { status: "completed" }, activeDurationMs: 2 }; },
        async cancel() { events.push(`cancel:${options.isolatedDir}`); return true; },
      };
    },
  });

  const first = factory.create({ activeTimeoutMs: 600_000 });
  const second = factory.create({
    activeTimeoutMs: 500_000,
    initialState: { codexThreadId: "thread-1", correctionUsed: true, activeDurationMs: 100_000 },
  });
  const third = factory.create({ activeTimeoutMs: 400_000 });
  assert.equal(sessionOptions[0].activeTimeoutMs, 600_000);
  assert.equal(Object.hasOwn(sessionOptions[0], "initialState"), false);
  assert.deepEqual(sessionOptions[1].initialState, { codexThreadId: "thread-1", correctionUsed: true, activeDurationMs: 100_000 });
  assert.notEqual(sessionOptions[0].isolatedDir, sessionOptions[1].isolatedDir);
  assert.deepEqual(sessionOptions.slice(0, 2).map((value) => value.probePaths), [
    { isolatedFile: "/private/tmp/travel-research-task-a/inside.txt", outsideFile: "/etc/hosts", projectFile: "/safe/project/package.json" },
    { isolatedFile: "/private/tmp/travel-research-task-b/inside.txt", outsideFile: "/etc/hosts", projectFile: "/safe/project/package.json" },
  ]);
  assert.equal(sessionOptions.every((value) => value.codexPath === "/Applications/ChatGPT.app/Contents/Resources/codex"), true);

  await first.cancel();
  assert.equal(events.filter((event) => event === "move:/private/tmp/travel-research-task-a:/private/tmp/.travel-research-quarantine-test-1").length, 1);
  assert.equal(events.filter((event) => event === "rm:/private/tmp/.travel-research-quarantine-test-1").length, 1);
  await first.cancel();
  assert.equal(events.filter((event) => event === "rm:/private/tmp/.travel-research-quarantine-test-1").length, 1);

  await factory.cleanupIdle();
  assert.equal(events.filter((event) => event === "cancel:/private/tmp/travel-research-task-b").length, 1);
  assert.equal(events.filter((event) => event === "rm:/private/tmp/.travel-research-quarantine-test-2").length, 1);
  await factory.close();
  assert.equal(events.filter((event) => event === "cancel:/private/tmp/travel-research-task-c").length, 1);
  assert.equal(events.filter((event) => event === "rm:/private/tmp/.travel-research-quarantine-test-3").length, 1);
  assert.throws(() => factory.create({ activeTimeoutMs: 1 }), /CODEX_RESEARCH_FAILED/);
  assert.equal(second.getState().activeDurationMs, 0);
  assert.equal(third.getState().activeDurationMs, 0);
});

test("managed runner factory removes a new directory if runner construction fails", () => {
  const removed = [];
  const moved = [];
  const factory = createManagedCodexRunnerFactory({
    ...trustedTempBoundary(),
    projectDir: "/safe/project",
    schemaPath: "/safe/project/schema.json",
    projectProbePath: "/safe/project/package.json",
    outsideProbePath: "/etc/hosts",
    discoverCodex: () => "/Applications/ChatGPT.app/Contents/Resources/codex",
    makeTempDirectory: () => "/private/tmp/travel-research-task-failed",
    writeProbeFile() {},
    moveDirectorySync(from, to) { moved.push([from, to]); },
    removeDirectory: async () => {},
    removeDirectorySync(path) { removed.push(path); },
    createRunner() { throw Object.assign(new Error("private construction detail"), { code: "CODEX_NOT_AVAILABLE" }); },
  });
  assert.throws(() => factory.create({ activeTimeoutMs: 1 }), { code: "CODEX_NOT_AVAILABLE" });
  assert.deepEqual(moved, [[
    "/private/tmp/travel-research-task-failed",
    "/private/tmp/.travel-research-quarantine-test-1",
  ]]);
  assert.deepEqual(removed, ["/private/tmp/.travel-research-quarantine-test-1"]);
});

test("managed runner factory never cleans an untrusted relative directory result", () => {
  const removed = [];
  const factory = createManagedCodexRunnerFactory({
    ...trustedTempBoundary(),
    projectDir: "/safe/project",
    schemaPath: "/safe/project/schema.json",
    projectProbePath: "/safe/project/package.json",
    outsideProbePath: "/etc/hosts",
    discoverCodex: () => "/Applications/ChatGPT.app/Contents/Resources/codex",
    makeTempDirectory: () => "relative-or-injected-path",
    writeProbeFile() { throw new Error("must not write"); },
    removeDirectory: async (path) => { removed.push(path); },
    removeDirectorySync(path) { removed.push(path); },
    createRunner() { throw new Error("must not run"); },
  });

  assert.throws(() => factory.create({ activeTimeoutMs: 1 }), { code: "CODEX_ISOLATION_UNAVAILABLE" });
  assert.deepEqual(removed, []);
});

test("managed runner factory refuses unowned, colliding, project-related and symlink-escaped paths without deleting them", () => {
  const unsafePaths = [
    "/",
    "/Users/owner",
    "/private/tmp",
    "/safe/project",
    "/safe/project/child",
    "/safe",
    "relative-path",
    "/private/tmp/travel-research-",
    "/private/tmp/travel-researcher-collision",
    "/private/tmp/travel-research-nested/child",
  ];
  for (const candidate of unsafePaths) {
    const removed = [];
    const factory = createManagedCodexRunnerFactory({
      ...trustedTempBoundary(),
      projectDir: "/safe/project",
      schemaPath: "/safe/project/schema.json",
      projectProbePath: "/safe/project/package.json",
      outsideProbePath: "/etc/hosts",
      makeTempDirectory: () => candidate,
      writeProbeFile() { throw new Error("must not write"); },
      removeDirectory: async (path) => { removed.push(path); },
      removeDirectorySync(path) { removed.push(path); },
      createRunner() { throw new Error("must not run"); },
    });
    assert.throws(() => factory.create({ activeTimeoutMs: 1 }), { code: "CODEX_ISOLATION_UNAVAILABLE" }, candidate);
    assert.deepEqual(removed, [], candidate);
  }

  const removed = [];
  const symlinkPath = "/private/tmp/travel-research-symlink";
  const factory = createManagedCodexRunnerFactory({
    ...trustedTempBoundary({
      canonicalizePath: (path) => path === symlinkPath ? "/safe/project/escape" : path,
      inspectPath: (path) => ({
        dev: 10,
        ino: 20,
        isDirectory: () => path === symlinkPath,
        isSymbolicLink: () => path === symlinkPath,
      }),
    }),
    projectDir: "/safe/project",
    schemaPath: "/safe/project/schema.json",
    projectProbePath: "/safe/project/package.json",
    outsideProbePath: "/etc/hosts",
    makeTempDirectory: () => symlinkPath,
    writeProbeFile() { throw new Error("must not write"); },
    removeDirectory: async (path) => { removed.push(path); },
    removeDirectorySync(path) { removed.push(path); },
    createRunner() { throw new Error("must not run"); },
  });
  assert.throws(() => factory.create({ activeTimeoutMs: 1 }), { code: "CODEX_ISOLATION_UNAVAILABLE" });
  assert.deepEqual(removed, []);
});

test("managed cleanup refuses a replaced directory identity without moving or deleting it", async () => {
  const isolatedDir = "/private/tmp/travel-research-owned";
  const removed = [];
  const moved = [];
  let inspection = 0;
  const factory = createManagedCodexRunnerFactory({
    ...trustedTempBoundary({
      inspectPath: () => ({
        dev: 10,
        ino: inspection++ === 0 ? 20 : 21,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      }),
    }),
    projectDir: "/safe/project",
    schemaPath: "/safe/project/schema.json",
    projectProbePath: "/safe/project/package.json",
    outsideProbePath: "/etc/hosts",
    discoverCodex: () => "/Applications/ChatGPT.app/Contents/Resources/codex",
    makeTempDirectory: () => isolatedDir,
    writeProbeFile() {},
    moveDirectory: async (from, to) => { moved.push([from, to]); },
    removeDirectory: async (path) => { removed.push(path); },
    removeDirectorySync(path) { removed.push(path); },
    createRunner() {
      return {
        getState: () => ({}),
        runInitial: async () => ({}),
        resume: async () => ({}),
        cancel: async () => true,
      };
    },
  });

  const session = factory.create({ activeTimeoutMs: 1 });
  await assert.rejects(session.cancel(), { code: "CODEX_ISOLATION_UNAVAILABLE" });
  await assert.rejects(factory.close(), { code: "CODEX_ISOLATION_UNAVAILABLE" });
  assert.deepEqual(moved, []);
  assert.deepEqual(removed, []);
});

test("cleanupIdle reports EBUSY, retains quarantined ownership and lets close retry without double deletion", async () => {
  const isolatedDir = "/private/tmp/travel-research-owned";
  const quarantineDir = "/private/tmp/.travel-research-quarantine-retry";
  const moved = [];
  const removed = [];
  let removeAttempts = 0;
  const factory = createManagedCodexRunnerFactory({
    ...trustedTempBoundary({ quarantineToken: () => "retry" }),
    projectDir: "/safe/project",
    schemaPath: "/safe/project/schema.json",
    projectProbePath: "/safe/project/package.json",
    outsideProbePath: "/etc/hosts",
    discoverCodex: () => "/Applications/ChatGPT.app/Contents/Resources/codex",
    makeTempDirectory: () => isolatedDir,
    writeProbeFile() {},
    moveDirectory: async (from, to) => { moved.push([from, to]); },
    removeDirectory: async (path) => {
      removed.push(path);
      removeAttempts += 1;
      if (removeAttempts === 1) throw Object.assign(new Error("busy"), { code: "EBUSY" });
    },
    removeDirectorySync() {},
    createRunner: () => ({
      getState: () => ({}),
      runInitial: async () => ({}),
      resume: async () => ({}),
      cancel: async () => true,
    }),
  });

  const session = factory.create({ activeTimeoutMs: 1 });
  await assert.rejects(factory.cleanupIdle(), { code: "EBUSY" });
  assert.deepEqual(moved, [[isolatedDir, quarantineDir]]);
  assert.deepEqual(removed, [quarantineDir]);

  await factory.close();
  assert.deepEqual(moved, [[isolatedDir, quarantineDir]]);
  assert.deepEqual(removed, [quarantineDir, quarantineDir]);
  await factory.close();
  await session.cancel();
  assert.deepEqual(removed, [quarantineDir, quarantineDir]);
});

test("managed cleanup never deletes when the quarantined inode differs after rename", async () => {
  const isolatedDir = "/private/tmp/travel-research-owned";
  const quarantineDir = "/private/tmp/.travel-research-quarantine-replaced";
  const moved = [];
  const removed = [];
  const factory = createManagedCodexRunnerFactory({
    ...trustedTempBoundary({
      quarantineToken: () => "replaced",
      inspectPath: (path) => ({
        dev: 10,
        ino: path === quarantineDir ? 21 : 20,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      }),
    }),
    projectDir: "/safe/project",
    schemaPath: "/safe/project/schema.json",
    projectProbePath: "/safe/project/package.json",
    outsideProbePath: "/etc/hosts",
    discoverCodex: () => "/Applications/ChatGPT.app/Contents/Resources/codex",
    makeTempDirectory: () => isolatedDir,
    writeProbeFile() {},
    moveDirectory: async (from, to) => { moved.push([from, to]); },
    removeDirectory: async (path) => { removed.push(path); },
    removeDirectorySync(path) { removed.push(path); },
    createRunner: () => ({
      getState: () => ({}),
      runInitial: async () => ({}),
      resume: async () => ({}),
      cancel: async () => true,
    }),
  });

  const session = factory.create({ activeTimeoutMs: 1 });
  await assert.rejects(session.cancel(), { code: "CODEX_ISOLATION_UNAVAILABLE" });
  await assert.rejects(factory.close(), { code: "CODEX_ISOLATION_UNAVAILABLE" });
  assert.deepEqual(moved, [[isolatedDir, quarantineDir]]);
  assert.deepEqual(removed, []);
});

test("the real CLI constructs components without running Codex or notifications, then exits on SIGTERM", async (context) => {
  const child = spawn(process.execPath, [
    fileURLToPath(new URL("./cli.mjs", import.meta.url)),
    "--app-url", "https://trip.example/decisions",
    "--agent-endpoint", "https://api.example/api/agent",
    "--port", "0",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  context.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (value) => { stdout += value; });
  child.stderr.on("data", (value) => { stderr += value; });
  const waitForOutput = (pattern) => new Promise((resolve, reject) => {
    const inspect = () => {
      const match = stdout.match(pattern);
      if (!match) return false;
      cleanup();
      resolve(match);
      return true;
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", inspect);
      child.off("exit", onExit);
    };
    const onExit = () => {
      cleanup();
      reject(new Error(`CLI exited before expected output: ${stderr}`));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for CLI output: ${stdout} ${stderr}`));
    }, 5_000);
    child.stdout.on("data", inspect);
    child.once("exit", onExit);
    inspect();
  });

  const connectionMatch = await waitForOutput(/请在浏览器中打开：(https:\/\/\S+)/);
  const connectionUrl = new URL(connectionMatch[1]);
  const bridgeOrigin = new URLSearchParams(connectionUrl.hash.slice(1)).get("agentBridge");
  assert.match(bridgeOrigin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const response = await fetch(`${bridgeOrigin}/v1/agent-runs/prepare`, {
    method: "POST",
    headers: { origin: connectionUrl.origin, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 200);
  const prepared = await response.json();
  const fingerprintMatch = await waitForOutput(/本机配对指纹：([A-F0-9]{4} · [A-F0-9]{4})/);
  assert.equal(fingerprintMatch[1], prepared.data.pairingCodeFingerprint);

  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  child.kill("SIGTERM");
  assert.deepEqual(await exited, { code: 0, signal: null });
});
