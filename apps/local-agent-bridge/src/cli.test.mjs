import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createManagedCodexRunnerFactory,
  parseCliArguments,
  runCli,
} from "./cli.mjs";

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

test("managed runner factory forwards Task7 options, isolates each session and cleans on cancel and close", async () => {
  const events = [];
  const sessionOptions = [];
  const directories = [
    "/private/tmp/travel-agent-task-a",
    "/private/tmp/travel-agent-task-b",
    "/private/tmp/travel-agent-task-c",
  ];
  const factory = createManagedCodexRunnerFactory({
    projectDir: "/safe/project",
    schemaPath: "/safe/project/schema.json",
    projectProbePath: "/safe/project/package.json",
    outsideProbePath: "/etc/hosts",
    sourceEnv: { HOME: "/Users/owner", PATH: "/usr/bin:/bin" },
    discoverCodex: () => { events.push("discover"); return "/Applications/ChatGPT.app/Contents/Resources/codex"; },
    makeTempDirectory: () => { const value = directories.shift(); events.push(`mkdir:${value}`); return value; },
    writeProbeFile(path, value, options) { events.push(["probe", path, value, options]); },
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
    { isolatedFile: "/private/tmp/travel-agent-task-a/inside.txt", outsideFile: "/etc/hosts", projectFile: "/safe/project/package.json" },
    { isolatedFile: "/private/tmp/travel-agent-task-b/inside.txt", outsideFile: "/etc/hosts", projectFile: "/safe/project/package.json" },
  ]);
  assert.equal(sessionOptions.every((value) => value.codexPath === "/Applications/ChatGPT.app/Contents/Resources/codex"), true);

  await first.cancel();
  assert.equal(events.filter((event) => event === "rm:/private/tmp/travel-agent-task-a").length, 1);
  await first.cancel();
  assert.equal(events.filter((event) => event === "rm:/private/tmp/travel-agent-task-a").length, 1);

  await factory.cleanupIdle();
  assert.equal(events.filter((event) => event === "cancel:/private/tmp/travel-agent-task-b").length, 1);
  assert.equal(events.filter((event) => event === "rm:/private/tmp/travel-agent-task-b").length, 1);
  await factory.close();
  assert.equal(events.filter((event) => event === "cancel:/private/tmp/travel-agent-task-c").length, 1);
  assert.equal(events.filter((event) => event === "rm:/private/tmp/travel-agent-task-c").length, 1);
  assert.throws(() => factory.create({ activeTimeoutMs: 1 }), /CODEX_RESEARCH_FAILED/);
  assert.equal(second.getState().activeDurationMs, 0);
  assert.equal(third.getState().activeDurationMs, 0);
});

test("managed runner factory removes a new directory if runner construction fails", () => {
  const removed = [];
  const factory = createManagedCodexRunnerFactory({
    projectDir: "/safe/project",
    schemaPath: "/safe/project/schema.json",
    projectProbePath: "/safe/project/package.json",
    outsideProbePath: "/etc/hosts",
    discoverCodex: () => "/Applications/ChatGPT.app/Contents/Resources/codex",
    makeTempDirectory: () => "/private/tmp/travel-agent-task-failed",
    writeProbeFile() {},
    removeDirectory: async () => {},
    removeDirectorySync(path) { removed.push(path); },
    createRunner() { throw Object.assign(new Error("private construction detail"), { code: "CODEX_NOT_AVAILABLE" }); },
  });
  assert.throws(() => factory.create({ activeTimeoutMs: 1 }), { code: "CODEX_NOT_AVAILABLE" });
  assert.deepEqual(removed, ["/private/tmp/travel-agent-task-failed"]);
});

test("managed runner factory never cleans an untrusted relative directory result", () => {
  const removed = [];
  const factory = createManagedCodexRunnerFactory({
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
