#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { rename, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
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
const DEFAULT_TRUSTED_TEMP_ROOT = resolve(realpathSync(tmpdir()));
const TEMP_DIRECTORY_PREFIX = "travel-research-";
const QUARANTINE_DIRECTORY_PREFIX = ".travel-research-quarantine-";
const ACTIVE_RESEARCH_PHASES = new Set(["researching", "resuming", "validating", "writing", "cancelling"]);
const SUCCESSFUL_SHUTDOWN_PHASES = new Set(["completed", "cancelled", "superseded"]);
const PASSIVE_RESEARCH_PHASES = new Set(["idle", "needs_owner_action", "completed", "failed", "cancelled", "superseded"]);
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

function defaultMakeTempDirectory(prefix) {
  const directory = mkdtempSync(prefix);
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

function defaultMoveDirectory(from, to) {
  return rename(from, to);
}

function defaultMoveDirectorySync(from, to) {
  renameSync(from, to);
}

function sameOrDescendant(parent, candidate) {
  return candidate === parent || candidate.startsWith(`${parent}${sep}`);
}

function pathsOverlap(left, right) {
  return sameOrDescendant(left, right) || sameOrDescendant(right, left);
}

export function createManagedCodexRunnerFactory({
  projectDir,
  schemaPath,
  projectProbePath,
  outsideProbePath,
  trustedTempRoot = DEFAULT_TRUSTED_TEMP_ROOT,
  sourceEnv = process.env,
  canonicalizePath = realpathSync,
  inspectPath = lstatSync,
  discoverCodex = discoverCodexExecutable,
  makeTempDirectory = defaultMakeTempDirectory,
  writeProbeFile = defaultWriteProbeFile,
  moveDirectory = defaultMoveDirectory,
  moveDirectorySync = defaultMoveDirectorySync,
  removeDirectory = defaultRemoveDirectory,
  removeDirectorySync = defaultRemoveDirectorySync,
  quarantineToken = randomUUID,
  createRunner = createCodexRunner,
} = {}) {
  if (![projectDir, schemaPath, projectProbePath, outsideProbePath, trustedTempRoot].every(normalizedAbsolutePath)
    || typeof discoverCodex !== "function"
    || typeof canonicalizePath !== "function"
    || typeof inspectPath !== "function"
    || typeof makeTempDirectory !== "function"
    || typeof writeProbeFile !== "function"
    || typeof moveDirectory !== "function"
    || typeof moveDirectorySync !== "function"
    || typeof removeDirectory !== "function"
    || typeof removeDirectorySync !== "function"
    || typeof quarantineToken !== "function"
    || typeof createRunner !== "function") {
    throw codedError("CODEX_RESEARCH_FAILED");
  }
  let canonicalTempRoot;
  let canonicalProjectDir;
  let canonicalHome;
  try {
    canonicalTempRoot = resolve(canonicalizePath(trustedTempRoot));
    canonicalProjectDir = resolve(canonicalizePath(projectDir));
    canonicalHome = resolve(canonicalizePath(homedir()));
  } catch {
    throw codedError("CODEX_RESEARCH_FAILED");
  }
  if (canonicalTempRoot !== trustedTempRoot
    || canonicalProjectDir !== projectDir
    || canonicalTempRoot === parse(canonicalTempRoot).root
    || canonicalTempRoot === canonicalHome
    || pathsOverlap(canonicalTempRoot, canonicalProjectDir)) {
    throw codedError("CODEX_RESEARCH_FAILED");
  }
  const managedSessions = new Set();
  const ownedDirectories = new Set();
  const quarantinePaths = new Set();
  let closed = false;
  let closePromise;

  function inspectManagedDirectory(path, prefix) {
    if (!normalizedAbsolutePath(path)
      || path === canonicalTempRoot
      || dirname(path) !== canonicalTempRoot
      || !basename(path).startsWith(prefix)
      || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(basename(path).slice(prefix.length))
      || pathsOverlap(path, canonicalProjectDir)) {
      return undefined;
    }
    try {
      const info = inspectPath(path);
      const canonical = resolve(canonicalizePath(path));
      if (!info || typeof info.isDirectory !== "function" || typeof info.isSymbolicLink !== "function"
        || !info.isDirectory() || info.isSymbolicLink()
        || canonical !== path || dirname(canonical) !== canonicalTempRoot
        || pathsOverlap(canonical, canonicalProjectDir)
        || info.dev === undefined || info.ino === undefined) {
        return undefined;
      }
      return { dev: info.dev, ino: info.ino };
    } catch {
      return undefined;
    }
  }

  function sameIdentity(record) {
    const prefix = record.quarantined ? QUARANTINE_DIRECTORY_PREFIX : TEMP_DIRECTORY_PREFIX;
    const current = inspectManagedDirectory(record.path, prefix);
    return Boolean(current && current.dev === record.identity.dev && current.ino === record.identity.ino);
  }

  function nextQuarantinePath(record) {
    if (record.quarantinePath) return record.quarantinePath;
    const token = quarantineToken();
    if (typeof token !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(token)) {
      throw codedError("CODEX_ISOLATION_UNAVAILABLE");
    }
    const path = join(canonicalTempRoot, `${QUARANTINE_DIRECTORY_PREFIX}${token}`);
    if (quarantinePaths.has(path)) throw codedError("CODEX_ISOLATION_UNAVAILABLE");
    quarantinePaths.add(path);
    record.quarantinePath = path;
    return path;
  }

  function requireOwnedIdentity(record) {
    if (!ownedDirectories.has(record) || !sameIdentity(record)) {
      throw codedError("CODEX_ISOLATION_UNAVAILABLE");
    }
  }

  function quarantineOwnedSync(record) {
    if (record.quarantined) return;
    requireOwnedIdentity(record);
    const quarantinePath = nextQuarantinePath(record);
    moveDirectorySync(record.path, quarantinePath);
    record.path = quarantinePath;
    record.quarantined = true;
    requireOwnedIdentity(record);
  }

  async function quarantineOwned(record) {
    if (record.quarantined) return;
    requireOwnedIdentity(record);
    const quarantinePath = nextQuarantinePath(record);
    await moveDirectory(record.path, quarantinePath);
    record.path = quarantinePath;
    record.quarantined = true;
    requireOwnedIdentity(record);
  }

  function removeOwnedSync(record) {
    if (!ownedDirectories.has(record)) return false;
    quarantineOwnedSync(record);
    requireOwnedIdentity(record);
    removeDirectorySync(record.path);
    ownedDirectories.delete(record);
    quarantinePaths.delete(record.path);
    record.quarantinePath = undefined;
    return true;
  }

  async function removeOwned(record) {
    if (!ownedDirectories.has(record)) return false;
    await quarantineOwned(record);
    requireOwnedIdentity(record);
    await removeDirectory(record.path);
    ownedDirectories.delete(record);
    quarantinePaths.delete(record.path);
    record.quarantinePath = undefined;
    return true;
  }

  function create(options) {
    const keys = options && Object.hasOwn(options, "initialState")
      ? ["activeTimeoutMs", "initialState"]
      : ["activeTimeoutMs"];
    if (closed || !plainObject(options)
      || Reflect.ownKeys(options).length !== keys.length
      || keys.some((key) => !Object.hasOwn(options, key))) {
      throw codedError("CODEX_RESEARCH_FAILED");
    }
    const isolatedDir = makeTempDirectory(join(canonicalTempRoot, TEMP_DIRECTORY_PREFIX));
    const identity = inspectManagedDirectory(isolatedDir, TEMP_DIRECTORY_PREFIX);
    if (!identity) {
      throw codedError("CODEX_ISOLATION_UNAVAILABLE");
    }
    const ownership = {
      path: isolatedDir,
      identity,
      quarantined: false,
      quarantinePath: undefined,
      managed: undefined,
    };
    ownedDirectories.add(ownership);
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
      try { removeOwnedSync(ownership); } catch { /* close retries retained ownership */ }
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
    let runnerCancelled = false;
    const managed = {
      getState: () => session.getState(),
      runInitial: (input) => run(() => session.runInitial(input)),
      resume: (input) => run(() => session.resume(input)),
      cancel() {
        if (cleanupPromise) return cleanupPromise;
        const attempt = Promise.resolve().then(async () => {
          let result = false;
          if (!runnerCancelled) {
            result = await session.cancel();
            runnerCancelled = true;
          }
          await removeOwned(ownership);
          managedSessions.delete(managed);
          ownership.managed = undefined;
          return result;
        });
        cleanupPromise = attempt;
        attempt.catch(() => {
          if (cleanupPromise === attempt) cleanupPromise = undefined;
        });
        return attempt;
      },
    };
    ownership.managed = managed;
    managedSessions.add(managed);
    Object.defineProperty(managed, "idle", { get: () => activeOperations === 0 });
    return Object.freeze(managed);
  }

  async function settleStrict(promises) {
    const results = await Promise.allSettled(promises);
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  async function cleanupIdle() {
    await settleStrict([...managedSessions]
      .filter((session) => session.idle)
      .map((session) => session.cancel()));
  }

  function close() {
    if (closePromise) return closePromise;
    closed = true;
    const attempt = Promise.resolve().then(async () => {
      await settleStrict([...managedSessions].map((session) => session.cancel()));
      await settleStrict([...ownedDirectories]
        .filter((record) => !record.managed)
        .map((record) => removeOwned(record)));
    });
    closePromise = attempt;
    attempt.catch(() => {
      if (closePromise === attempt) closePromise = undefined;
    });
    return attempt;
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

function createServiceAwareShutdown(service, runner) {
  let shutdownPromise;
  return () => {
    if (shutdownPromise) return shutdownPromise;
    const attempt = Promise.resolve().then(async () => {
      let shutdownError;
      try {
        const status = await service.getResearchStatus();
        if (ACTIVE_RESEARCH_PHASES.has(status?.phase)) {
          if (typeof status.researchTaskId !== "string" || status.researchTaskId.length === 0) {
            throw codedError("CODEX_RESEARCH_FAILED");
          }
          const terminal = await service.cancelResearch({ researchTaskId: status.researchTaskId });
          if (!SUCCESSFUL_SHUTDOWN_PHASES.has(terminal?.phase)) {
            throw codedError(terminal?.phase === "failed"
              ? terminal.errorCode || "CODEX_RESEARCH_FAILED"
              : "CODEX_RESEARCH_FAILED");
          }
        } else if (!PASSIVE_RESEARCH_PHASES.has(status?.phase)) {
          throw codedError("CODEX_RESEARCH_FAILED");
        }
      } catch (error) {
        shutdownError = error;
      }
      try {
        await runner.close();
      } catch (error) {
        shutdownError ??= error;
      }
      if (shutdownError) throw shutdownError;
    });
    shutdownPromise = attempt;
    attempt.catch(() => {
      if (shutdownPromise === attempt) shutdownPromise = undefined;
    });
    return attempt;
  };
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
  const shutdown = createServiceAwareShutdown(service, runner);
  let bridge;
  try {
    bridge = await startBridge({
      appUrl: options.appUrl,
      port: options.port,
      runtime,
      onPrepared: (data) => output.write(`本机配对指纹：${data.pairingCodeFingerprint}\n`),
      onClose: shutdown,
    });
  } catch (error) {
    await shutdown();
    throw error;
  }
  output.write(`请在浏览器中打开：${bridge.connectionUrl}\n`);
  let closing;
  const removeSignalHandlers = () => {
    signalTarget.off?.("SIGINT", close);
    signalTarget.off?.("SIGTERM", close);
  };
  const close = () => {
    closing ??= (async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await bridge.close();
          setExitCode(0);
          return;
        } catch {
          // Retry once so transient owned-directory cleanup failures remain recoverable.
        }
      }
      setExitCode(1);
    })()
      .finally(removeSignalHandlers);
    return closing;
  };
  signalTarget.on("SIGINT", close);
  signalTarget.on("SIGTERM", close);
  return bridge;
}

if (typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(`本地 Agent Bridge 启动失败：${error?.code || error?.message || "UNKNOWN"}\n`);
    process.exitCode = 1;
  });
}
