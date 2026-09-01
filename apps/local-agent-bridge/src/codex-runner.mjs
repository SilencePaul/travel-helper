import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { isAbsolute, normalize, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";

import {
  buildPermissionOverrides,
  CODEX_ISOLATION_ERROR,
  minimalCodexEnvironment,
  probeCodexIsolation,
} from "./codex-isolation.mjs";

const FORMAT_CORRECTION_PROMPT = "上次输出未通过结构化格式校验。请严格按照原任务和输出 Schema 重新输出完整 JSON；不要添加新事实、路径、凭据或日志。";

const CATEGORIES = new Set(["hotel", "restaurant", "attraction"]);
const SOURCE_OWNER_ACTION_REASONS = new Set([
  "source_login_required",
  "source_captcha",
  "source_risk_control",
]);
const CODEX_AUTH_MESSAGE = "请在 ChatGPT/Codex 中恢复登录后返回此页面继续。";
const SOURCE_OWNER_ACTION_MESSAGE = "请在来源网站中完成所需操作后返回此页面继续。";
const SOURCE_KINDS = new Set(["flyai", "amap", "web", "official", "manual"]);
const CAPTURE_METHODS = new Set(["detail_page", "search_result", "api_result", "manual"]);

function codedError(code) {
  return Object.assign(new Error(code), { code });
}

function validateAbsolutePath(value, code) {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value) throw codedError(code);
}

function containsPath(parent, child) {
  const pathFromParent = relative(parent, child);
  return pathFromParent === "" || (!isAbsolute(pathFromParent) && pathFromParent !== ".." && !pathFromParent.startsWith(`..${sep}`));
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

async function verifyRunnerPaths({ codexPath, isolatedDir, projectDir, schemaPath, probePaths }) {
  const [canonicalCodex, canonicalIsolated, canonicalProject, canonicalSchema] = await Promise.all([
    canonicalExistingPath(codexPath, "file", true),
    canonicalExistingPath(isolatedDir, "directory"),
    canonicalExistingPath(projectDir, "directory"),
    canonicalExistingPath(schemaPath, "file"),
  ]);
  let canonicalProbePaths;
  if (probePaths !== undefined) {
    const [isolatedFile, outsideFile, projectFile] = await Promise.all([
      canonicalExistingPath(probePaths.isolatedFile, "file"),
      canonicalExistingPath(probePaths.outsideFile, "file"),
      canonicalExistingPath(probePaths.projectFile, "file"),
    ]);
    canonicalProbePaths = { isolatedFile, outsideFile, projectFile };
  }
  return {
    codexPath: canonicalCodex,
    isolatedDir: canonicalIsolated,
    projectDir: canonicalProject,
    schemaPath: canonicalSchema,
    probePaths: canonicalProbePaths,
  };
}

function sameCanonicalRunnerPaths(report, requested) {
  if (!report || typeof report !== "object" || Array.isArray(report)) return false;
  for (const key of ["codexPath", "isolatedDir", "projectDir", "schemaPath", "probePaths"]) {
    if (!Object.hasOwn(report, key)) return false;
  }
  if (["codexPath", "isolatedDir", "projectDir", "schemaPath"].some((key) => report[key] !== requested[key])) return false;
  if (requested.probePaths === undefined) return report.probePaths === undefined;
  return report.probePaths
    && typeof report.probePaths === "object"
    && !Array.isArray(report.probePaths)
    && ["isolatedFile", "outsideFile", "projectFile"].every((key) => Object.hasOwn(report.probePaths, key) && report.probePaths[key] === requested.probePaths[key]);
}

function validateThreadId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(value)) {
    throw codedError("CODEX_OUTPUT_INVALID");
  }
}

function objectWithKeys(value, required, allowed = required) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.includes(key));
}

function sizedString(value, maxLength) {
  return typeof value === "string" && value.length <= maxLength && /\S/u.test(value);
}

function validHttpsUrl(value) {
  if (typeof value !== "string" || value.length > 2_048 || !value.startsWith("https://")) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.username === ""
      && url.password === ""
      && url.hash === ""
      && url.hostname !== "";
  } catch {
    return false;
  }
}

function validDate(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (month < 1 || month > 12) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1];
}

function validDateRange(value) {
  return objectWithKeys(value, ["start", "end"])
    && validDate(value.start)
    && validDate(value.end);
}

