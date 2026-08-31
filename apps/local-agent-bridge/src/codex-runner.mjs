import { spawn } from "node:child_process";
import { isAbsolute, normalize, relative, sep } from "node:path";

import {
  buildPermissionOverrides,
  CODEX_ISOLATION_ERROR,
  minimalCodexEnvironment,
  probeCodexIsolation,
} from "./codex-isolation.mjs";

const FORMAT_CORRECTION_PROMPT = "上次输出未通过结构化格式校验。请严格按照原任务和输出 Schema 重新输出完整 JSON；不要添加新事实、路径、凭据或日志。";

const CATEGORIES = new Set(["hotel", "restaurant", "attraction"]);
const OWNER_ACTION_REASONS = new Set([
  "codex_auth_required",
  "source_login_required",
  "source_captcha",
  "source_risk_control",
]);
const OWNER_ACTION_MESSAGES = new Set([
  "请在 Codex 应用中恢复登录后返回此页面继续。",
  "请在来源网站中完成所需操作后返回此页面继续。",
]);
const VERIFICATION_METHODS = new Set(["web_search", "source_page"]);

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
  return typeof value === "string" && value.length >= 1 && value.length <= maxLength;
}

function validHttpsUrl(value) {
  if (typeof value !== "string" || !value.startsWith("https://")) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function validVerification(value) {
  return objectWithKeys(value, ["checkedAt", "method"])
    && typeof value.checkedAt === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.checkedAt)
    && Number.isFinite(Date.parse(value.checkedAt))
    && VERIFICATION_METHODS.has(value.method);
}

function validEvidence(value) {
  return objectWithKeys(value, ["sourceUrl", "title", "summary", "verification"])
    && validHttpsUrl(value.sourceUrl)
    && sizedString(value.title, 300)
    && sizedString(value.summary, 2_000)
    && validVerification(value.verification);
}

function validCandidate(value, category) {
  return objectWithKeys(value, ["category", "name", "evidence"])
    && value.category === category
    && sizedString(value.name, 200)
    && Array.isArray(value.evidence)
    && value.evidence.length >= 2
    && value.evidence.every(validEvidence);
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
  return objectWithKeys(value, ["status", "reason", "message"], ["status", "reason", "message", "sourceHostname"])
    && value.status === "needs_owner_action"
    && OWNER_ACTION_REASONS.has(value.reason)
    && OWNER_ACTION_MESSAGES.has(value.message)
    && (!Object.hasOwn(value, "sourceHostname")
      || (sizedString(value.sourceHostname, 253) && /^[A-Za-z0-9.-]+$/.test(value.sourceHostname)));
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
    const eventThreadId = event.thread_id ?? event.threadId ?? event.task_id ?? event.taskId ?? event.session_id;
    if (typeof eventThreadId === "string") codexThreadId = eventThreadId;

    if (event.type === "item.completed" && event.item?.type === "agent_message") {
      output = parseStructuredText(event.item.text) ?? output;
    } else if (["final.response", "result", "turn.completed"].includes(event.type)) {
      output = parseStructuredText(event.output)
        ?? parseStructuredText(event.result)
        ?? parseStructuredText(event.final_output)
        ?? output;
    }
  }
  return { codexThreadId, output };
}

