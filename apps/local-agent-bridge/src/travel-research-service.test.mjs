import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";

import { buildResearchTargetScopes } from "@travel/contracts/decision-research";

import { buildTravelResearchInput } from "./travel-research-input.mjs";
import { safeResearchStatus, TravelResearchService } from "./travel-research-service.mjs";

const PUBLIC_RESOLVER = async () => [{ address: "93.184.216.34", family: 4 }];

function contextFixture() {
  return {
    trip: {
      version: 7,
      days: [{ id: "day-1", date: "2026-10-03", city: "深圳" }],
      travelerNames: ["一鸣", "美垚"],
      travelerCount: 2,
    },
    workspace: {
      tripId: "trip-private",
      preferences: [],
      summary: undefined,
      candidates: [],
      placements: [],
      evidence: [],
      feedback: [],
      confirmations: [],
      workspaceCursor: "cursor-private",
      fetchedAt: "2026-09-01T00:00:00.000Z",
    },
  };
}

function hotelEvidence(hostname, index) {
  return {
    sourceKind: index === 0 ? "official" : "web",
    sourceName: index === 0 ? "酒店官网" : "公开平台",
    sourceUrl: `https://${hostname}/room?private=query`,
    queryContext: {
      dates: { start: "2026-10-03", end: "2026-10-03" },
      travelers: 2,
      roomOrTicket: "大床房",
    },
    captureMethod: index === 0 ? "detail_page" : "search_result",
    facts: {
      propertyName: "深圳湾酒店",
      address: "深圳市南山区",
      checkInDate: "2026-10-03",
      checkOutDate: "2026-10-03",
      travelers: 2,
      roomTypeOrBed: "大床房",
      availability: "available",
      priceAmount: 1288,
      currency: "CNY",
      priceDisplay: "total",
      cancellationPolicy: "入住前一天可免费取消",
    },
  };
}

function completedOutput() {
  const candidate = (index) => ({
    category: "hotel",
    entity: { name: "深圳湾酒店", address: "深圳市南山区" },
    applicability: {
      dates: { start: "2026-10-03", end: "2026-10-03" },
      travelers: 2,
    },
    recommendation: {
      reason: index === 0 ? "靠近行程段" : "交通便利",
      preferenceRevisionAliases: [],
      feedbackAliases: [],
    },
    evidence: [
      hotelEvidence(`hotel-${index + 1}.public.org`, 0),
      hotelEvidence(`booking-${index + 1}.public.org`, 1),
    ],
  });
  return { status: "completed", category: "hotel", candidates: [candidate(0), candidate(1)] };
}

function ownerAction(reason = "codex_auth_required", sourceHostname) {
  return reason === "codex_auth_required"
    ? {
        status: "needs_owner_action",
        reason,
        message: "请在 ChatGPT/Codex 中恢复登录后返回此页面继续。",
      }
    : {
        status: "needs_owner_action",
        reason,
        message: "请在来源网站中完成所需操作后返回此页面继续。",
        sourceHostname,
      };
}

function createClock(start = "2026-09-01T00:00:00.000Z") {
  let time = Date.parse(start);
  const clock = () => new Date(time);
  clock.advance = (milliseconds) => { time += milliseconds; };
  return clock;
}

function fakeStore(events, initialState) {
  let state = initialState && structuredClone(initialState);
  return {
    async load() { events.push("store.load"); return state && structuredClone(state); },
    async clear() { events.push("store.clear"); state = undefined; },
    async persistNeedsOwnerAction(value, notifier) {
      events.push("store.persistNeedsOwnerAction");
      state = structuredClone(value);
      await notifier?.notifyOwnerAction("transition-key");
      return structuredClone(state);
    },
    get state() { return state && structuredClone(state); },
  };
}

