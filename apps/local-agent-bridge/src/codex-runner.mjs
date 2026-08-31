import { spawn } from "node:child_process";
import { isAbsolute, normalize } from "node:path";

import { buildPermissionOverrides, minimalCodexEnvironment } from "./codex-isolation.mjs";

const FORMAT_CORRECTION_PROMPT = "上次输出未通过结构化格式校验。请严格按照原任务和输出 Schema 重新输出完整 JSON；不要添加新事实、路径、凭据或日志。";

function codedError(code) {
  return Object.assign(new Error(code), { code });
}

function validateAbsolutePath(value, code) {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value) throw codedError(code);
}

function validateThreadId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(value)) {
    throw codedError("CODEX_OUTPUT_INVALID");
  }
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
    schemaPath,
    spawnImpl = spawn,
    sourceEnv = process.env,
    activeTimeoutMs = 600_000,
    killGraceMs = 3_000,
    validateOutput = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value)),
  } = options ?? {};

  validateAbsolutePath(codexPath, "CODEX_NOT_AVAILABLE");
  validateAbsolutePath(isolatedDir, "CODEX_ISOLATION_UNAVAILABLE");
  validateAbsolutePath(schemaPath, "CODEX_OUTPUT_INVALID");
  if (typeof spawnImpl !== "function" || typeof validateOutput !== "function") throw codedError("CODEX_RESEARCH_FAILED");
  if (!Number.isSafeInteger(activeTimeoutMs) || activeTimeoutMs <= 0) throw codedError("CODEX_RESEARCH_TIMEOUT");
  if (!Number.isSafeInteger(killGraceMs) || killGraceMs < 0) throw codedError("CODEX_RESEARCH_TIMEOUT");

  const environment = minimalCodexEnvironment(sourceEnv);
  let activeDurationMs = 0;
  let initialStarted = false;

  function execute(args, prompt, expectedThreadId) {
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
    const first = await execute(args, prompt, expectedThreadId);
    if (await outputIsValid(first.output)) {
      return { ...first, activeDurationMs };
    }
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
      if (initialStarted || typeof prompt !== "string") throw codedError("CODEX_RESEARCH_FAILED");
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
