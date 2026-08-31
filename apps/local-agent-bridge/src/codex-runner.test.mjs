import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildInitialArgs,
  buildResumeArgs,
  createCodexRunner,
} from "./codex-runner.mjs";

const TOP_LEVEL_ARGS = [
  "--search",
  "--sandbox", "read-only",
  "--ask-for-approval", "never",
  "--cd", "/isolated",
  "--strict-config",
  "-c", 'permissions.travel_research.filesystem={":minimal"="read",":workspace_roots"="read"}',
  "-c", "permissions.travel_research.network.enabled=true",
  "-c", 'default_permissions="travel_research"',
];

const VALID_OUTPUT = {
  status: "completed",
  category: "hotel",
  candidates: [
    {
      category: "hotel",
      name: "Hotel One",
      evidence: [
        { sourceUrl: "https://one.example/hotel", title: "One", summary: "Summary one", verification: { checkedAt: "2026-08-31T00:00:00.000Z", method: "source_page" } },
        { sourceUrl: "https://two.example/hotel", title: "Two", summary: "Summary two", verification: { checkedAt: "2026-08-31T00:01:00.000Z", method: "web_search" } },
      ],
    },
    {
      category: "hotel",
      name: "Hotel Two",
      evidence: [
        { sourceUrl: "https://three.example/hotel", title: "Three", summary: "Summary three", verification: { checkedAt: "2026-08-31T00:02:00.000Z", method: "source_page" } },
        { sourceUrl: "https://four.example/hotel", title: "Four", summary: "Summary four", verification: { checkedAt: "2026-08-31T00:03:00.000Z", method: "web_search" } },
      ],
    },
  ],
};

const COMPLETE_ISOLATION_REPORT = {
  isolatedDirectoryReadable: true,
  outsideDirectoryUnreadable: true,
  projectDirectoryUnreadable: true,
  httpsNetworkAvailable: true,
  authenticationAvailable: true,
  persistenceAvailable: true,
};

function jsonl(threadId, output = VALID_OUTPUT) {
  return [
    JSON.stringify({ type: "thread.started", thread_id: threadId }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(output) } }),
    "",
  ].join("\n");
}

function createFakeSpawn(outcomes) {
  const calls = [];
  const spawnImpl = (executable, args, options) => {
    const outcome = outcomes[calls.length] || {};
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.signals = [];
    const call = { executable, args, options, stdin: "", child };
    child.stdin = {
      end(value = "") { call.stdin += String(value); },
      write(value) { call.stdin += String(value); return true; },
    };
    child.kill = (signal) => {
      child.signals.push(signal);
      if (outcome.closeOnSignal === signal) queueMicrotask(() => child.emit("close", null, signal));
      return true;
    };
    calls.push(call);
    queueMicrotask(() => {
      if (outcome.spawnError) {
        child.emit("error", Object.assign(new Error("raw spawn failure"), { code: outcome.spawnError }));
        return;
      }
      if (outcome.stdout !== undefined) child.stdout.emit("data", Buffer.from(outcome.stdout));
      if (outcome.stderr !== undefined) child.stderr.emit("data", Buffer.from(outcome.stderr));
      if (!outcome.hang) child.emit("close", outcome.code ?? 0, null);
    });
    return child;
  };
  return { calls, spawnImpl };
}

function makeRunner(fake, overrides = {}) {
  return createCodexRunner({
    codexPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
    isolatedDir: "/isolated",
    projectDir: "/project",
    schemaPath: "/schema.json",
    spawnImpl: fake.spawnImpl,
    probeIsolation: async () => COMPLETE_ISOLATION_REPORT,
    sourceEnv: {
      PATH: "/usr/bin:/bin",
      HOME: "/Users/owner",
      CODEX_HOME: "/Users/owner/.codex",
      LANG: "zh_CN.UTF-8",
      HTTPS_PROXY: "http://proxy.example:8080",
      CLOUDBASE_SECRET_KEY: "must-not-leak",
      AWS_ACCESS_KEY_ID: "must-not-leak",
      BRIDGE_PAIRING_CODE: "must-not-leak",
    },
    validateOutput: (value) => value?.status === "completed" && value.candidates?.length >= 2,
    ...overrides,
  });
}