function fakeTransport(events, context, options = {}) {
  let claimed;
  let submitAttempts = 0;
  const submittedPayloads = [];
  return {
    prepare() { events.push("transport.prepare"); return { publicKeyJwk: { kty: "EC" } }; },
    async claim(agentRunId) {
      events.push(`transport.claim:${agentRunId}`);
      claimed = options.clearClaimAfterClaim ? undefined : {
        agentRunId,
        expiresAt: options.claimExpiresAt ?? "2099-01-01T00:00:00.000Z",
        nextSequence: 1,
      };
      return { agentRunId, status: "claimed" };
    },
    get claimedRun() { return claimed && { ...claimed }; },
    async getDecisionContext() {
      events.push("transport.getDecisionContext");
      if (options.contextGate) await options.contextGate;
      return structuredClone(context);
    },
    async submitProposalBatch(payload) {
      events.push("transport.submitProposalBatch");
      submittedPayloads.push(structuredClone(payload));
      submitAttempts += 1;
      if (options.uncertainSubmitOnce && submitAttempts === 1) {
        throw Object.assign(new Error("private network detail"), {
          code: "AGENT_TRANSPORT_UNAVAILABLE",
          uncertain: true,
        });
      }
      return { ok: true, action: "submitProposalBatch", data: { count: payload.candidates.length } };
    },
    async revokeSelf() {
      events.push("transport.revokeSelf");
      if (options.uncertainRevoke) {
        throw Object.assign(new Error("private revoke detail"), {
          code: "AGENT_TRANSPORT_UNAVAILABLE",
          uncertain: true,
        });
      }
      claimed = undefined;
      return { ok: true };
    },
    submittedPayloads,
  };
}

function fakeRunner(events, scripts) {
  let createCount = 0;
  const resumeInputs = [];
  const sessions = [];
  const createInitialStates = [];
  return {
    resolveHostname: PUBLIC_RESOLVER,
    create(initialState) {
      createCount += 1;
      createInitialStates.push(initialState && structuredClone(initialState));
      events.push(initialState ? `runner.create:${initialState.codexThreadId}` : "runner.create:new");
      let state = initialState && { ...initialState };
      let cancelled = false;
      const session = {
        async runInitial(input) {
          events.push("runner.runInitial");
          assert.equal(typeof input.prompt, "string");
          const script = scripts.shift();
          if (typeof script === "function") return script({ input, cancelled, session });
          if (script instanceof Error) throw script;
          state = script.state ?? {
            codexThreadId: script.codexThreadId,
            correctionUsed: false,
            activeDurationMs: script.activeDurationMs,
          };
          return structuredClone({ ...script, state });
        },
        async resume(input) {
          events.push(`runner.resume:${input.codexThreadId}`);
          resumeInputs.push(structuredClone(input));
          const script = scripts.shift();
          if (typeof script === "function") return script({ input, cancelled, session });
          if (script instanceof Error) throw script;
          state = script.state ?? {
            codexThreadId: input.codexThreadId,
            correctionUsed: true,
            activeDurationMs: script.activeDurationMs,
          };
          return structuredClone({ ...script, state });
        },
        async cancel() { events.push("runner.cancel"); cancelled = true; },
        getState() { return state && structuredClone(state); },
      };
      sessions.push(session);
      return session;
    },
    get createCount() { return createCount; },
    resumeInputs,
    sessions,
    createInitialStates,
  };
}

async function targetRequest(context = contextFixture()) {
  const targetScopeId = buildResearchTargetScopes(context.trip)[0].targetScopeId;
  const built = await buildTravelResearchInput(context, {
    targetCategory: "hotel",
    targetScopeId,
    aliasSalt: "fingerprint-salt-1234",
  }, webcrypto);
  return {
    agentRunId: "agent-run-1",
    targetCategory: "hotel",
    targetScopeId,
    disclosureFingerprint: built.disclosureFingerprint,
  };
}