function failureCode(text) {
  if (/(not authenticated|authentication required|not logged in|login required|unauthori[sz]ed|\b401\b)/iu.test(text)) {
    return "CODEX_NOT_AUTHENTICATED";
  }
  if (/(quota|usage limit|rate limit|credits?|too many requests|\b429\b)/iu.test(text)) {
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
    probeIsolation = probeCodexIsolation,
    probeAdapter,
    probePaths,
    sourceEnv = process.env,
    activeTimeoutMs = 600_000,
    killGraceMs = 3_000,
    validateOutput: customValidateOutput,
  } = options ?? {};

  validateAbsolutePath(codexPath, "CODEX_NOT_AVAILABLE");
  validateAbsolutePath(isolatedDir, "CODEX_ISOLATION_UNAVAILABLE");
  validateAbsolutePath(projectDir, "CODEX_ISOLATION_UNAVAILABLE");
  if (containsPath(projectDir, isolatedDir) || containsPath(isolatedDir, projectDir)) throw codedError(CODEX_ISOLATION_ERROR);
  validateAbsolutePath(schemaPath, "CODEX_OUTPUT_INVALID");
  if (typeof probeIsolation !== "function") throw codedError(CODEX_ISOLATION_ERROR);
  if (typeof spawnImpl !== "function" || (customValidateOutput !== undefined && typeof customValidateOutput !== "function")) {
    throw codedError("CODEX_RESEARCH_FAILED");
  }
  if (!Number.isSafeInteger(activeTimeoutMs) || activeTimeoutMs <= 0) throw codedError("CODEX_RESEARCH_TIMEOUT");
  if (!Number.isSafeInteger(killGraceMs) || killGraceMs < 0) throw codedError("CODEX_RESEARCH_TIMEOUT");

  const environment = minimalCodexEnvironment(sourceEnv);
  const validateOutput = customValidateOutput === undefined
    ? validTravelOutput
    : async (value) => validTravelOutput(value) && await customValidateOutput(value) === true;
  let activeDurationMs = 0;
  let initialStarted = false;
  let boundThreadId;
  let correctionUsed = false;

  function bindThread(codexThreadId) {
    validateThreadId(codexThreadId);
    if (boundThreadId && boundThreadId !== codexThreadId) throw codedError("CODEX_OUTPUT_INVALID");
    boundThreadId ??= codexThreadId;
  }

  async function verifyIsolation() {
    try {
      const report = await probeIsolation({
        codexPath,
        isolatedDir,
        projectDir,
        probeAdapter,
        probePaths,
        sourceEnv: environment,
        permissionOverrides: buildPermissionOverrides(),
      });
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
    } catch {
      throw codedError(CODEX_ISOLATION_ERROR);
    }
  }

  async function execute(args, prompt, expectedThreadId) {
    await verifyIsolation();
    const remainingMs = activeTimeoutMs - activeDurationMs;
    if (remainingMs <= 0) return Promise.reject(codedError("CODEX_RESEARCH_TIMEOUT"));
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      let child;
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      let killTimer;
      let timeoutTimer;

      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        clearTimeout(killTimer);
        activeDurationMs += Math.max(0, Date.now() - startedAt);
        stdout = "";
        stderr = "";
        if (error) reject(error);
        else resolve(value);
      };

      try {
        child = spawnImpl(codexPath, args, { shell: false, cwd: isolatedDir, env: environment });
      } catch (error) {
        finish(codedError(error?.code === "ENOENT" ? "CODEX_NOT_AVAILABLE" : "CODEX_RESEARCH_FAILED"));
        return;
      }

      child.stdout?.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
      child.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
      child.stdin?.on?.("error", () => finish(codedError("CODEX_RESEARCH_FAILED")));
      child.on("error", (error) => {
        finish(codedError(error?.code === "ENOENT" ? "CODEX_NOT_AVAILABLE" : "CODEX_RESEARCH_FAILED"));
      });
      child.on("close", (code) => {
        if (timedOut) {
          finish(codedError("CODEX_RESEARCH_TIMEOUT"));
          return;
        }
        if (code !== 0) {
          finish(codedError(failureCode(`${stderr}\n${stdout}`)));
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

      timeoutTimer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          if (settled) return;
          child.kill("SIGKILL");
          finish(codedError("CODEX_RESEARCH_TIMEOUT"));
        }, killGraceMs);
      }, remainingMs);

      try {
        child.stdin.end(prompt);
      } catch {
        child.kill?.("SIGTERM");
        finish(codedError("CODEX_RESEARCH_FAILED"));
      }
    });
  }

  async function outputIsValid(value) {
    const remainingMs = activeTimeoutMs - activeDurationMs;
    if (remainingMs <= 0) throw codedError("CODEX_RESEARCH_TIMEOUT");
    const startedAt = Date.now();
    let timeout;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => validateOutput(value)),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(codedError("CODEX_RESEARCH_TIMEOUT")), remainingMs);
        }),
      ]);
      return result === true;
    } catch (error) {
      if (error?.code === "CODEX_RESEARCH_TIMEOUT") throw error;
      return false;
    } finally {
      clearTimeout(timeout);
      activeDurationMs += Math.max(0, Date.now() - startedAt);
    }
  }

  async function runWithCorrection(args, prompt, expectedThreadId) {
    if (expectedThreadId) bindThread(expectedThreadId);
    const first = await execute(args, prompt, expectedThreadId);
    bindThread(first.codexThreadId);
    if (await outputIsValid(first.output)) {
      return { ...first, activeDurationMs };
    }
    if (correctionUsed) throw codedError("CODEX_OUTPUT_INVALID");
    correctionUsed = true;
    const corrected = await execute(
      buildResumeArgs({ cwd: isolatedDir, schemaPath, codexThreadId: first.codexThreadId }),
      FORMAT_CORRECTION_PROMPT,
      first.codexThreadId,
    );
    if (!await outputIsValid(corrected.output)) throw codedError("CODEX_OUTPUT_INVALID");
    return { ...corrected, activeDurationMs };
  }

  return {
    async runInitial({ prompt }) {
      if (initialStarted || boundThreadId || typeof prompt !== "string") throw codedError("CODEX_RESEARCH_FAILED");
      initialStarted = true;
      return runWithCorrection(buildInitialArgs({ cwd: isolatedDir, schemaPath }), prompt);
    },
    async resume({ codexThreadId, prompt }) {
      validateThreadId(codexThreadId);
      if (typeof prompt !== "string") throw codedError("CODEX_RESEARCH_FAILED");
      return runWithCorrection(
        buildResumeArgs({ cwd: isolatedDir, schemaPath, codexThreadId }),
        prompt,
        codexThreadId,
      );
    },
  };
}
