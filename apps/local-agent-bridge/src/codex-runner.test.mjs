import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function factsFor(category, index) {
  if (category === "hotel") {
    return {
      propertyName: `Hotel ${index}`,
      address: `${index} Example Road`,
      checkInDate: "2026-09-10",
      checkOutDate: "2026-09-12",
      travelers: 2,
      roomTypeOrBed: "双床房",
      availability: "available",
      priceAmount: 1_280,
      currency: "CNY",
      priceDisplay: "total",
      cancellationPolicy: "入住前一天可免费取消",
    };
  }
  if (category === "restaurant") {
    return {
      name: `Restaurant ${index}`,
      address: `${index} Example Road`,
      openInformation: "11:00-22:00",
      priceSnapshot: "人均 CNY 180",
    };
  }
  return {
    name: `Attraction ${index}`,
    address: `${index} Example Road`,
    openInformation: "09:00-18:00",
    priceSnapshot: "成人票 CNY 120",
    ticketType: "成人日票",
  };
}

function completedOutput(category = "hotel") {
  return {
    status: "completed",
    category,
    candidates: [1, 2].map((index) => ({
      category,
      entity: { name: `${category} candidate ${index}`, address: `${index} Example Road` },
      applicability: { dates: { start: "2026-09-10", end: "2026-09-12" }, travelers: 2 },
      recommendation: {
        reason: `推荐理由 ${index}`,
        preferenceRevisionAliases: ["preference:交通便利"],
        feedbackAliases: [],
      },
      evidence: [1, 2].map((evidenceIndex) => ({
        sourceKind: evidenceIndex === 1 ? "official" : "web",
        sourceName: `Source ${index}-${evidenceIndex}`,
        sourceUrl: `https://source${index}${evidenceIndex}.example/${category}`,
        queryContext: {
          dates: { start: "2026-09-10", end: "2026-09-12" },
          travelers: 2,
          roomOrTicket: category === "hotel" ? "双床房" : "成人日票",
        },
        captureMethod: evidenceIndex === 1 ? "detail_page" : "search_result",
        facts: factsFor(category, index),
      })),
    })),
  };
}

const VALID_OUTPUT = completedOutput();

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
    JSON.stringify({
      type: "session_configured",
      session_id: threadId,
      approval_policy: "never",
      active_permission_profile: { id: "travel_research", extends: "default" },
    }),
    JSON.stringify({ type: "item.completed", item: { type: "web_search", query: "travel research" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(output) } }),
    JSON.stringify({ type: "turn.completed" }),
    "",
  ].join("\n");
}