function createHarness({ context = contextFixture(), scripts = [], transportOptions, initialState } = {}) {
  const events = [];
  const clock = createClock();
  const store = fakeStore(events, initialState);
  const notifier = { async notifyOwnerAction() { events.push("notifier.notifyOwnerAction"); return true; } };
  const transport = fakeTransport(events, context, transportOptions);
  const runner = fakeRunner(events, [...scripts]);
  const generated = ["research-task-1", "alias-salt-1234567890"];
  const service = new TravelResearchService({
    transport,
    runner,
    store,
    notifier,
    clock,
    idGenerator: () => generated.shift(),
  });
  return { events, clock, store, notifier, transport, runner, service };
}

test("happy path starts Codex only after prepare/claim and writes one validated batch before revoke", async () => {
  const harness = createHarness({ scripts: [{
    codexThreadId: "codex-thread-1",
    output: completedOutput(),
    activeDurationMs: 12_000,
  }] });
  const request = await targetRequest();

  harness.service.prepare();
  await harness.service.claim(request.agentRunId);
  assert.equal(harness.runner.createCount, 0);
  assert.deepEqual(harness.events, ["transport.prepare", "transport.claim:agent-run-1"]);

  const status = await harness.service.executeTravelResearch(request);

  assert.deepEqual(status, {
    phase: "completed",
    researchTaskId: "research-task-1",
    startedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  });
  assert.deepEqual(harness.events, [
    "transport.prepare",
    "transport.claim:agent-run-1",
    "transport.getDecisionContext",
    "runner.create:new",
    "runner.runInitial",
    "transport.submitProposalBatch",
    "transport.revokeSelf",
    "store.clear",
  ]);
  assert.equal(harness.transport.submittedPayloads.length, 1);
  assert.equal(harness.transport.submittedPayloads[0].candidates.length, 2);
});

test("concurrent execute calls for the same AgentRun share one runner and one task", async () => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const harness = createHarness({ scripts: [async () => {
    await waiting;
    return {
      codexThreadId: "codex-thread-1",
      output: completedOutput(),
      activeDurationMs: 5_000,
      state: { codexThreadId: "codex-thread-1", correctionUsed: false, activeDurationMs: 5_000 },
    };
  }] });
  const request = await targetRequest();
  harness.service.prepare();
  await harness.service.claim(request.agentRunId);

  const first = harness.service.executeTravelResearch(request);
  const second = harness.service.executeTravelResearch(request);
  release();

  assert.deepEqual(await first, await second);
  assert.equal(harness.runner.createCount, 1);
  assert.equal(harness.transport.submittedPayloads.length, 1);
});

test("changed disclosure revokes the run and never creates a Codex task", async () => {
  const harness = createHarness();
  const request = { ...await targetRequest(), disclosureFingerprint: "f".repeat(64) };
  harness.service.prepare();
  await harness.service.claim(request.agentRunId);

  const status = await harness.service.executeTravelResearch(request);

  assert.equal(status.phase, "superseded");
  assert.equal(status.errorCode, "DISCLOSURE_CONTEXT_CHANGED");
  assert.equal(harness.runner.createCount, 0);
  assert.equal(harness.transport.submittedPayloads.length, 0);
  assert.deepEqual(harness.events.slice(-2), ["transport.revokeSelf", "store.clear"]);
});

test("validated owner-action output revokes before persistence and notification with zero writes", async () => {
  for (const [reason, hostname] of [
    ["codex_auth_required", undefined],
    ["source_login_required", "booking.public.org"],
    ["source_captcha", "captcha.public.org"],
    ["source_risk_control", "risk.public.org"],
  ]) {
    const harness = createHarness({ scripts: [{
      codexThreadId: `thread-${reason}`,
      output: ownerAction(reason, hostname),
      activeDurationMs: 15_000,
    }] });
    const request = await targetRequest();
    harness.service.prepare();
    await harness.service.claim(request.agentRunId);

    const status = await harness.service.executeTravelResearch(request);

    assert.equal(status.phase, "needs_owner_action");
    assert.equal(status.blockedReason, reason);
    assert.equal(harness.transport.submittedPayloads.length, 0);
    const revokeIndex = harness.events.indexOf("transport.revokeSelf");
    const persistIndex = harness.events.indexOf("store.persistNeedsOwnerAction");
    const notifyIndex = harness.events.indexOf("notifier.notifyOwnerAction");
    assert.equal(revokeIndex < persistIndex && persistIndex < notifyIndex, true);
    assert.equal(JSON.stringify(status).includes("thread-"), false);
  }
});