test("initial argv fixes every security flag and its order", () => {
  assert.deepEqual(buildInitialArgs({ cwd: "/isolated", schemaPath: "/schema.json" }), [
    "--search",
    "--sandbox", "read-only",
    "--ask-for-approval", "never",
    "--cd", "/isolated",
    "--strict-config",
    "-c", 'permissions.travel_research.filesystem={":minimal"="read",":workspace_roots"="read"}',
    "-c", "permissions.travel_research.network.enabled=true",
    "-c", 'default_permissions="travel_research"',
    "exec",
    "--skip-git-repo-check",
    "--ignore-rules",
    "--ignore-user-config",
    "--json",
    "--output-schema", "/schema.json",
    "-",
  ]);
});

test("resume reuses the identical top-level gate and the same Codex thread", () => {
  assert.deepEqual(buildResumeArgs({ cwd: "/isolated", schemaPath: "/schema.json", codexThreadId: "thread-123" }), [
    ...TOP_LEVEL_ARGS,
    "exec", "resume", "thread-123",
    "--skip-git-repo-check",
    "--ignore-rules",
    "--ignore-user-config",
    "--json",
    "--output-schema", "/schema.json",
    "-",
  ]);
});

test("runner spawns a controlled absolute binary in the isolated directory and sends prompt only on stdin", async () => {
  const fake = createFakeSpawn([{ stdout: jsonl("thread-1") }]);
  const runner = makeRunner(fake);

  const result = await runner.runInitial({ prompt: "untrusted travel context" });

  assert.deepEqual(result.output, VALID_OUTPUT);
  assert.equal(result.codexThreadId, "thread-1");
  assert.equal(Number.isFinite(result.activeDurationMs), true);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].executable, "/Applications/ChatGPT.app/Contents/Resources/codex");
  assert.equal(fake.calls[0].stdin, "untrusted travel context");
  assert.equal(fake.calls[0].options.shell, false);
  assert.equal(fake.calls[0].options.cwd, "/isolated");
  assert.deepEqual(fake.calls[0].options.env, {
    PATH: "/usr/bin:/bin",
    HOME: "/Users/owner",
    CODEX_HOME: "/Users/owner/.codex",
    LANG: "zh_CN.UTF-8",
    HTTPS_PROXY: "http://proxy.example:8080",
  });
  assert.equal(fake.calls[0].args.includes("--ephemeral"), false);
  assert.equal(fake.calls[0].args.includes("untrusted travel context"), false);
});