function validStringOrNotProvided(value, maxLength) {
  return value === "not_provided" || sizedString(value, maxLength);
}

function validHotelFacts(value) {
  return objectWithKeys(value, [
    "propertyName", "address", "checkInDate", "checkOutDate", "travelers", "roomTypeOrBed",
    "availability", "priceAmount", "currency", "priceDisplay", "cancellationPolicy",
  ])
    && sizedString(value.propertyName, 200)
    && sizedString(value.address, 500)
    && validDate(value.checkInDate)
    && validDate(value.checkOutDate)
    && Number.isSafeInteger(value.travelers) && value.travelers >= 1 && value.travelers <= 100
    && sizedString(value.roomTypeOrBed, 300)
    && ["available", "unavailable", "unknown"].includes(value.availability)
    && (value.priceAmount === "not_provided" || (typeof value.priceAmount === "number" && Number.isFinite(value.priceAmount) && value.priceAmount >= 0 && value.priceAmount <= 1_000_000_000))
    && validStringOrNotProvided(value.currency, 32)
    && ["total", "per_night", "per_person", "not_provided"].includes(value.priceDisplay)
    && validStringOrNotProvided(value.cancellationPolicy, 2_000);
}

function validRestaurantFacts(value, attraction = false) {
  const keys = ["name", "address", "openInformation", "priceSnapshot", ...(attraction ? ["ticketType"] : [])];
  return objectWithKeys(value, keys)
    && sizedString(value.name, 200)
    && sizedString(value.address, 500)
    && validStringOrNotProvided(value.openInformation, 1_000)
    && validStringOrNotProvided(value.priceSnapshot, 1_000)
    && (!attraction || validStringOrNotProvided(value.ticketType, 300));
}

function validFacts(value, category) {
  if (category === "hotel") return validHotelFacts(value);
  if (category === "restaurant") return validRestaurantFacts(value);
  if (category === "attraction") return validRestaurantFacts(value, true);
  return false;
}

function validQueryContext(value) {
  if (!objectWithKeys(value, [], ["dates", "travelers", "roomOrTicket"])) return false;
  if (Object.hasOwn(value, "dates") && !validDateRange(value.dates)) return false;
  if (Object.hasOwn(value, "travelers") && (!Number.isSafeInteger(value.travelers) || value.travelers < 1 || value.travelers > 100)) return false;
  return !Object.hasOwn(value, "roomOrTicket") || sizedString(value.roomOrTicket, 300);
}

function validEvidence(value, category) {
  return objectWithKeys(value, ["sourceKind", "sourceName", "sourceUrl", "queryContext", "captureMethod", "facts"])
    && SOURCE_KINDS.has(value.sourceKind)
    && sizedString(value.sourceName, 300)
    && validHttpsUrl(value.sourceUrl)
    && validQueryContext(value.queryContext)
    && CAPTURE_METHODS.has(value.captureMethod)
    && validFacts(value.facts, category);
}

function validAliases(value) {
  return Array.isArray(value)
    && value.length <= 64
    && new Set(value).size === value.length
    && value.every((alias) => sizedString(alias, 128));
}

function validCandidate(value, category) {
  return objectWithKeys(value, ["category", "entity", "applicability", "recommendation", "evidence"])
    && value.category === category
    && objectWithKeys(value.entity, ["name", "address"])
    && sizedString(value.entity.name, 200)
    && sizedString(value.entity.address, 500)
    && objectWithKeys(value.applicability, ["dates", "travelers"])
    && validDateRange(value.applicability.dates)
    && Number.isSafeInteger(value.applicability.travelers)
    && value.applicability.travelers >= 1
    && value.applicability.travelers <= 100
    && objectWithKeys(value.recommendation, ["reason", "preferenceRevisionAliases", "feedbackAliases"])
    && sizedString(value.recommendation.reason, 2_000)
    && validAliases(value.recommendation.preferenceRevisionAliases)
    && validAliases(value.recommendation.feedbackAliases)
    && Array.isArray(value.evidence)
    && value.evidence.length >= 2
    && value.evidence.length <= 8
    && value.evidence.every((evidence) => validEvidence(evidence, category));
}