test("runner authentication loss becomes owner action only with a recoverable thread state", async () => {
  const authError = Object.assign(new Error("private auth detail"), {
    code: "CODEX_NOT_AUTHENTICATED",
    state: { codexThreadId: "thread-auth-loss", correctionUsed: false, activeDurationMs: 22_000 },
  });
  const harness = createHarness({ scripts: [authError] });
  const request = await targetRequest();
  harness.service.prepare();
  await harness.service.claim(request.agentRunId);

  const status = await harness.service.executeTravelResearch(request);

  assert.equal(status.phase, "needs_owner_action");
  assert.equal(status.blockedReason, "codex_auth_required");
  assert.equal(harness.store.state.codexThreadId, "thread-auth-loss");
  assert.equal(harness.transport.submittedPayloads.length, 0);
});

test("resume uses a newly claimed run, the same task/thread and a fixed skip prompt", async () => {
  const first = createHarness({ scripts: [{
    codexThreadId: "thread-source",
    output: ownerAction("source_login_required", "booking.public.org"),
    activeDurationMs: 20_000,
  }] });
  const initialRequest = await targetRequest();
  first.service.prepare();
  await first.service.claim(initialRequest.agentRunId);
  await first.service.executeTravelResearch(initialRequest);

  const persisted = first.store.state;
  const resumed = createHarness({
    initialState: persisted,
    scripts: [{ codexThreadId: "thread-source", output: completedOutput(), activeDurationMs: 28_000 }],
  });
  resumed.service.prepare();
  await resumed.service.claim("agent-run-2");

  const status = await resumed.service.resumeTravelResearch({
    agentRunId: "agent-run-2",
    researchTaskId: persisted.researchTaskId,
    resumeAction: "skip_blocked_source",
  });

  assert.equal(status.phase, "completed");
  assert.deepEqual(resumed.runner.resumeInputs.map((input) => input.codexThreadId), ["thread-source"]);
  assert.match(resumed.runner.resumeInputs[0].prompt, /booking\.public\.org/u);
  assert.equal(resumed.runner.resumeInputs[0].prompt.includes("http"), false);
  assert.equal(resumed.transport.submittedPayloads.length, 1);
  assert.equal(resumed.store.state, undefined);
});

test("resume rejects browser-controlled fields and supersedes changed context without touching the old thread", async () => {
  const request = await targetRequest();
  const initialState = {
    researchTaskId: "research-task-1",
    codexThreadId: "old-thread",
    targetCategory: "hotel",
    targetScopeId: request.targetScopeId,
    disclosureFingerprint: request.disclosureFingerprint,
    aliasSalt: "alias-salt-1234567890",
    blockedReason: "codex_auth_required",
    blockedHostname: null,
    activeRuntimeMs: 25_000,
    phase: "needs_owner_action",
    startedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:01:00.000Z",
  };
  const changed = contextFixture();
  changed.trip.travelerNames = ["一鸣", "美垚", "未授权变更"];
  const harness = createHarness({ context: changed, initialState });
  harness.service.prepare();
  await harness.service.claim("agent-run-2");

  await assert.rejects(
    harness.service.resumeTravelResearch({
      agentRunId: "agent-run-2",
      researchTaskId: "research-task-1",
      resumeAction: "retry_codex_auth",
      prompt: "browser supplied",
    }),
    { code: "CODEX_RESEARCH_FAILED" },
  );
  const status = await harness.service.resumeTravelResearch({
    agentRunId: "agent-run-2",
    researchTaskId: "research-task-1",
    resumeAction: "retry_codex_auth",
  });

  assert.equal(status.phase, "superseded");
  assert.equal(harness.runner.createCount, 0);
  assert.equal(harness.runner.resumeInputs.length, 0);
  assert.equal(harness.store.state, undefined);
});

