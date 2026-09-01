#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { discoverCodexExecutable } from "./codex-isolation.mjs";
import { createCodexRunner } from "./codex-runner.mjs";
import { createMacosNotifier } from "./macos-notifier.mjs";
import { createResearchStateStore } from "./research-state-store.mjs";
import { LocalAgentBridgeRuntime } from "./runtime.mjs";
import { startLocalAgentBridge } from "./server.mjs";
import { TravelResearchService } from "./travel-research-service.mjs";

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_DIRECTORY = resolve(MODULE_DIRECTORY, "../../..");
const DEFAULT_SCHEMA_PATH = join(MODULE_DIRECTORY, "codex-travel-output.schema.json");
const DEFAULT_PROJECT_PROBE_PATH = join(DEFAULT_PROJECT_DIRECTORY, "package.json");
const DEFAULT_OUTSIDE_PROBE_PATH = "/etc/hosts";
const DEFAULT_STATE_DIRECTORY = join(
  homedir(),
  "Library",
  "Application Support",
  "Travel Agent Bridge",
  "research-state",
);

function codedError(code) {
  return Object.assign(new Error(code), { code });
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizedAbsolutePath(value) {
  return typeof value === "string" && isAbsolute(value) && resolve(value) === value;
}

function defaultMakeTempDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "travel-agent-research-"));
  chmodSync(directory, 0o700);
  return directory;
}

function defaultWriteProbeFile(path, value, options) {
  writeFileSync(path, value, options);
}

function defaultRemoveDirectory(path) {
  return rm(path, { recursive: true, force: true });
}

function defaultRemoveDirectorySync(path) {
  rmSync(path, { recursive: true, force: true });
}

export function createManagedCodexRunnerFactory({
  projectDir,
  schemaPath,
  projectProbePath,
  outsideProbePath,
  sourceEnv = process.env,
  discoverCodex = discoverCodexExecutable,
  makeTempDirectory = defaultMakeTempDirectory,
  writeProbeFile = defaultWriteProbeFile,
  removeDirectory = defaultRemoveDirectory,
  removeDirectorySync = defaultRemoveDirectorySync,
  createRunner = createCodexRunner,
} = {}) {
  if (![projectDir, schemaPath, projectProbePath, outsideProbePath].every(normalizedAbsolutePath)
    || typeof discoverCodex !== "function"
    || typeof makeTempDirectory !== "function"
    || typeof writeProbeFile !== "function"
    || typeof removeDirectory !== "function"
    || typeof removeDirectorySync !== "function"
    || typeof createRunner !== "function") {
    throw codedError("CODEX_RESEARCH_FAILED");
  }
  const managedSessions = new Set();
  let closed = false;

  function create(options) {
    const keys = options && Object.hasOwn(options, "initialState")
      ? ["activeTimeoutMs", "initialState"]
      : ["activeTimeoutMs"];
    if (closed || !plainObject(options)
      || Reflect.ownKeys(options).length !== keys.length
      || keys.some((key) => !Object.hasOwn(options, key))) {
      throw codedError("CODEX_RESEARCH_FAILED");
    }
    const isolatedDir = makeTempDirectory();
    if (!normalizedAbsolutePath(isolatedDir)) {
      throw codedError("CODEX_ISOLATION_UNAVAILABLE");
    }
    const isolatedFile = join(isolatedDir, "inside.txt");
    let session;
    try {
      writeProbeFile(isolatedFile, "travel-agent-isolation-probe\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
      session = createRunner({
        codexPath: discoverCodex(),
        isolatedDir,
        projectDir,
        schemaPath,
        probePaths: {
          isolatedFile,
          outsideFile: outsideProbePath,
          projectFile: projectProbePath,
        },
        sourceEnv,
        activeTimeoutMs: options.activeTimeoutMs,
        ...(Object.hasOwn(options, "initialState") ? { initialState: options.initialState } : {}),
      });
      if (!session || typeof session.getState !== "function" || typeof session.runInitial !== "function"
        || typeof session.resume !== "function" || typeof session.cancel !== "function") {
        throw codedError("CODEX_RESEARCH_FAILED");
      }
    } catch (error) {
      try { removeDirectorySync(isolatedDir); } catch { /* preserve the original stable error */ }
      throw error;
    }

    let cleanupPromise;
    let activeOperations = 0;
    const run = async (operation) => {
      activeOperations += 1;
      try {
        return await operation();
      } finally {
        activeOperations -= 1;
      }
    };
    const managed = {
      getState: () => session.getState(),
      runInitial: (input) => run(() => session.runInitial(input)),
      resume: (input) => run(() => session.resume(input)),
      cancel() {
        if (cleanupPromise) return cleanupPromise;
        cleanupPromise = (async () => {
          let result = false;
          try {
            result = await session.cancel();
          } finally {
            try {
              await removeDirectory(isolatedDir);
            } finally {
              managedSessions.delete(managed);
            }
          }
          return result;
        })();
        return cleanupPromise;
      },
    };
    managedSessions.add(managed);
    Object.defineProperty(managed, "idle", { get: () => activeOperations === 0 });
    return Object.freeze(managed);
  }

  async function cleanupIdle() {
    await Promise.allSettled([...managedSessions]
      .filter((session) => session.idle)
      .map((session) => session.cancel()));
  }

  async function close() {
    if (closed && managedSessions.size === 0) return;
    closed = true;
    await Promise.allSettled([...managedSessions].map((session) => session.cancel()));
  }

  return Object.freeze({ create, cleanupIdle, close });
}

function fixedLoopbackRuntime(service, runner) {
  const finishRunnerSession = async (operation) => {
    try {
      return await operation();
    } finally {
      await runner.cleanupIdle();
    }
  };
  return Object.freeze({
    prepare: () => service.prepare(),
    claim: (agentRunId) => service.claim(agentRunId),
    executeTravelResearch: (input) => finishRunnerSession(() => service.executeTravelResearch(input)),
    getResearchStatus: () => service.getResearchStatus(),
    resumeTravelResearch: (input) => finishRunnerSession(() => service.resumeTravelResearch(input)),
    cancelResearch: (input) => finishRunnerSession(() => service.cancelResearch(input)),
  });
}

export function parseCliArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!["--app-url", "--agent-endpoint", "--port"].includes(key) || value === undefined || Object.hasOwn(values, key)) {
      throw new Error("INVALID_ARGUMENTS");
    }
    values[key] = value;
  }
  const port = values["--port"] === undefined ? 0 : Number(values["--port"]);
  if (!values["--app-url"] || !values["--agent-endpoint"] || port !== 0) throw new Error("INVALID_ARGUMENTS");
  return { appUrl: values["--app-url"], agentEndpoint: values["--agent-endpoint"], port };
}