function validCompletedOutput(value) {
  return objectWithKeys(value, ["status", "category", "candidates"])
    && value.status === "completed"
    && CATEGORIES.has(value.category)
    && Array.isArray(value.candidates)
    && value.candidates.length >= 2
    && value.candidates.length <= 4
    && value.candidates.every((candidate) => validCandidate(candidate, value.category));
}

function validOwnerActionOutput(value) {
  if (objectWithKeys(value, ["status", "reason", "message"])) {
    return value.status === "needs_owner_action"
      && value.reason === "codex_auth_required"
      && value.message === CODEX_AUTH_MESSAGE;
  }
  return objectWithKeys(value, ["status", "reason", "message", "sourceHostname"])
    && value.status === "needs_owner_action"
    && SOURCE_OWNER_ACTION_REASONS.has(value.reason)
    && value.message === SOURCE_OWNER_ACTION_MESSAGE
    && typeof value.sourceHostname === "string"
    && value.sourceHostname.length <= 253
    && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/u.test(value.sourceHostname);
}

function validTravelOutput(value) {
  return validCompletedOutput(value) || validOwnerActionOutput(value);
}

function topLevelArgs(cwd) {
  return [
    "--search",
    "--sandbox", "read-only",
    "--ask-for-approval", "never",
    "--cd", cwd,
    "--strict-config",
    ...buildPermissionOverrides().flatMap((value) => ["-c", value]),
  ];
}

function executionArgs(schemaPath) {
  return [
    "--skip-git-repo-check",
    "--ignore-rules",
    "--ignore-user-config",
    "--json",
    "--output-schema", schemaPath,
    "-",
  ];
}

export function buildInitialArgs({ cwd, schemaPath }) {
  validateAbsolutePath(cwd, "CODEX_ISOLATION_UNAVAILABLE");
  validateAbsolutePath(schemaPath, "CODEX_OUTPUT_INVALID");
  return [...topLevelArgs(cwd), "exec", ...executionArgs(schemaPath)];
}

export function buildResumeArgs({ cwd, schemaPath, codexThreadId }) {
  validateAbsolutePath(cwd, "CODEX_ISOLATION_UNAVAILABLE");
  validateAbsolutePath(schemaPath, "CODEX_OUTPUT_INVALID");
  validateThreadId(codexThreadId);
  return [...topLevelArgs(cwd), "exec", "resume", codexThreadId, ...executionArgs(schemaPath)];
}

function parseStructuredText(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseJsonLines(stdout) {
  let codexThreadId;
  let output;
  let state = "thread";
  let webSearchSeen = false;
  let turnStartedSeen = false;
  let researchEventSeen = false;
  const lines = stdout.split(/\r?\n/u).filter((line) => line.trim());
  if (lines.length === 0) throw codedError("CODEX_OUTPUT_INVALID");
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw codedError("CODEX_OUTPUT_INVALID");
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) throw codedError("CODEX_OUTPUT_INVALID");
    if (!Object.hasOwn(event, "type") || typeof event.type !== "string") throw codedError("CODEX_OUTPUT_INVALID");
    if (event.type === "thread.started") {
      if (state !== "thread" || codexThreadId !== undefined || !Object.hasOwn(event, "thread_id")) {
        throw codedError("CODEX_OUTPUT_INVALID");
      }
      validateThreadId(event.thread_id);
      codexThreadId = event.thread_id;
      state = "session";
      continue;
    }
    if (event.type === "session_configured") {
      if (state !== "session"
        || !Object.hasOwn(event, "session_id") || event.session_id !== codexThreadId
        || !Object.hasOwn(event, "approval_policy") || event.approval_policy !== "never"
        || !Object.hasOwn(event, "active_permission_profile")
        || !event.active_permission_profile || typeof event.active_permission_profile !== "object" || Array.isArray(event.active_permission_profile)
        || !Object.hasOwn(event.active_permission_profile, "id")
        || event.active_permission_profile.id !== "travel_research") {
        throw codedError("CODEX_OUTPUT_INVALID");
      }
      state = "research";
      continue;
    }
    if (event.type === "turn.completed") {
      if (state !== "output") throw codedError("CODEX_OUTPUT_INVALID");
      state = "done";
      continue;
    }
    if (state === "thread" || state === "session" || state === "output" || state === "done") {
      throw codedError("CODEX_OUTPUT_INVALID");
    }
    if (event.type === "turn.started") {
      if (turnStartedSeen || researchEventSeen) throw codedError("CODEX_OUTPUT_INVALID");
      turnStartedSeen = true;
      continue;
    }
    researchEventSeen = true;
    if (event.type === "web_search_end") {
      webSearchSeen = true;
      continue;
    }
    if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
      if (!Object.hasOwn(event, "item")
        || !event.item || typeof event.item !== "object" || Array.isArray(event.item)
        || !Object.hasOwn(event.item, "type") || typeof event.item.type !== "string") {
        throw codedError("CODEX_OUTPUT_INVALID");
      }
      if (event.item.type === "reasoning") continue;
      if (event.item.type === "web_search") {
        if (event.type === "item.completed") webSearchSeen = true;
        continue;
      }
      if (event.item.type === "agent_message" && event.type === "item.completed") {
        if (!webSearchSeen || output !== undefined || !Object.hasOwn(event.item, "text") || typeof event.item.text !== "string") {
          throw codedError("CODEX_OUTPUT_INVALID");
        }
        output = parseStructuredText(event.item.text);
        if (!output) throw codedError("CODEX_OUTPUT_INVALID");
        state = "output";
        continue;
      }
    }
    throw codedError("CODEX_OUTPUT_INVALID");
  }
  if (state !== "done" || !codexThreadId || !webSearchSeen || !output) throw codedError("CODEX_OUTPUT_INVALID");
  return { codexThreadId, output };
}