test("insufficient evidence resumes the same thread until success within the active budget", async () => {
  const insufficient = completedOutput();
  insufficient.candidates[0].evidence[1].sourceUrl = insufficient.candidates[0].evidence[0].sourceUrl;
  const harness = createHarness({ scripts: [
    { codexThreadId: "thread-evidence", output: insufficient, activeDurationMs: 590_000 },
    { codexThreadId: "thread-evidence", output: completedOutput(), activeDurationMs: 599_000 },
  ] });
  const request = await targetRequest();
  harness.service.prepare();
  await harness.service.claim(request.agentRunId);

  const status = await harness.service.executeTravelResearch(request);

  assert.equal(status.phase, "completed");
  assert.equal(harness.runner.resumeInputs.length, 1);
  assert.equal(harness.runner.resumeInputs[0].codexThreadId, "thread-evidence");
  assert.equal(harness.runner.resumeInputs[0].prompt.includes("证据不足"), true);
});

test("active budget exhaustion after insufficient evidence fails with zero writes", async () => {
  const insufficient = completedOutput();
  insufficient.candidates[0].evidence[1].sourceUrl = insufficient.candidates[0].evidence[0].sourceUrl;
  const harness = createHarness({ scripts: [{
    codexThreadId: "thread-timeout",
    output: insufficient,
    activeDurationMs: 600_000,
  }] });
  const request = await targetRequest();
  harness.service.prepare();
  await harness.service.claim(request.agentRunId);

  const status = await harness.service.executeTravelResearch(request);

  assert.equal(status.phase, "failed");
  assert.equal(status.errorCode, "CODEX_INSUFFICIENT_EVIDENCE");
  assert.equal(harness.transport.submittedPayloads.length, 0);
  assert.equal(harness.runner.resumeInputs.length, 0);
});

test("owner waiting time is excluded when restoring the runner active budget", async () => {
  const request = await targetRequest();
  const initialState = {
    researchTaskId: "research-task-wait",
    codexThreadId: "thread-wait",
    targetCategory: "hotel",
    targetScopeId: request.targetScopeId,
    disclosureFingerprint: request.disclosureFingerprint,
    aliasSalt: "alias-salt-wait-12345",
    blockedReason: "codex_auth_required",
    blockedHostname: null,
    activeRuntimeMs: 42_000,
    phase: "needs_owner_action",
    startedAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:01:00.000Z",
  };
  const harness = createHarness({
    initialState,
    scripts: [{ codexThreadId: "thread-wait", output: completedOutput(), activeDurationMs: 50_000 }],
  });
  harness.clock.advance(31 * 24 * 60 * 60 * 1_000);
  harness.service.prepare();
  await harness.service.claim("agent-run-new");

  await harness.service.resumeTravelResearch({
    agentRunId: "agent-run-new",
    researchTaskId: "research-task-wait",
    resumeAction: "retry_codex_auth",
  });

  assert.deepEqual(harness.runner.createInitialStates[0], {
    codexThreadId: "thread-wait",
    correctionUsed: true,
    activeDurationMs: 42_000,
  });
});