test("runner awaits a complete isolation probe before every Codex spawn", async () => {
  const fake = createFakeSpawn([{ stdout: jsonl("thread-1") }]);
  const probeCalls = [];
  let releaseProbe;
  const runner = makeRunner(fake, {
    probeIsolation: async (request) => {
      probeCalls.push(request);
      return new Promise((resolve) => { releaseProbe = () => resolve(COMPLETE_ISOLATION_REPORT); });
    },
  });

  const running = runner.runInitial({ prompt: "private" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.calls.length, 0);
  assert.equal(probeCalls.length, 1);
  assert.equal(probeCalls[0].codexPath, "/Applications/ChatGPT.app/Contents/Resources/codex");
  assert.equal(probeCalls[0].isolatedDir, "/isolated");
  assert.equal(probeCalls[0].projectDir, "/project");
  assert.deepEqual(probeCalls[0].sourceEnv, {
    PATH: "/usr/bin:/bin",
    HOME: "/Users/owner",
    CODEX_HOME: "/Users/owner/.codex",
    LANG: "zh_CN.UTF-8",
    HTTPS_PROXY: "http://proxy.example:8080",
  });
  releaseProbe();
  await running;
  assert.equal(fake.calls.length, 1);
});

test("runner fails closed when isolation evidence is missing, failed or uncertain", async () => {
  for (const probeIsolation of [
    undefined,
    async () => undefined,
    async () => ({ ...COMPLETE_ISOLATION_REPORT, projectDirectoryUnreadable: false }),
    async () => Object.create(COMPLETE_ISOLATION_REPORT),
    async () => { throw new Error("raw probe path /private/project"); },
  ]) {
    const fake = createFakeSpawn([{ stdout: jsonl("thread-1") }]);
    const runner = makeRunner(fake, { probeIsolation });
    await assert.rejects(runner.runInitial({ prompt: "private" }), (error) => {
      assert.equal(error.code, "CODEX_ISOLATION_UNAVAILABLE");
      assert.equal(error.message, "CODEX_ISOLATION_UNAVAILABLE");
      assert.equal(JSON.stringify(error).includes("/private/project"), false);
      return true;
    });
    assert.equal(fake.calls.length, 0);
  }
  const fake = createFakeSpawn([]);
  assert.throws(() => makeRunner(fake, { probeIsolation: null }), { code: "CODEX_ISOLATION_UNAVAILABLE" });
});

test("public resume returns the same safe result shape without exposing JSONL", async () => {
  const fake = createFakeSpawn([{ stdout: jsonl("thread-1", { ...VALID_OUTPUT, category: "restaurant", candidates: VALID_OUTPUT.candidates.map((candidate) => ({ ...candidate, category: "restaurant" })) }) }]);
  const runner = makeRunner(fake, { validateOutput: (value) => value?.status === "completed" });

  const result = await runner.resume({ codexThreadId: "thread-1", prompt: "continue after owner action" });

  assert.deepEqual(Object.keys(result).sort(), ["activeDurationMs", "codexThreadId", "output"]);
  assert.equal(result.codexThreadId, "thread-1");
  assert.equal(fake.calls[0].stdin, "continue after owner action");
  assert.deepEqual(fake.calls[0].args, buildResumeArgs({ cwd: "/isolated", schemaPath: "/schema.json", codexThreadId: "thread-1" }));
});

test("invalid structured output is corrected exactly once on the same thread", async () => {
  const fake = createFakeSpawn([
    { stdout: jsonl("thread-1", { status: "completed", candidates: [] }) },
    { stdout: jsonl("thread-1") },
  ]);
  const runner = makeRunner(fake);

  const result = await runner.runInitial({ prompt: "original private context" });

  assert.deepEqual(result.output, VALID_OUTPUT);
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(fake.calls[1].args, buildResumeArgs({ cwd: "/isolated", schemaPath: "/schema.json", codexThreadId: "thread-1" }));
  assert.equal(fake.calls[1].stdin, "上次输出未通过结构化格式校验。请严格按照原任务和输出 Schema 重新输出完整 JSON；不要添加新事实、路径、凭据或日志。");
  assert.equal(fake.calls[1].stdin.includes("original private context"), false);
});

test("the built-in validator accepts both strict output variants without a custom validator", async () => {
  const needsOwnerAction = {
    status: "needs_owner_action",
    reason: "source_captcha",
    message: "请在来源网站中完成所需操作后返回此页面继续。",
    sourceHostname: "tickets.example.com",
  };
  for (const output of [VALID_OUTPUT, needsOwnerAction]) {
    const fake = createFakeSpawn([{ stdout: jsonl("thread-1", output) }]);
    const runner = makeRunner(fake, { validateOutput: undefined });
    assert.deepEqual((await runner.runInitial({ prompt: "private" })).output, output);
    assert.equal(fake.calls.length, 1);
  }
});

test("the built-in validator corrects an invalid default output once on the same thread", async () => {
  const fake = createFakeSpawn([
    { stdout: jsonl("thread-1", { status: "completed", category: "hotel", candidates: [] }) },
    { stdout: jsonl("thread-1", VALID_OUTPUT) },
  ]);
  const runner = makeRunner(fake, { validateOutput: undefined });

  assert.deepEqual((await runner.runInitial({ prompt: "private" })).output, VALID_OUTPUT);
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(fake.calls[1].args, buildResumeArgs({ cwd: "/isolated", schemaPath: "/schema.json", codexThreadId: "thread-1" }));
});

test("the built-in validator rejects enum, count, HTTPS, required-field and extra-field violations", async () => {
  const wrongCategory = structuredClone(VALID_OUTPUT);
  wrongCategory.category = "flight";
  wrongCategory.candidates.forEach((candidate) => { candidate.category = "flight"; });
  const tooFewCandidates = { ...VALID_OUTPUT, candidates: [VALID_OUTPUT.candidates[0]] };
  const nonHttpsEvidence = structuredClone(VALID_OUTPUT);
  nonHttpsEvidence.candidates[0].evidence[0].sourceUrl = "http://one.example/hotel";
  const missingSummary = structuredClone(VALID_OUTPUT);
  delete missingSummary.candidates[0].evidence[0].summary;
  const extraCandidateField = structuredClone(VALID_OUTPUT);
  extraCandidateField.candidates[0].rawLog = "must not be accepted";
  const invalidCheckedAt = structuredClone(VALID_OUTPUT);
  invalidCheckedAt.candidates[0].evidence[0].verification.checkedAt = "2026";
  const invalidOwnerReason = {
    status: "needs_owner_action",
    reason: "other",
    message: "请在来源网站中完成所需操作后返回此页面继续。",
  };
  const ownerThreadLeak = {
    status: "needs_owner_action",
    reason: "codex_auth_required",
    message: "请在 Codex 应用中恢复登录后返回此页面继续。",
    threadId: "private-thread",
  };

  for (const invalid of [
    wrongCategory,
    tooFewCandidates,
    nonHttpsEvidence,
    missingSummary,
    extraCandidateField,
    invalidCheckedAt,
    invalidOwnerReason,
    ownerThreadLeak,
  ]) {
    const fake = createFakeSpawn([
      { stdout: jsonl("thread-1", invalid) },
      { stdout: jsonl("thread-1", invalid) },
    ]);
    const runner = makeRunner(fake, { validateOutput: undefined });
    await assert.rejects(runner.runInitial({ prompt: "private" }), { code: "CODEX_OUTPUT_INVALID" });
    assert.equal(fake.calls.length, 2);
  }
});

test("a second invalid output fails without creating a third process or exposing output", async () => {
  const invalid = { status: "completed", candidates: [] };
  const fake = createFakeSpawn([
    { stdout: jsonl("thread-1", invalid) },
    { stdout: jsonl("thread-1", invalid) },
  ]);
  const runner = makeRunner(fake);

  await assert.rejects(
    runner.runInitial({ prompt: "private prompt" }),
    (error) => {
      assert.equal(error.code, "CODEX_OUTPUT_INVALID");
      assert.equal(error.message, "CODEX_OUTPUT_INVALID");
      assert.deepEqual(Object.keys(error), ["code"]);
      return true;
    },
  );
  assert.equal(fake.calls.length, 2);
});

test("format correction is available only once across multiple public resumes", async () => {
  const invalid = { status: "completed", category: "hotel", candidates: [] };
  const fake = createFakeSpawn([
    { stdout: jsonl("thread-1", invalid) },
    { stdout: jsonl("thread-1", VALID_OUTPUT) },
    { stdout: jsonl("thread-1", invalid) },
  ]);
  const runner = makeRunner(fake, { validateOutput: undefined });

  assert.deepEqual((await runner.resume({ codexThreadId: "thread-1", prompt: "first resume" })).output, VALID_OUTPUT);
  await assert.rejects(
    runner.resume({ codexThreadId: "thread-1", prompt: "second resume" }),
    { code: "CODEX_OUTPUT_INVALID" },
  );
  assert.equal(fake.calls.length, 3);
  assert.equal(fake.calls.filter((call) => call.stdin.includes("上次输出未通过")).length, 1);
});

test("a runner binds to its first Codex thread and rejects a different resume thread before probing or spawning", async () => {
  const fake = createFakeSpawn([
    { stdout: jsonl("thread-1", VALID_OUTPUT) },
    { stdout: jsonl("thread-2", VALID_OUTPUT) },
  ]);
  let probeCalls = 0;
  const runner = makeRunner(fake, {
    validateOutput: undefined,
    probeIsolation: async () => { probeCalls += 1; return COMPLETE_ISOLATION_REPORT; },
  });

  await runner.runInitial({ prompt: "initial" });
  await assert.rejects(
    runner.resume({ codexThreadId: "thread-2", prompt: "wrong thread" }),
    { code: "CODEX_OUTPUT_INVALID" },
  );
  assert.equal(fake.calls.length, 1);
  assert.equal(probeCalls, 1);
});

test("malformed JSONL maps to a stable sanitized output error", async () => {
  const fake = createFakeSpawn([{ stdout: "not json\n", stderr: "raw /project/path and secret token" }]);
  const runner = makeRunner(fake);

  await assert.rejects(runner.runInitial({ prompt: "private" }), (error) => {
    assert.equal(error.code, "CODEX_OUTPUT_INVALID");
    assert.equal(error.message, "CODEX_OUTPUT_INVALID");
    assert.equal(JSON.stringify(error).includes("not json"), false);
    assert.equal(JSON.stringify(error).includes("secret token"), false);
    return true;
  });
  assert.equal(fake.calls.length, 1);
});

test("authentication, quota, spawn and other process failures use stable sanitized codes", async () => {
  for (const [outcome, expectedCode] of [
    [{ code: 1, stderr: "Not authenticated. Run codex login with raw/account/path" }, "CODEX_NOT_AUTHENTICATED"],
    [{ code: 1, stderr: "Usage limit reached; buy more credits" }, "CODEX_USAGE_UNAVAILABLE"],
    [{ spawnError: "ENOENT" }, "CODEX_NOT_AVAILABLE"],
    [{ code: 7, stderr: "provider crashed: raw internal details" }, "CODEX_RESEARCH_FAILED"],
  ]) {
    const fake = createFakeSpawn([outcome]);
    const runner = makeRunner(fake);
    await assert.rejects(runner.runInitial({ prompt: "private" }), (error) => {
      assert.equal(error.code, expectedCode);
      assert.equal(error.message, expectedCode);
      assert.deepEqual(Object.keys(error), ["code"]);
      return true;
    });
  }
});

test("active timeout sends SIGTERM then SIGKILL only after the grace period", async () => {
  const fake = createFakeSpawn([{ hang: true, closeOnSignal: "SIGKILL" }]);
  const runner = makeRunner(fake, { activeTimeoutMs: 15, killGraceMs: 15 });

  await assert.rejects(runner.runInitial({ prompt: "private" }), { code: "CODEX_RESEARCH_TIMEOUT" });
  assert.deepEqual(fake.calls[0].child.signals, ["SIGTERM", "SIGKILL"]);
});

test("a process that exits after SIGTERM is not sent SIGKILL", async () => {
  const fake = createFakeSpawn([{ hang: true, closeOnSignal: "SIGTERM" }]);
  const runner = makeRunner(fake, { activeTimeoutMs: 15, killGraceMs: 15 });

  await assert.rejects(runner.runInitial({ prompt: "private" }), { code: "CODEX_RESEARCH_TIMEOUT" });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(fake.calls[0].child.signals, ["SIGTERM"]);
});

test("output validation consumes the same active-time budget", async () => {
  const fake = createFakeSpawn([{ stdout: jsonl("thread-1") }]);
  const runner = makeRunner(fake, {
    activeTimeoutMs: 15,
    killGraceMs: 5,
    validateOutput: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return true;
    },
  });

  await assert.rejects(runner.runInitial({ prompt: "private" }), { code: "CODEX_RESEARCH_TIMEOUT" });
  assert.equal(fake.calls.length, 1);
});