function failureCode(stdout, stderr) {
  let structuredCode = "";
  for (const line of stdout.split(/\r?\n/u).slice(0, 100)) {
    if (line.length > 4_096) continue;
    try {
      const event = JSON.parse(line);
      if (event && typeof event === "object" && !Array.isArray(event)
        && Object.hasOwn(event, "type") && event.type === "error"
        && Object.hasOwn(event, "error") && event.error && typeof event.error === "object" && !Array.isArray(event.error)
        && Object.hasOwn(event.error, "code") && typeof event.error.code === "string") {
        structuredCode = event.error.code;
        break;
      }
    } catch {
      // Only structured JSONL error events are trusted from stdout.
    }
  }
  if (/(auth|login|credential|unauthori[sz]ed|401)/iu.test(structuredCode)
    || /(not authenticated|authentication required|not logged in|login required|unauthori[sz]ed|\b401\b)/iu.test(stderr.slice(0, 4_096))) {
    return "CODEX_NOT_AUTHENTICATED";
  }
  if (/(quota|usage|rate.?limit|credits?|429)/iu.test(structuredCode)
    || /(quota|usage limit|rate limit|credits?|too many requests|\b429\b)/iu.test(stderr.slice(0, 4_096))) {
    return "CODEX_USAGE_UNAVAILABLE";
  }
  return "CODEX_RESEARCH_FAILED";
}