test("inactive, expired, unavailable, isolated, usage and invalid-output runs fail stably with zero writes", async () => {
  for (const [expected, transportOptions, runnerError] of [
    ["AGENT_RUN_INACTIVE", { clearClaimAfterClaim: true }, undefined],
    ["AGENT_RUN_INACTIVE", { claimExpiresAt: "2025-01-01T00:00:00.000Z" }, undefined],
    ["CODEX_NOT_AVAILABLE", undefined, Object.assign(new Error("private"), { code: "CODEX_NOT_AVAILABLE" })],
    ["CODEX_ISOLATION_UNAVAILABLE", undefined, Object.assign(new Error("private"), { code: "CODEX_ISOLATION_UNAVAILABLE" })],
    ["CODEX_USAGE_UNAVAILABLE", undefined, Object.assign(new Error("private"), { code: "CODEX_USAGE_UNAVAILABLE" })],
    ["CODEX_OUTPUT_INVALID", undefined, Object.assign(new Error("private"), { code: "CODEX_OUTPUT_INVALID" })],
  ]) {
    const harness = createHarness({
      transportOptions,
      scripts: runnerError ? [runnerError] : [],
    });
    const request = await targetRequest();
    harness.service.prepare();
    await harness.service.claim(request.agentRunId);

    const status = await harness.service.executeTravelResearch(request);

    assert.equal(status.phase, "failed", expected);
    assert.equal(status.errorCode, expected, expected);
    assert.equal(harness.transport.submittedPayloads.length, 0, expected);
  }
});

test("resume action must match the persisted blocker and cannot carry credentials or URLs", async () => {
  const request = await targetRequest();
  const initialState = {
    researchTaskId: "research-task-auth",
    codexThreadId: "thread-auth",
    targetCategory: "hotel",
    targetScopeId: request.targetScopeId,
    disclosureFingerprint: request.disclosureFingerprint,
    aliasSalt: "alias-salt-auth-12345",
    blockedReason: "codex_auth_required",
    blockedHostname: null,
    activeRuntimeMs: 12_000,
    phase: "needs_owner_action",
    startedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:01:00.000Z",
  };
  const harness = createHarness({ initialState });
  harness.service.prepare();
  await harness.service.claim("agent-run-new");

  await assert.rejects(harness.service.resumeTravelResearch({
    agentRunId: "agent-run-new",
    researchTaskId: "research-task-auth",
    resumeAction: "skip_blocked_source",
  }), { code: "CODEX_RESEARCH_FAILED" });
  assert.equal(harness.runner.createCount, 0);
  assert.deepEqual(harness.store.state, initialState);
  await assert.rejects(harness.service.resumeTravelResearch({
    agentRunId: "agent-run-new",
    researchTaskId: "research-task-auth",
    resumeAction: "retry_codex_auth",
    cookie: "private-cookie",
  }), { code: "CODEX_RESEARCH_FAILED" });
});

test("cancelling during signed context recheck prevents runner creation and candidate writes", async () => {
  let releaseContext;
  const contextGate = new Promise((resolve) => { releaseContext = resolve; });
  const harness = createHarness({
    scripts: [{ codexThreadId: "must-not-run", output: completedOutput(), activeDurationMs: 1 }],
    transportOptions: { contextGate },
  });
  const request = await targetRequest();
  harness.service.prepare();
  await harness.service.claim(request.agentRunId);
  const execution = harness.service.executeTravelResearch(request);
  while (!harness.events.includes("transport.getDecisionContext")) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  const cancellation = harness.service.cancelResearch({ researchTaskId: "research-task-1" });
  releaseContext();
  const [executeStatus, cancelStatus] = await Promise.all([execution, cancellation]);

  assert.equal(executeStatus.phase, "cancelled");
  assert.equal(cancelStatus.phase, "cancelled");
  assert.equal(harness.runner.createCount, 0);
  assert.equal(harness.transport.submittedPayloads.length, 0);
});

test("cancel stops an active runner before validation and produces no candidates", async () => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const harness = createHarness({ scripts: [async ({ session }) => {
    await waiting;
    return {
      codexThreadId: "thread-cancel",
      output: completedOutput(),
      activeDurationMs: 10_000,
      state: session.getState?.(),
    };
  }] });
  const request = await targetRequest();
  harness.service.prepare();
  await harness.service.claim(request.agentRunId);
  const execution = harness.service.executeTravelResearch(request);
  while (!harness.events.includes("runner.runInitial")) await new Promise((resolve) => setImmediate(resolve));

  const cancellation = harness.service.cancelResearch({ researchTaskId: "research-task-1" });
  while (!harness.events.includes("runner.cancel")) await new Promise((resolve) => setImmediate(resolve));
  release();
  const [executeStatus, cancelStatus] = await Promise.all([execution, cancellation]);

  assert.equal(executeStatus.phase, "cancelled");
  assert.equal(cancelStatus.phase, "cancelled");
  assert.equal(harness.transport.submittedPayloads.length, 0);
  assert.equal(harness.store.state, undefined);
});

