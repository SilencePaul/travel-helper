import { spawn } from "node:child_process";
import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { isAbsolute, normalize, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";

export const CODEX_ISOLATION_ERROR = "CODEX_ISOLATION_UNAVAILABLE";

const DEFAULT_CODEX_CANDIDATES = [
  "/Applications/ChatGPT.app/Contents/Resources/codex",
];

const PERMISSION_OVERRIDES = [
  'permissions.travel_research.filesystem={":minimal"="read",":workspace_roots"="read"}',
  "permissions.travel_research.network.enabled=true",
  'default_permissions="travel_research"',
];

const ALLOWED_ENVIRONMENT_KEYS = new Set([
  "PATH",
  "HOME",
  "CODEX_HOME",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);

const REQUIRED_PROBE_CHECKS = [
  "isolatedDirectoryReadable",
  "outsideDirectoryUnreadable",
  "projectDirectoryUnreadable",
  "httpsNetworkAvailable",
  "authenticationAvailable",
  "persistenceAvailable",
];

const NETWORK_PROBE_URL = "https://chatgpt.com/";
const PROBE_STDIO_LIMIT_BYTES = 128 * 1_024;

function codedError(code) {
  return Object.assign(new Error(code), { code });
}

function executable(candidate) {
  try {
    const info = lstatSync(candidate);
    if (!info.isFile() || info.isSymbolicLink() || realpathSync(candidate) !== candidate) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function canonicalExistingPath(value, kind, executableFile = false) {
  const info = await lstat(value);
  if (info.isSymbolicLink()) throw new Error("symlink rejected");
  if (kind === "file" ? !info.isFile() : !info.isDirectory()) throw new Error("wrong path type");
  const canonical = await realpath(value);
  if (canonical !== value) throw new Error("non-canonical path");
  if (executableFile) await access(value, constants.X_OK);
  return canonical;
}

async function verifyCanonicalProbePaths({ codexPath, isolatedDir, projectDir, probePaths }) {
  const [canonicalCodex, canonicalIsolated, canonicalProject, isolatedFile, outsideFile, projectFile] = await Promise.all([
    canonicalExistingPath(codexPath, "file", true),
    canonicalExistingPath(isolatedDir, "directory"),
    canonicalExistingPath(projectDir, "directory"),
    canonicalExistingPath(probePaths.isolatedFile, "file"),
    canonicalExistingPath(probePaths.outsideFile, "file"),
    canonicalExistingPath(probePaths.projectFile, "file"),
  ]);
  return {
    codexPath: canonicalCodex,
    isolatedDir: canonicalIsolated,
    projectDir: canonicalProject,
    probePaths: { isolatedFile, outsideFile, projectFile },
  };
}

function validCanonicalProbeReport(report, requested) {
  return report
    && typeof report === "object"
    && !Array.isArray(report)
    && ["codexPath", "isolatedDir", "projectDir", "probePaths"].every((key) => Object.hasOwn(report, key))
    && report.codexPath === requested.codexPath
    && report.isolatedDir === requested.isolatedDir
    && report.projectDir === requested.projectDir
    && report.probePaths
    && typeof report.probePaths === "object"
    && !Array.isArray(report.probePaths)
    && ["isolatedFile", "outsideFile", "projectFile"].every((key) => Object.hasOwn(report.probePaths, key) && report.probePaths[key] === requested.probePaths[key]);
}

function normalizedAbsolutePath(value) {
  return typeof value === "string" && isAbsolute(value) && normalize(value) === value;
}

function containsPath(parent, child) {
  const pathFromParent = relative(parent, child);
  return pathFromParent === "" || (!isAbsolute(pathFromParent) && pathFromParent !== ".." && !pathFromParent.startsWith(`..${sep}`));
}

function parseProbeEvidence(response, check) {
  if (
    !response
    || typeof response !== "object"
    || Array.isArray(response)
    || !Object.hasOwn(response, "exitCode")
    || !Object.hasOwn(response, "stdout")
    || response.exitCode !== 0
    || typeof response.stdout !== "string"
  ) {
    throw new Error("probe failed");
  }
  const lines = response.stdout.split(/\r?\n/u).filter((line) => line.trim());
  if (lines.length !== 1) throw new Error("invalid evidence");
  const evidence = JSON.parse(lines[0]);
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) throw new Error("invalid evidence");
  if (!Object.hasOwn(evidence, "check") || !Object.hasOwn(evidence, "observed")) throw new Error("missing evidence");
  if (evidence.check !== check.name || evidence.observed !== check.expected) throw new Error("mismatched evidence");
  if (Object.hasOwn(check, "target") && (!Object.hasOwn(evidence, "target") || evidence.target !== check.target)) throw new Error("mismatched target");
  if (!Object.hasOwn(check, "target") && Object.hasOwn(evidence, "target")) throw new Error("unexpected target");
  if (check.name === "persistenceAvailable") {
    if (!Object.hasOwn(evidence, "capability") || evidence.capability !== "thread_history_integrity") {
      throw new Error("missing persistence capability");
    }
  }
}

function safeKillProcessGroup(processKillImpl, processGroupId, signal) {
  try {
    if (!Number.isSafeInteger(processGroupId) || processGroupId >= 0) throw new Error("invalid process group");
    processKillImpl(processGroupId, signal);
  } catch {
    // A failed signal is handled by the final teardown deadline.
  }
}

function processGroupIsGone(processKillImpl, processGroupId) {
  try {
    if (!Number.isSafeInteger(processGroupId) || processGroupId >= 0) return false;
    processKillImpl(processGroupId, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

function markProcessTreeUnconfirmed(error) {
  Object.defineProperty(error, "processTreeUnconfirmed", { value: true });
  return error;
}

function runProbeProcess({ executable, args, cwd, env, spawnImpl, processKillImpl, timeoutMs, killGraceMs, signal }) {
  return new Promise((resolve, reject) => {
    let child;
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let terminationError;
    let processGroupId;
    let leaderExited = false;
    let timeoutTimer;
    let killTimer;
    let finalTimer;
    let abortHandler;

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      clearTimeout(finalTimer);
      signal?.removeEventListener?.("abort", abortHandler);
      stdout = "";
      stderr = "";
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const terminate = (error) => {
      if (terminationError) return;
      terminationError = error;
      safeKillProcessGroup(processKillImpl, processGroupId, "SIGTERM");
      killTimer = setTimeout(() => {
        safeKillProcessGroup(processKillImpl, processGroupId, "SIGKILL");
        const teardownTimeoutMs = killGraceMs + 10;
        const teardownDeadline = performance.now() + teardownTimeoutMs;
        const confirmGroupGone = () => {
          const groupGone = processGroupIsGone(processKillImpl, processGroupId);
          if (leaderExited && groupGone) {
            finish(error);
            return;
          }
          const remainingMs = teardownDeadline - performance.now();
          if (remainingMs <= 0) {
            finish(markProcessTreeUnconfirmed(error));
            return;
          }
          finalTimer = setTimeout(confirmGroupGone, Math.max(1, Math.min(10, Math.ceil(remainingMs))));
        };
        confirmGroupGone();
      }, killGraceMs);
    };
    const collect = (streamName, chunk) => {
      if (terminationError) return;
      const bytes = Buffer.byteLength(chunk);
      if (streamName === "stdout") stdoutBytes += bytes;
      else stderrBytes += bytes;
      if (stdoutBytes + stderrBytes > PROBE_STDIO_LIMIT_BYTES) {
        terminate(new Error("probe output limit"));
        return;
      }
      if (streamName === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };

    try {
      if (signal?.aborted) {
        finish(new Error("probe aborted"));
        return;
      }
      child = spawnImpl(executable, args, { shell: false, detached: true, cwd, env });
      processGroupId = Number.isSafeInteger(child.pid) && child.pid > 0 ? -child.pid : undefined;
    } catch {
      finish(new Error("probe spawn failed"));
      return;
    }
    abortHandler = () => terminate(new Error("probe aborted"));
    signal?.addEventListener?.("abort", abortHandler, { once: true });
    if (signal?.aborted) abortHandler();
    child.stdout?.on("data", (chunk) => collect("stdout", chunk));
    child.stderr?.on("data", (chunk) => collect("stderr", chunk));
    child.stdout?.on("error", () => terminate(new Error("probe stdout failed")));
    child.stderr?.on("error", () => terminate(new Error("probe stderr failed")));
    child.stdin?.on?.("error", () => terminate(new Error("probe stdin failed")));
    child.on("error", () => {
      if (!terminationError) finish(new Error("probe process failed"));
    });
    child.on("close", (exitCode, signal) => {
      if (terminationError) {
        leaderExited = true;
        return;
      }
      finish(undefined, { exitCode, signal, stdout, stderr });
    });
    timeoutTimer = setTimeout(() => terminate(new Error("probe timeout")), timeoutMs);
    try {
      child.stdin?.end();
    } catch {
      terminate(new Error("probe stdin failed"));
    }
  });
}

function ownObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function ownDoctorCheck(checks, name) {
  if (!Object.hasOwn(checks, name) || !ownObject(checks[name])) throw new Error("doctor check missing");
  const check = checks[name];
  if (!Object.hasOwn(check, "status") || check.status !== "ok") throw new Error("doctor check failed");
  return check;
}

function parseDoctorOutput(stdout) {
  const report = JSON.parse(stdout);
  if (!ownObject(report)
    || !Object.hasOwn(report, "schemaVersion") || report.schemaVersion !== 1
    || !Object.hasOwn(report, "overallStatus") || typeof report.overallStatus !== "string"
    || !Object.hasOwn(report, "checks") || !ownObject(report.checks)) {
    throw new Error("invalid doctor report");
  }
  const auth = ownDoctorCheck(report.checks, "auth.credentials");
  const state = ownDoctorCheck(report.checks, "state.paths");
  ownDoctorCheck(report.checks, "sandbox.helpers");
  ownDoctorCheck(report.checks, "network.websocket_reachability");
  if (!Object.hasOwn(auth, "details") || !ownObject(auth.details)
    || !Object.hasOwn(auth.details, "stored ChatGPT tokens")
    || auth.details["stored ChatGPT tokens"] !== "true") {
    throw new Error("missing ChatGPT credentials");
  }
  if (!Object.hasOwn(state, "details") || !ownObject(state.details)
    || !Object.hasOwn(state.details, "thread history DB integrity")
    || state.details["thread history DB integrity"] !== "ok") {
    throw new Error("missing thread history capability");
  }
}

function probeEvidenceResponse(check, observed, extra = {}) {
  return {
    exitCode: 0,
    stdout: `${JSON.stringify({
      check: check.name,
      ...(Object.hasOwn(check, "target") ? { target: check.target } : {}),
      observed,
      ...extra,
    })}\n`,
  };
}

function createDefaultProbeAdapter(options) {
  const spawnImpl = options.spawnImpl ?? spawn;
  const processKillImpl = options.processKillImpl ?? process.kill.bind(process);
  const timeoutMs = options.probeTimeoutMs ?? 5_000;
  const doctorTimeoutMs = options.probeDoctorTimeoutMs ?? 15_000;
  const killGraceMs = options.probeKillGraceMs ?? 500;
  const totalTimeoutMs = options.probeTotalTimeoutMs ?? 30_000;
  if (typeof spawnImpl !== "function" || typeof processKillImpl !== "function"
    || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0
    || !Number.isSafeInteger(doctorTimeoutMs) || doctorTimeoutMs <= 0
    || !Number.isSafeInteger(killGraceMs) || killGraceMs < 0
    || !Number.isSafeInteger(totalTimeoutMs) || totalTimeoutMs <= 0) {
    throw new Error("invalid probe process options");
  }
  const startedAt = performance.now();
  let doctorPromise;
  const run = async (request, args, stepTimeoutMs = timeoutMs) => {
    const remainingMs = totalTimeoutMs - (performance.now() - startedAt);
    const teardownReserveMs = killGraceMs * 2 + 10;
    if (remainingMs <= teardownReserveMs) throw new Error("probe total timeout");
    return runProbeProcess({
      executable: request.executable,
      args,
      cwd: request.cwd,
      env: request.env,
      spawnImpl,
      processKillImpl,
      timeoutMs: Math.min(stepTimeoutMs, remainingMs - teardownReserveMs),
      killGraceMs,
      signal: request.signal,
    });
  };
  const doctor = async (request) => {
    doctorPromise ??= (async () => {
      const result = await run(
        request,
        ["doctor", ...request.permissionOverrides.flatMap((value) => ["-c", value]), "--json"],
        doctorTimeoutMs,
      );
      if (result.exitCode !== 0 || result.signal !== null) throw new Error("doctor failed");
      parseDoctorOutput(result.stdout);
    })();
    return doctorPromise;
  };
  return async (request) => {
    const sandboxPrefix = [
      "sandbox", "-P", "travel_research", "-C", request.cwd,
      ...request.permissionOverrides.flatMap((value) => ["-c", value]),
      "--",
    ];
    if (["isolatedDirectoryReadable", "outsideDirectoryUnreadable", "projectDirectoryUnreadable"].includes(request.check.name)) {
      const result = await run(request, [...sandboxPrefix, "/bin/cat", request.check.target]);
      if (result.signal !== null || !Number.isInteger(result.exitCode)) throw new Error("sandbox probe failed");
      const observed = result.exitCode === 0 ? "readable" : "denied";
      return probeEvidenceResponse(request.check, observed);
    }
    if (request.check.name === "httpsNetworkAvailable") {
      const result = await run(request, [
        ...sandboxPrefix,
        "/usr/bin/curl", "--silent", "--show-error", "--max-time", "5", "--head",
        "--output", "/dev/null", "--write-out", "%{http_code}", NETWORK_PROBE_URL,
      ]);
      if (result.signal !== null || !Number.isInteger(result.exitCode)) throw new Error("network probe failed");
      const httpCode = result.stdout.trim();
      const available = result.exitCode === 0 && /^[1-5]\d{2}$/u.test(httpCode);
      return probeEvidenceResponse(request.check, available ? "available" : "unavailable");
    }
    if (request.check.name === "authenticationAvailable") {
      await doctor(request);
      return probeEvidenceResponse(request.check, "authenticated");
    }
    if (request.check.name === "persistenceAvailable") {
      await doctor(request);
      return probeEvidenceResponse(request.check, "persistent", { capability: "thread_history_integrity" });
    }
    throw new Error("unknown probe check");
  };
}

export function discoverCodexExecutable(options = {}) {
  const candidates = options.candidates ?? DEFAULT_CODEX_CANDIDATES;
  const isExecutable = options.isExecutable ?? executable;
  if (!Array.isArray(candidates) || typeof isExecutable !== "function") throw codedError("CODEX_NOT_AVAILABLE");
  for (const candidate of candidates) {
    if (!normalizedAbsolutePath(candidate)) continue;
    try {
      if (isExecutable(candidate)) return candidate;
    } catch {
      // An uncertain executable check is treated as unavailable.
    }
  }
  throw codedError("CODEX_NOT_AVAILABLE");
}

export function buildPermissionOverrides() {
  return [...PERMISSION_OVERRIDES];
}

export async function probeCodexIsolation(options) {
  try {
    if (!options) throw new Error("invalid probe");
    if (options.signal?.aborted) throw new Error("probe aborted");
    if (!normalizedAbsolutePath(options.codexPath)) throw new Error("invalid executable");
    if (!normalizedAbsolutePath(options.isolatedDir) || !normalizedAbsolutePath(options.projectDir)) throw new Error("invalid boundary");
    if (containsPath(options.projectDir, options.isolatedDir) || containsPath(options.isolatedDir, options.projectDir)) throw new Error("overlapping boundary");
    const probePaths = options.probePaths;
    if (!probePaths || !normalizedAbsolutePath(probePaths.isolatedFile) || !normalizedAbsolutePath(probePaths.outsideFile) || !normalizedAbsolutePath(probePaths.projectFile)) {
      throw new Error("invalid probe paths");
    }
    if (!containsPath(options.isolatedDir, probePaths.isolatedFile) || !containsPath(options.projectDir, probePaths.projectFile)) {
      throw new Error("misplaced probe path");
    }
    if (containsPath(options.isolatedDir, probePaths.outsideFile) || containsPath(options.projectDir, probePaths.outsideFile)) {
      throw new Error("outside probe is not outside");
    }
    const pathVerifier = options.pathVerifier ?? verifyCanonicalProbePaths;
    if (typeof pathVerifier !== "function") throw new Error("invalid path verifier");
    const requestedPaths = {
      codexPath: options.codexPath,
      isolatedDir: options.isolatedDir,
      projectDir: options.projectDir,
      probePaths,
    };
    const canonical = await pathVerifier(requestedPaths);
    if (!validCanonicalProbeReport(canonical, requestedPaths)) throw new Error("invalid canonical paths");
    if (options.signal?.aborted) throw new Error("probe aborted");
    if (containsPath(canonical.projectDir, canonical.isolatedDir) || containsPath(canonical.isolatedDir, canonical.projectDir)) {
      throw new Error("overlapping canonical boundary");
    }
    if (!containsPath(canonical.isolatedDir, canonical.probePaths.isolatedFile)
      || !containsPath(canonical.projectDir, canonical.probePaths.projectFile)
      || containsPath(canonical.isolatedDir, canonical.probePaths.outsideFile)
      || containsPath(canonical.projectDir, canonical.probePaths.outsideFile)) {
      throw new Error("invalid canonical probe boundary");
    }
    const checks = [
      { name: "isolatedDirectoryReadable", target: canonical.probePaths.isolatedFile, expected: "readable" },
      { name: "outsideDirectoryUnreadable", target: canonical.probePaths.outsideFile, expected: "denied" },
      { name: "projectDirectoryUnreadable", target: canonical.probePaths.projectFile, expected: "denied" },
      { name: "httpsNetworkAvailable", target: NETWORK_PROBE_URL, expected: "available" },
      { name: "authenticationAvailable", expected: "authenticated" },
      { name: "persistenceAvailable", expected: "persistent" },
    ];
    const env = minimalCodexEnvironment(options.sourceEnv);
    const probeAdapter = options.probeAdapter ?? createDefaultProbeAdapter(options);
    if (typeof probeAdapter !== "function") throw new Error("invalid probe adapter");
    for (const check of checks) {
      if (options.signal?.aborted) throw new Error("probe aborted");
      const response = await probeAdapter({
        executable: canonical.codexPath,
        cwd: canonical.isolatedDir,
        env,
        permissionOverrides: buildPermissionOverrides(),
        check,
        signal: options.signal,
      });
      if (options.signal?.aborted) throw new Error("probe aborted");
      parseProbeEvidence(response, check);
    }
    return Object.fromEntries(REQUIRED_PROBE_CHECKS.map((check) => [check, true]));
  } catch (error) {
    const safeError = codedError(CODEX_ISOLATION_ERROR);
    if (error?.processTreeUnconfirmed === true) {
      Object.defineProperty(safeError, "processTreeUnconfirmed", { value: true });
    }
    throw safeError;
  }
}

export function minimalCodexEnvironment(source) {
  const environment = {};
  for (const [key, value] of Object.entries(source ?? {})) {
    if (ALLOWED_ENVIRONMENT_KEYS.has(key) && typeof value === "string") environment[key] = value;
  }
  return environment;
}