test("runner rejects relative executables and non-isolated launch paths before spawning", () => {
  const fake = createFakeSpawn([]);
  for (const options of [
    { codexPath: "codex" },
    { codexPath: "/Applications/ChatGPT.app/Contents/Resources/../evil-codex" },
    { isolatedDir: "relative/isolated" },
    { isolatedDir: "/isolated/../project" },
    { projectDir: undefined },
    { projectDir: "/isolated" },
    { isolatedDir: "/project/isolated", projectDir: "/project" },
    { schemaPath: "relative/schema.json" },
    { schemaPath: "/isolated/../project/schema.json" },
  ]) {
    assert.throws(() => makeRunner(fake, options));
  }
  assert.equal(fake.calls.length, 0);
});

test("travel output schema is strict, HTTPS-only and discriminator-based", async () => {
  const schema = JSON.parse(await readFile(new URL("./codex-travel-output.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.oneOf.length, 2);
  assert.equal(schema.$defs.completed.additionalProperties, false);
  assert.equal(schema.$defs.completed.properties.status.const, "completed");
  assert.equal(schema.$defs.completed.properties.candidates.minItems, 2);
  assert.equal(schema.$defs.completed.properties.candidates.maxItems, 4);
  assert.deepEqual(schema.$defs.completed.allOf.map((rule) => rule.if.properties.category.const), ["hotel", "restaurant", "attraction"]);
  assert.deepEqual(schema.$defs.completed.allOf.map((rule) => rule.then.properties.candidates.items.properties.category.const), ["hotel", "restaurant", "attraction"]);
  assert.equal(schema.$defs.candidate.additionalProperties, false);
  assert.equal(schema.$defs.candidate.properties.evidence.minItems, 2);
  assert.equal(schema.$defs.evidence.additionalProperties, false);
  assert.equal(schema.$defs.evidence.properties.sourceUrl.pattern, "^https://");
  assert.deepEqual(schema.$defs.evidence.required, ["sourceUrl", "title", "summary", "verification"]);
  assert.equal(schema.$defs.verification.additionalProperties, false);
  assert.equal(schema.$defs.needsOwnerAction.additionalProperties, false);
  assert.deepEqual(schema.$defs.needsOwnerAction.properties.reason.enum, [
    "codex_auth_required",
    "source_login_required",
    "source_captcha",
    "source_risk_control",
  ]);
  assert.deepEqual(schema.$defs.needsOwnerAction.required, ["status", "reason", "message"]);
});