test("uncertain cloud submit retries an identical payload and writes only once logically", async () => {
  const harness = createHarness({
    scripts: [{ codexThreadId: "thread-submit", output: completedOutput(), activeDurationMs: 20_000 }],
    transportOptions: { uncertainSubmitOnce: true },
  });
  const request = await targetRequest();
  harness.service.prepare();
  await harness.service.claim(request.agentRunId);

  const status = await harness.service.executeTravelResearch(request);

  assert.equal(status.phase, "completed");
  assert.equal(harness.transport.submittedPayloads.length, 2);
  assert.deepEqual(harness.transport.submittedPayloads[0], harness.transport.submittedPayloads[1]);
  assert.equal(
    harness.transport.submittedPayloads[0].candidates[0].evidence[0].capturedAt,
    harness.transport.submittedPayloads[1].candidates[0].evidence[0].capturedAt,
  );
});

test("uncertain blocker revocation fails closed without persistence or a new claimed run", async () => {
  const harness = createHarness({
    scripts: [{ codexThreadId: "thread-block", output: ownerAction(), activeDurationMs: 10_000 }],
    transportOptions: { uncertainRevoke: true },
  });
  const request = await targetRequest();
  harness.service.prepare();
  await harness.service.claim(request.agentRunId);

  const status = await harness.service.executeTravelResearch(request);

  assert.equal(status.phase, "failed");
  assert.equal(status.errorCode, "AGENT_TRANSPORT_UNAVAILABLE");
  assert.equal(harness.events.includes("store.persistNeedsOwnerAction"), false);
  assert.equal(harness.transport.submittedPayloads.length, 0);
});

test("getResearchStatus restores only the safe blocked projection and strict status strips secrets", async () => {
  const request = await targetRequest();
  const initialState = {
    researchTaskId: "research-task-1",
    codexThreadId: "private-thread-id",
    targetCategory: "hotel",
    targetScopeId: request.targetScopeId,
    disclosureFingerprint: request.disclosureFingerprint,
    aliasSalt: "private-alias-salt-1234",
    blockedReason: "source_captcha",
    blockedHostname: "captcha.public.org",
    activeRuntimeMs: 12_345,
    phase: "needs_owner_action",
    startedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:01:00.000Z",
  };
  const harness = createHarness({ initialState });

  const status = await harness.service.getResearchStatus();
  assert.deepEqual(status, {
    phase: "needs_owner_action",
    researchTaskId: "research-task-1",
    startedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:01:00.000Z",
    blockedReason: "source_captcha",
    blockedHostname: "captcha.public.org",
  });
  const serialized = JSON.stringify(status);
  assert.equal(serialized.includes("private-thread-id"), false);
  assert.equal(serialized.includes("private-alias"), false);

  assert.deepEqual(safeResearchStatus({
    phase: "failed",
    researchTaskId: "task-2",
    startedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:01:00.000Z",
    errorCode: "CODEX_RESEARCH_FAILED",
    codexThreadId: "secret",
    output: { private: true },
    detail: "/Users/private/path",
  }), {
    phase: "failed",
    researchTaskId: "task-2",
    startedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:01:00.000Z",
    errorCode: "CODEX_RESEARCH_FAILED",
  });

  for (const blockedHostname of ["127.0.0.1", "agent.localhost", "source.internal"]) {
    assert.throws(() => safeResearchStatus({
      phase: "needs_owner_action",
      researchTaskId: "task-3",
      startedAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:01:00.000Z",
      blockedReason: "source_login_required",
      blockedHostname,
    }), { code: "CODEX_RESEARCH_FAILED" });
  }
});