export function createCodexRunner(options) {
  const {
    codexPath,
    isolatedDir,
    projectDir,
    schemaPath,
    spawnImpl = spawn,
    processKillImpl = process.kill.bind(process),
    probeIsolation = probeCodexIsolation,
    probeAdapter,
    probePaths,
    sourceEnv = process.env,
    activeTimeoutMs = 600_000,
    killGraceMs = 3_000,
    teardownTimeoutMs = 3_000,
    maxStdoutBytes = 4 * 1_024 * 1_024,
    maxStderrBytes = 64 * 1_024,
    maxJsonlLineBytes = 1 * 1_024 * 1_024,
    maxJsonlLines = 10_000,
    monotonicNow = () => performance.now(),
    initialState,
    validateOutput: customValidateOutput,
    pathVerifier = verifyRunnerPaths,
  } = options ?? {};

  validateAbsolutePath(codexPath, "CODEX_NOT_AVAILABLE");
  validateAbsolutePath(isolatedDir, "CODEX_ISOLATION_UNAVAILABLE");
  validateAbsolutePath(projectDir, "CODEX_ISOLATION_UNAVAILABLE");
  if (containsPath(projectDir, isolatedDir) || containsPath(isolatedDir, projectDir)) throw codedError(CODEX_ISOLATION_ERROR);
  validateAbsolutePath(schemaPath, "CODEX_OUTPUT_INVALID");
  if (typeof probeIsolation !== "function" || typeof pathVerifier !== "function") throw codedError(CODEX_ISOLATION_ERROR);
  if (typeof spawnImpl !== "function" || typeof processKillImpl !== "function" || typeof monotonicNow !== "function"
    || (customValidateOutput !== undefined && typeof customValidateOutput !== "function")) {
    throw codedError("CODEX_RESEARCH_FAILED");
  }
  if (!Number.isSafeInteger(activeTimeoutMs) || activeTimeoutMs <= 0) throw codedError("CODEX_RESEARCH_TIMEOUT");
  for (const value of [killGraceMs, teardownTimeoutMs]) {
    if (!Number.isSafeInteger(value) || value < 0) throw codedError("CODEX_RESEARCH_TIMEOUT");
  }
  for (const value of [maxStdoutBytes, maxStderrBytes, maxJsonlLineBytes, maxJsonlLines]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw codedError("CODEX_RESEARCH_FAILED");
  }
  if (initialState !== undefined) {
    if (!objectWithKeys(initialState, ["codexThreadId", "correctionUsed", "activeDurationMs"])
      || typeof initialState.correctionUsed !== "boolean"
      || typeof initialState.activeDurationMs !== "number" || !Number.isFinite(initialState.activeDurationMs)
      || initialState.activeDurationMs < 0 || initialState.activeDurationMs > activeTimeoutMs) {
      throw codedError("CODEX_RESEARCH_FAILED");
    }
    try {
      validateThreadId(initialState.codexThreadId);
    } catch {
      throw codedError("CODEX_RESEARCH_FAILED");
    }
  }

  const environment = minimalCodexEnvironment(sourceEnv);
  const validateOutput = customValidateOutput === undefined
    ? validTravelOutput
    : async (value) => validTravelOutput(value) && await customValidateOutput(value) === true;
  let activeDurationMs = initialState?.activeDurationMs ?? 0;
  let initialStarted = initialState !== undefined;
  let boundThreadId = initialState?.codexThreadId;
  let correctionUsed = initialState?.correctionUsed ?? false;
  let inFlight = false;
  let poisoned = false;
  let lastClock = -Infinity;

  function now() {
    const value = monotonicNow();
    if (typeof value !== "number" || !Number.isFinite(value)) throw codedError("CODEX_RESEARCH_FAILED");
    lastClock = Math.max(lastClock, value);
    return lastClock;
  }

  function state() {
    return { codexThreadId: boundThreadId, correctionUsed, activeDurationMs };
  }

  function bindThread(codexThreadId) {
    validateThreadId(codexThreadId);
    if (boundThreadId && boundThreadId !== codexThreadId) throw codedError("CODEX_OUTPUT_INVALID");
    boundThreadId ??= codexThreadId;
  }

  function remainingMs(operation) {
    return activeTimeoutMs - operation.activeBefore - Math.max(0, now() - operation.startedAt);
  }

  async function withinBudget(promise, operation) {
    const remaining = remainingMs(operation);
    if (remaining <= 0) throw codedError("CODEX_RESEARCH_TIMEOUT");
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(codedError("CODEX_RESEARCH_TIMEOUT")), remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function verifyPaths(operation) {
    const requested = { codexPath, isolatedDir, projectDir, schemaPath, probePaths };
    try {
      const canonical = await withinBudget(Promise.resolve().then(() => pathVerifier(requested)), operation);
      if (!sameCanonicalRunnerPaths(canonical, requested)) throw new Error("invalid canonical paths");
      if (containsPath(canonical.projectDir, canonical.isolatedDir) || containsPath(canonical.isolatedDir, canonical.projectDir)) {
        throw new Error("overlapping canonical boundary");
      }
    } catch (error) {
      if (error?.code === "CODEX_RESEARCH_TIMEOUT") throw error;
      throw codedError(CODEX_ISOLATION_ERROR);
    }
  }

  async function verifyIsolation(operation) {
    try {
      const remaining = remainingMs(operation);
      if (remaining <= 0) throw codedError("CODEX_RESEARCH_TIMEOUT");
      const report = await withinBudget(Promise.resolve().then(() => probeIsolation({
        codexPath,
        isolatedDir,
        projectDir,
        probeAdapter,
        probePaths,
        spawnImpl,
        processKillImpl,
        sourceEnv: environment,
        permissionOverrides: buildPermissionOverrides(),
        probeTotalTimeoutMs: Math.max(1, Math.floor(remaining)),
      })), operation);
      const required = [
        "isolatedDirectoryReadable",
        "outsideDirectoryUnreadable",
        "projectDirectoryUnreadable",
        "httpsNetworkAvailable",
        "authenticationAvailable",
        "persistenceAvailable",
      ];
      if (!report || typeof report !== "object" || Array.isArray(report) || required.some((check) => !Object.hasOwn(report, check) || report[check] !== true)) {
        throw new Error("incomplete isolation evidence");
      }
    } catch (error) {
      if (error?.processTreeUnconfirmed === true) poisoned = true;
      if (error?.code === "CODEX_RESEARCH_TIMEOUT") throw error;
      throw codedError(CODEX_ISOLATION_ERROR);
    }
  }

  async function execute(args, prompt, expectedThreadId, operation) {
    await verifyPaths(operation);
    await verifyIsolation(operation);
    const processTimeoutMs = remainingMs(operation);
    if (processTimeoutMs <= 0) throw codedError("CODEX_RESEARCH_TIMEOUT");
    return new Promise((resolve, reject) => {
      let child;
      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutLineBytes = 0;
      let stdoutLines = 0;
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      let settled = false;
      let terminationError;
      let killTimer;
      let timeoutTimer;
      let teardownTimer;

      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        clearTimeout(killTimer);
        clearTimeout(teardownTimer);
        stdout = "";
        stderr = "";
        if (error) reject(error);
        else resolve(value);
      };
      const signal = (name) => {
        try {
          if (!Number.isSafeInteger(child.pid) || child.pid <= 0) throw new Error("invalid child pid");
          processKillImpl(-child.pid, name);
        } catch {
          // The final teardown deadline still bounds a child that rejects a signal.
        }
      };
      const terminate = (error) => {
        if (terminationError || settled) return;
        terminationError = error;
        signal("SIGTERM");
        killTimer = setTimeout(() => signal("SIGKILL"), killGraceMs);
        teardownTimer = setTimeout(() => {
          poisoned = true;
          finish(error);
        }, killGraceMs + teardownTimeoutMs);
      };
      const collectStdout = (chunk) => {
        if (terminationError) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes += buffer.length;
        for (const byte of buffer) {
          if (byte === 10) {
            stdoutLines += 1;
            stdoutLineBytes = 0;
          } else {
            stdoutLineBytes += 1;
          }
        }
        if (stdoutBytes > maxStdoutBytes || stdoutLineBytes > maxJsonlLineBytes || stdoutLines > maxJsonlLines) {
          terminate(codedError("CODEX_OUTPUT_INVALID"));
          return;
        }
        stdout += stdoutDecoder.write(buffer);
      };
      const collectStderr = (chunk) => {
        if (terminationError) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stderrBytes += buffer.length;
        if (stderrBytes > maxStderrBytes) {
          terminate(codedError("CODEX_RESEARCH_FAILED"));
          return;
        }
        stderr += stderrDecoder.write(buffer);
      };

      try {
        child = spawnImpl(codexPath, args, { shell: false, detached: true, cwd: isolatedDir, env: environment });
      } catch (error) {
        finish(codedError(error?.code === "ENOENT" ? "CODEX_NOT_AVAILABLE" : "CODEX_RESEARCH_FAILED"));
        return;
      }

      child.stdout?.on("data", collectStdout);
      child.stderr?.on("data", collectStderr);
      child.stdout?.on("error", () => terminate(codedError("CODEX_RESEARCH_FAILED")));
      child.stderr?.on("error", () => terminate(codedError("CODEX_RESEARCH_FAILED")));
      child.stdin?.on?.("error", () => terminate(codedError("CODEX_RESEARCH_FAILED")));
      child.on("error", (error) => {
        if (!terminationError) {
          finish(codedError(error?.code === "ENOENT" ? "CODEX_NOT_AVAILABLE" : "CODEX_RESEARCH_FAILED"));
        }
      });
      child.on("close", (code) => {
        if (terminationError) {
          finish(terminationError);
          return;
        }
        stdout += stdoutDecoder.end();
        stderr += stderrDecoder.end();
        if (stdoutLines + (stdoutLineBytes > 0 ? 1 : 0) > maxJsonlLines) {
          finish(codedError("CODEX_OUTPUT_INVALID"));
          return;
        }
        if (code !== 0) {
          finish(codedError(failureCode(stdout, stderr)));
          return;
        }
        try {
          const parsed = parseJsonLines(stdout);
          const codexThreadId = parsed.codexThreadId ?? expectedThreadId;
          if (!codexThreadId) throw codedError("CODEX_OUTPUT_INVALID");
          validateThreadId(codexThreadId);
          if (expectedThreadId && codexThreadId !== expectedThreadId) throw codedError("CODEX_OUTPUT_INVALID");
          finish(undefined, { codexThreadId, output: parsed.output });
        } catch {
          finish(codedError("CODEX_OUTPUT_INVALID"));
        }
      });

      timeoutTimer = setTimeout(() => terminate(codedError("CODEX_RESEARCH_TIMEOUT")), processTimeoutMs);

      try {
        child.stdin.end(prompt);
      } catch {
        terminate(codedError("CODEX_RESEARCH_FAILED"));
      }
    });
  }

  async function outputIsValid(value, operation) {
    try {
      const result = await withinBudget(Promise.resolve().then(() => validateOutput(value)), operation);
      return result === true;
    } catch (error) {
      if (error?.code === "CODEX_RESEARCH_TIMEOUT") throw error;
      return false;
    }
  }

  async function runWithCorrection(args, prompt, expectedThreadId, operation) {
    if (expectedThreadId) bindThread(expectedThreadId);
    const first = await execute(args, prompt, expectedThreadId, operation);
    bindThread(first.codexThreadId);
    if (await outputIsValid(first.output, operation)) return first;
    if (correctionUsed) throw codedError("CODEX_OUTPUT_INVALID");
    correctionUsed = true;
    const corrected = await execute(
      buildResumeArgs({ cwd: isolatedDir, schemaPath, codexThreadId: first.codexThreadId }),
      FORMAT_CORRECTION_PROMPT,
      first.codexThreadId,
      operation,
    );
    if (!await outputIsValid(corrected.output, operation)) throw codedError("CODEX_OUTPUT_INVALID");
    return corrected;
  }

  async function runExclusive(task) {
    if (inFlight) throw codedError("CODEX_RESEARCH_FAILED");
    if (poisoned) throw codedError("CODEX_RESEARCH_FAILED");
    if (activeDurationMs >= activeTimeoutMs) throw codedError("CODEX_RESEARCH_TIMEOUT");
    const startedAt = now();
    inFlight = true;
    const operation = { activeBefore: activeDurationMs, startedAt };
    let result;
    let failure;
    try {
      result = await task(operation);
    } catch (error) {
      failure = error;
    } finally {
      let finishedAt = operation.startedAt;
      try {
        finishedAt = now();
      } catch (error) {
        failure ??= error;
      }
      const elapsed = Math.max(0, finishedAt - operation.startedAt);
      activeDurationMs = Math.min(activeTimeoutMs, operation.activeBefore + elapsed);
      inFlight = false;
      if (!failure && elapsed > activeTimeoutMs - operation.activeBefore) failure = codedError("CODEX_RESEARCH_TIMEOUT");
    }
    if (failure) throw failure;
    return { ...result, activeDurationMs, state: state() };
  }

  return {
    async runInitial(input) {
      const prompt = input?.prompt;
      if (initialStarted || boundThreadId || typeof prompt !== "string") throw codedError("CODEX_RESEARCH_FAILED");
      initialStarted = true;
      return runExclusive((operation) => runWithCorrection(
        buildInitialArgs({ cwd: isolatedDir, schemaPath }),
        prompt,
        undefined,
        operation,
      ));
    },
    async resume(input) {
      const codexThreadId = input?.codexThreadId;
      const prompt = input?.prompt;
      return runExclusive((operation) => {
        validateThreadId(codexThreadId);
        if (typeof prompt !== "string") throw codedError("CODEX_RESEARCH_FAILED");
        return runWithCorrection(
          buildResumeArgs({ cwd: isolatedDir, schemaPath, codexThreadId }),
          prompt,
          codexThreadId,
          operation,
        );
      });
    },
  };
}