export async function runCli(argv = process.argv.slice(2), output = process.stdout, dependencies = {}) {
  const options = parseCliArguments(argv);
  const {
    createTransport = (value) => new LocalAgentBridgeRuntime(value),
    createRunnerFactory = createManagedCodexRunnerFactory,
    createStore = createResearchStateStore,
    createNotifier = createMacosNotifier,
    createService = (value) => new TravelResearchService(value),
    startBridge = startLocalAgentBridge,
    clock = () => new Date(),
    idGenerator = randomUUID,
    projectDir = DEFAULT_PROJECT_DIRECTORY,
    schemaPath = DEFAULT_SCHEMA_PATH,
    projectProbePath = DEFAULT_PROJECT_PROBE_PATH,
    outsideProbePath = DEFAULT_OUTSIDE_PROBE_PATH,
    stateDirectory = DEFAULT_STATE_DIRECTORY,
    sourceEnv = process.env,
    signalTarget = process,
    setExitCode = (value) => { process.exitCode = value; },
  } = dependencies;

  const transport = createTransport({ agentEndpoint: options.agentEndpoint });
  const runner = createRunnerFactory({
    projectDir,
    schemaPath,
    projectProbePath,
    outsideProbePath,
    sourceEnv,
  });
  const store = createStore({ directory: stateDirectory });
  const notifier = createNotifier();
  const service = createService({ transport, runner, store, notifier, clock, idGenerator });
  const runtime = fixedLoopbackRuntime(service, runner);
  let bridge;
  try {
    bridge = await startBridge({
      appUrl: options.appUrl,
      port: options.port,
      runtime,
      onPrepared: (data) => output.write(`本机配对指纹：${data.pairingCodeFingerprint}\n`),
      onClose: () => runner.close(),
    });
  } catch (error) {
    await runner.close();
    throw error;
  }
  output.write(`请在浏览器中打开：${bridge.connectionUrl}\n`);
  let closing;
  const removeSignalHandlers = () => {
    signalTarget.off?.("SIGINT", close);
    signalTarget.off?.("SIGTERM", close);
  };
  const close = () => {
    closing ??= bridge.close()
      .then(() => { setExitCode(0); })
      .catch(() => { setExitCode(1); })
      .finally(removeSignalHandlers);
    return closing;
  };
  signalTarget.on("SIGINT", close);
  signalTarget.on("SIGTERM", close);
  return bridge;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(`本地 Agent Bridge 启动失败：${error?.code || error?.message || "UNKNOWN"}\n`);
    process.exitCode = 1;
  });
}