function rawJsonl(events) {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

function outputWithStartDate(startDate) {
  const output = structuredClone(VALID_OUTPUT);
  output.candidates[0].applicability.dates.start = startDate;
  return output;
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
    child.stdin = new EventEmitter();
    child.stdin.end = (value = "") => {
      if (outcome.stdinEndError) throw new Error("raw stdin end failure");
      call.stdin += String(value);
    };
    child.stdin.write = (value) => { call.stdin += String(value); return true; };
    child.kill = (signal) => {
      child.signals.push(signal);
      if (outcome.killThrows?.includes(signal)) throw new Error("raw kill failure");
      if (outcome.closeOnSignal === signal) queueMicrotask(() => child.emit("close", null, signal));
      return outcome.killReturnsFalse !== true;
    };
    calls.push(call);
    queueMicrotask(() => {
      if (outcome.spawnError) {
        child.emit("error", Object.assign(new Error("raw spawn failure"), { code: outcome.spawnError }));
        return;
      }
      if (outcome.stdout !== undefined) child.stdout.emit("data", Buffer.from(outcome.stdout));
      for (const chunk of outcome.stdoutChunks ?? []) child.stdout.emit("data", Buffer.from(chunk));
      if (outcome.stderr !== undefined) child.stderr.emit("data", Buffer.from(outcome.stderr));
      if (outcome.stdinError) child.stdin.emit("error", new Error("raw stdin failure"));
      if (outcome.stdoutError) child.stdout.emit("error", new Error("raw stdout failure"));
      if (outcome.stderrError) child.stderr.emit("error", new Error("raw stderr failure"));
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
    pathVerifier: async ({ codexPath, isolatedDir, projectDir, schemaPath, probePaths }) => ({
      codexPath,
      isolatedDir,
      projectDir,
      schemaPath,
      probePaths,
    }),
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
  const fake = createFakeSpawn([{ stdout: jsonl("thread-1", completedOutput("restaurant")) }]);
  const runner = makeRunner(fake, { validateOutput: (value) => value?.status === "completed" });

  const result = await runner.resume({ codexThreadId: "thread-1", prompt: "continue after owner action" });

  assert.deepEqual(Object.keys(result).sort(), ["activeDurationMs", "codexThreadId", "output", "state"]);
  assert.deepEqual(result.state, {
    codexThreadId: "thread-1",
    correctionUsed: false,
    activeDurationMs: result.activeDurationMs,
  });
  assert.deepEqual(Object.keys(result.state).sort(), ["activeDurationMs", "codexThreadId", "correctionUsed"]);
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

test("the built-in validator accepts all category facts and both strict owner-action branches", async () => {
  const outputs = [
    completedOutput("hotel"),
    completedOutput("restaurant"),
    completedOutput("attraction"),
    {
      status: "needs_owner_action",
      reason: "codex_auth_required",
      message: "请在 ChatGPT/Codex 中恢复登录后返回此页面继续。",
    },
    ...["source_login_required", "source_captcha", "source_risk_control"].map((reason) => ({
      status: "needs_owner_action",
      reason,
      message: "请在来源网站中完成所需操作后返回此页面继续。",
      sourceHostname: "tickets.example.com",
    })),
  ];
  for (const output of outputs) {
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

test("the built-in validator rejects shape, bounds, HTTPS and category-facts violations", async () => {
  const wrongCategory = structuredClone(VALID_OUTPUT);
  wrongCategory.category = "flight";
  wrongCategory.candidates.forEach((candidate) => { candidate.category = "flight"; });
  const tooFewCandidates = { ...VALID_OUTPUT, candidates: [VALID_OUTPUT.candidates[0]] };
  const nonHttpsEvidence = structuredClone(VALID_OUTPUT);
  nonHttpsEvidence.candidates[0].evidence[0].sourceUrl = "http://one.example/hotel";
  const urlWithUserInfo = structuredClone(VALID_OUTPUT);
  urlWithUserInfo.candidates[0].evidence[0].sourceUrl = "https://owner:secret@one.example/hotel";
  const urlWithFragment = structuredClone(VALID_OUTPUT);
  urlWithFragment.candidates[0].evidence[0].sourceUrl = "https://one.example/hotel#private";
  const whitespaceEntity = structuredClone(VALID_OUTPUT);
  whitespaceEntity.candidates[0].entity.name = " \t ";
  const missingFact = structuredClone(VALID_OUTPUT);
  delete missingFact.candidates[0].evidence[0].facts.availability;
  const wrongCategoryFacts = structuredClone(VALID_OUTPUT);
  wrongCategoryFacts.candidates[0].evidence[0].facts = factsFor("restaurant", 1);
  const extraCandidateField = structuredClone(VALID_OUTPUT);
  extraCandidateField.candidates[0].rawLog = "must not be accepted";
  const tooManyEvidence = structuredClone(VALID_OUTPUT);
  tooManyEvidence.candidates[0].evidence = Array.from({ length: 9 }, () => structuredClone(VALID_OUTPUT.candidates[0].evidence[0]));
  const tooManyAliases = structuredClone(VALID_OUTPUT);
  tooManyAliases.candidates[0].recommendation.preferenceRevisionAliases = Array.from({ length: 65 }, (_, index) => `preference:${index}`);
  const oversizedText = structuredClone(VALID_OUTPUT);
  oversizedText.candidates[0].recommendation.reason = "x".repeat(2_001);
  const invalidDate = outputWithStartDate("2026-02-30");
  const invalidOwnerReason = {
    status: "needs_owner_action",
    reason: "other",
    message: "请在来源网站中完成所需操作后返回此页面继续。",
  };
  const ownerThreadLeak = {
    status: "needs_owner_action",
    reason: "codex_auth_required",
    message: "请在 ChatGPT/Codex 中恢复登录后返回此页面继续。",
    threadId: "private-thread",
  };
  const crossedCodexAction = {
    status: "needs_owner_action",
    reason: "codex_auth_required",
    message: "请在来源网站中完成所需操作后返回此页面继续。",
    sourceHostname: "tickets.example.com",
  };
  const crossedSourceAction = {
    status: "needs_owner_action",
    reason: "source_captcha",
    message: "请在 ChatGPT/Codex 中恢复登录后返回此页面继续。",
  };
  const unsafeHostname = {
    status: "needs_owner_action",
    reason: "source_login_required",
    message: "请在来源网站中完成所需操作后返回此页面继续。",
    sourceHostname: "Bad_Host.example.com",
  };

  for (const invalid of [
    wrongCategory,
    tooFewCandidates,
    nonHttpsEvidence,
    urlWithUserInfo,
    urlWithFragment,
    whitespaceEntity,
    missingFact,
    wrongCategoryFacts,
    extraCandidateField,
    tooManyEvidence,
    tooManyAliases,
    oversizedText,
    invalidDate,
    invalidOwnerReason,
    ownerThreadLeak,
    crossedCodexAction,
    crossedSourceAction,
    unsafeHostname,
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

test("the built-in validator rejects nonexistent calendar dates after one correction", async () => {
  for (const startDate of [
    "2026-02-30",
    "2025-02-29",
    "1900-02-29",
    "2026-00-01",
    "2026-13-01",
    "2026-04-31",
    "2026-01-00",
  ]) {
    const invalid = outputWithStartDate(startDate);
    const fake = createFakeSpawn([
      { stdout: jsonl("thread-1", invalid) },
      { stdout: jsonl("thread-1", invalid) },
    ]);
    const runner = makeRunner(fake, { validateOutput: undefined });
    await assert.rejects(runner.runInitial({ prompt: "private" }), { code: "CODEX_OUTPUT_INVALID" });
    assert.equal(fake.calls.length, 2);
  }
});

test("the built-in validator accepts real leap-day date fields", async () => {
  for (const startDate of [
    "2024-02-29",
    "2000-02-29",
  ]) {
    const output = outputWithStartDate(startDate);
    const fake = createFakeSpawn([{ stdout: jsonl("thread-1", output) }]);
    const runner = makeRunner(fake, { validateOutput: undefined });
    assert.deepEqual((await runner.runInitial({ prompt: "private" })).output, output);
    assert.equal(fake.calls.length, 1);
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

test("JSONL accepts the documented public web-search event and the current internal equivalent", async () => {
  for (const webEvent of [
    { type: "item.completed", item: { type: "web_search", query: "hotel" } },
    { type: "web_search_end", query: "hotel" },
  ]) {
    const events = [
      { type: "thread.started", thread_id: "thread-1" },
      { type: "session_configured", session_id: "thread-1", approval_policy: "never", active_permission_profile: { id: "travel_research" } },
      webEvent,
      { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(VALID_OUTPUT) } },
      { type: "turn.completed" },
    ];
    const fake = createFakeSpawn([{ stdout: rawJsonl(events) }]);
    assert.deepEqual((await makeRunner(fake).runInitial({ prompt: "private" })).output, VALID_OUTPUT);
  }
});

test("JSONL state machine rejects missing, reordered, conflicting or inherited session evidence", async () => {
  const thread = { type: "thread.started", thread_id: "thread-1" };
  const session = { type: "session_configured", session_id: "thread-1", approval_policy: "never", active_permission_profile: { id: "travel_research" } };
  const web = { type: "item.completed", item: { type: "web_search" } };
  const output = { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(VALID_OUTPUT) } };
  const done = { type: "turn.completed" };
  const inheritedProfile = { type: "session_configured", session_id: "thread-1", approval_policy: "never", active_permission_profile: Object.create({ id: "travel_research" }) };
  const cases = [
    [{ type: "task.started", task_id: "thread-1" }, session, web, output, done],
    [thread, { ...thread, thread_id: "thread-2" }, session, web, output, done],
    [thread, web, output, done],
    [session, thread, web, output, done],
    [thread, { ...session, session_id: "thread-2" }, web, output, done],
    [thread, { ...session, approval_policy: "on-request" }, web, output, done],
    [thread, { ...session, active_permission_profile: { id: "default" } }, web, output, done],
    [thread, inheritedProfile, web, output, done],
    [thread, session, output, done],
    [thread, web, session, output, done],
    [thread, session, output, web, done],
    [thread, session, web, output],
    [thread, session, web, { type: "final.response", output: VALID_OUTPUT }, done],
  ];

  for (const events of cases) {
    const fake = createFakeSpawn([{ stdout: rawJsonl(events) }]);
    await assert.rejects(makeRunner(fake).runInitial({ prompt: "private" }), { code: "CODEX_OUTPUT_INVALID" });
  }
});

test("later task or session-like fields cannot replace the root thread.started ID", async () => {
  const events = [
    { type: "thread.started", thread_id: "thread-1" },
    { type: "session_configured", session_id: "thread-1", approval_policy: "never", active_permission_profile: { id: "travel_research" } },
    { type: "item.completed", item: { type: "web_search" }, task_id: "evil-task" },
    { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(VALID_OUTPUT) }, session_id: "evil-session" },
    { type: "turn.completed" },
  ];
  const fake = createFakeSpawn([{ stdout: rawJsonl(events) }]);
  const result = await makeRunner(fake).runInitial({ prompt: "private" });
  assert.equal(result.codexThreadId, "thread-1");
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

test("the isolation probe consumes the same monotonic active-time budget", async () => {
  const fake = createFakeSpawn([{ stdout: jsonl("thread-1") }]);
  const ticks = [100, 100, 121, 121];
  const runner = makeRunner(fake, {
    activeTimeoutMs: 20,
    monotonicNow: () => ticks.shift() ?? 121,
    probeIsolation: async () => COMPLETE_ISOLATION_REPORT,
  });

  await assert.rejects(runner.runInitial({ prompt: "private" }), { code: "CODEX_RESEARCH_TIMEOUT" });
  assert.equal(fake.calls.length, 0);
});

test("runner rejects a concurrent run or resume without starting a second probe", async () => {
  const fake = createFakeSpawn([{ stdout: jsonl("thread-1") }]);
  let releaseProbe;
  let probeCalls = 0;
  const runner = makeRunner(fake, {
    probeIsolation: async () => {
      probeCalls += 1;
      return new Promise((resolve) => { releaseProbe = () => resolve(COMPLETE_ISOLATION_REPORT); });
    },
  });
  const first = runner.runInitial({ prompt: "first" });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(runner.resume({ codexThreadId: "thread-1", prompt: "concurrent" }), { code: "CODEX_RESEARCH_FAILED" });
  assert.equal(probeCalls, 1);
  assert.equal(fake.calls.length, 0);
  releaseProbe();
  await first;
});

test("stdout byte, line byte and line-count limits terminate the child and sanitize failure", async () => {
  for (const [outcome, limits] of [
    [{ hang: true, stdout: "x".repeat(33), closeOnSignal: "SIGKILL" }, { maxStdoutBytes: 32 }],
    [{ hang: true, stdout: "x".repeat(17), closeOnSignal: "SIGKILL" }, { maxJsonlLineBytes: 16 }],
    [{ hang: true, stdout: "{}\n{}\n{}\n", closeOnSignal: "SIGKILL" }, { maxJsonlLines: 2 }],
  ]) {
    const fake = createFakeSpawn([outcome]);
    const runner = makeRunner(fake, { ...limits, killGraceMs: 5, teardownTimeoutMs: 5 });
    await assert.rejects(runner.runInitial({ prompt: "private" }), (error) => {
      assert.equal(error.code, "CODEX_OUTPUT_INVALID");
      assert.deepEqual(Object.keys(error), ["code"]);
      return true;
    });
    assert.deepEqual(fake.calls[0].child.signals, ["SIGTERM", "SIGKILL"]);
  }
});

test("stdin and stream failures use TERM then KILL and wait for teardown", async () => {
  for (const outcome of [
    { hang: true, stdinEndError: true, closeOnSignal: "SIGKILL" },
    { hang: true, stdinError: true, closeOnSignal: "SIGKILL" },
    { hang: true, stdoutError: true, closeOnSignal: "SIGKILL" },
    { hang: true, stderrError: true, closeOnSignal: "SIGKILL" },
  ]) {
    const fake = createFakeSpawn([outcome]);
    const runner = makeRunner(fake, { killGraceMs: 5, teardownTimeoutMs: 5 });
    await assert.rejects(runner.runInitial({ prompt: "private" }), { code: "CODEX_RESEARCH_FAILED" });
    assert.deepEqual(fake.calls[0].child.signals, ["SIGTERM", "SIGKILL"]);
  }
});

test("teardown remains bounded when kill throws or returns false", async () => {
  for (const outcome of [
    { hang: true, stdinEndError: true, killThrows: ["SIGTERM", "SIGKILL"] },
    { hang: true, stdinEndError: true, killReturnsFalse: true },
  ]) {
    const fake = createFakeSpawn([outcome]);
    const runner = makeRunner(fake, { killGraceMs: 5, teardownTimeoutMs: 5 });
    await assert.rejects(runner.runInitial({ prompt: "private" }), { code: "CODEX_RESEARCH_FAILED" });
    assert.deepEqual(fake.calls[0].child.signals, ["SIGTERM", "SIGKILL"]);
  }
});

test("process failure classification trusts structured errors and only bounded stderr fallback", async () => {
  for (const [outcome, expected] of [
    [{ code: 1, stdout: rawJsonl([{ type: "error", error: { code: "authentication_required" } }]) }, "CODEX_NOT_AUTHENTICATED"],
    [{ code: 1, stdout: rawJsonl([{ type: "error", error: { code: "usage_limit_reached" } }]) }, "CODEX_USAGE_UNAVAILABLE"],
    [{ code: 7, stdout: "quota usage limit inside untrusted research output" }, "CODEX_RESEARCH_FAILED"],
  ]) {
    const fake = createFakeSpawn([outcome]);
    await assert.rejects(makeRunner(fake).runInitial({ prompt: "private" }), { code: expected });
  }
});

test("trusted initial state resumes one thread and preserves a spent correction across restart", async () => {
  const invalid = { status: "completed", category: "hotel", candidates: [] };
  const fake = createFakeSpawn([{ stdout: jsonl("thread-1", invalid) }]);
  const runner = makeRunner(fake, {
    validateOutput: undefined,
    initialState: { codexThreadId: "thread-1", correctionUsed: true, activeDurationMs: 123 },
  });

  await assert.rejects(runner.resume({ codexThreadId: "thread-1", prompt: "continue" }), { code: "CODEX_OUTPUT_INVALID" });
  assert.equal(fake.calls.length, 1);
  await assert.rejects(runner.resume({ codexThreadId: "thread-2", prompt: "wrong" }), { code: "CODEX_OUTPUT_INVALID" });
});

test("runner returns only sanitized restart state and rejects malformed initial state", async () => {
  const fake = createFakeSpawn([{ stdout: jsonl("thread-1") }]);
  const result = await makeRunner(fake).runInitial({ prompt: "private" });
  assert.equal(result.state.codexThreadId, "thread-1");
  assert.equal(result.state.correctionUsed, false);
  assert.equal(result.state.activeDurationMs, result.activeDurationMs);
  assert.equal(JSON.stringify(result.state).includes("private"), false);
  assert.equal(JSON.stringify(result.state).includes("isolated"), false);

  for (const initialState of [
    null,
    {},
    { codexThreadId: "thread-1", correctionUsed: false, activeDurationMs: 0, prompt: "secret" },
    { codexThreadId: "thread-1", correctionUsed: "false", activeDurationMs: 0 },
    { codexThreadId: "thread-1", correctionUsed: false, activeDurationMs: -1 },
  ]) {
    assert.throws(() => makeRunner(createFakeSpawn([]), { initialState }), { code: "CODEX_RESEARCH_FAILED" });
  }
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

test("runner rejects canonical path overlap and non-file executable or schema before probing", async (context) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codex-runner-canonical-test-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectDir = join(root, "project");
  const isolatedDir = join(root, "isolated");
  const isolatedProjectLink = join(root, "isolated-project-link");
  const codexPath = join(root, "codex");
  const codexLink = join(root, "codex-link");
  const schemaPath = join(root, "schema.json");
  const schemaDirectory = join(root, "schema-directory");
  await Promise.all([mkdir(projectDir), mkdir(isolatedDir), mkdir(schemaDirectory)]);
  await writeFile(codexPath, "#!/bin/sh\nexit 0\n");
  await chmod(codexPath, 0o700);
  await writeFile(schemaPath, "{}\n");
  await Promise.all([
    symlink(projectDir, isolatedProjectLink),
    symlink(codexPath, codexLink),
  ]);

  for (const paths of [
    { codexPath: schemaDirectory, isolatedDir, schemaPath },
    { codexPath: codexLink, isolatedDir, schemaPath },
    { codexPath, isolatedDir: isolatedProjectLink, schemaPath },
    { codexPath, isolatedDir, schemaPath: schemaDirectory },
  ]) {
    const fake = createFakeSpawn([{ stdout: jsonl("thread-1") }]);
    let probeCalls = 0;
    const runner = createCodexRunner({
      ...paths,
      projectDir,
      spawnImpl: fake.spawnImpl,
      probeIsolation: async () => { probeCalls += 1; return COMPLETE_ISOLATION_REPORT; },
    });
    await assert.rejects(runner.runInitial({ prompt: "private" }));
    assert.equal(probeCalls, 0);
    assert.equal(fake.calls.length, 0);
  }
});

test("travel output schema is strict, HTTPS-only and discriminator-based", async () => {
  const schema = JSON.parse(await readFile(new URL("./codex-travel-output.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.oneOf.length, 2);
  assert.equal(schema.$defs.completed.additionalProperties, false);
  assert.equal(schema.$defs.completed.properties.status.const, "completed");
  assert.equal(schema.$defs.completed.properties.candidates.minItems, 2);
  assert.equal(schema.$defs.completed.properties.candidates.maxItems, 4);
  assert.deepEqual(schema.$defs.completed.allOf.map((rule) => rule.if.properties.category.const), ["hotel", "restaurant", "attraction"]);
  assert.deepEqual(schema.$defs.completed.allOf.map((rule) => rule.then.properties.candidates.items.$ref), [
    "#/$defs/hotelCandidate",
    "#/$defs/restaurantCandidate",
    "#/$defs/attractionCandidate",
  ]);
  assert.equal(schema.$defs.candidate.additionalProperties, false);
  assert.deepEqual(schema.$defs.candidate.required, ["category", "entity", "applicability", "recommendation", "evidence"]);
  assert.equal(schema.$defs.candidate.properties.evidence.minItems, 2);
  assert.equal(schema.$defs.candidate.properties.evidence.maxItems, 8);
  assert.equal(schema.$defs.entity.additionalProperties, false);
  assert.equal(schema.$defs.applicability.additionalProperties, false);
  assert.equal(schema.$defs.recommendation.additionalProperties, false);
  assert.equal(schema.$defs.aliases.maxItems, 64);
  assert.equal(schema.$defs.evidence.additionalProperties, false);
  assert.equal(schema.$defs.evidence.properties.sourceUrl.pattern.startsWith("^https://"), true);
  assert.equal(schema.$defs.evidence.properties.sourceUrl.maxLength, 2_048);
  assert.deepEqual(schema.$defs.evidence.required, ["sourceKind", "sourceName", "sourceUrl", "queryContext", "captureMethod", "facts"]);
  for (const facts of ["hotelFacts", "restaurantFacts", "attractionFacts"]) {
    assert.equal(schema.$defs[facts].additionalProperties, false);
  }
  assert.equal(schema.$defs.needsOwnerAction.oneOf.length, 2);
  assert.equal(schema.$defs.codexAuthOwnerAction.additionalProperties, false);
  assert.equal(schema.$defs.codexAuthOwnerAction.properties.reason.const, "codex_auth_required");
  assert.equal(schema.$defs.sourceOwnerAction.additionalProperties, false);
  assert.deepEqual(schema.$defs.sourceOwnerAction.properties.reason.enum, [
    "source_login_required",
    "source_captcha",
    "source_risk_control",
  ]);
  assert.deepEqual(schema.$defs.sourceOwnerAction.required, ["status", "reason", "message", "sourceHostname"]);
});
