import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";

import { buildResearchTargetScopes } from "@travel/contracts/decision-research";

import { buildTravelResearchInput } from "./travel-research-input.mjs";
import { createCodexRunner } from "./codex-runner.mjs";
import { createResearchStateStore } from "./research-state-store.mjs";
import { LocalAgentBridgeRuntime } from "./runtime.mjs";
import { safeResearchStatus, TravelResearchService } from "./travel-research-service.mjs";

const PUBLIC_RESOLVER = async () => [{ address: "93.184.216.34", family: 4 }];
const RECOVERED_OPERATION_IDENTITY = {
  tripId: "trip-private",
  agentRunId: "agent-run-recovered",
  operationId: "operation-recovered",
  reconciliationState: "active",
};

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

function candidateBatchData() {
  return [1, 2].map((index) => ({
    id: `candidate-${index}`,
    tripId: "trip-private",
    revision: 0,
    updatedAt: "2026-09-01T00:01:00.000Z",
    category: "hotel",
    entity: { name: `深圳湾酒店 ${index}`, address: "深圳市南山区" },
    applicability: {
      dates: { start: "2026-10-03", end: "2026-10-03" },
      travelers: 2,
    },
    recommendation: {
      round: 1,
      reason: "靠近行程段",
      preferenceRevisionIds: [],
      feedbackIds: [],
    },
    verificationState: "web_verified",
    decisionState: "tentative",
    currentEvidenceId: `evidence-${index}`,
  }));
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
  clock.set = (value) => { time = typeof value === "string" ? Date.parse(value) : value; };
  return clock;
}

function createControlledClock(start = "2026-09-01T00:00:00.000Z") {
  let time = Date.parse(start);
  let nextTimerId = 1;
  const timers = new Map();
  const clearedTimers = [];
  const clock = () => new Date(time);
  clock.advance = (milliseconds) => { time += milliseconds; };
  clock.setTimeout = (callback, delay) => {
    const timerId = nextTimerId;
    nextTimerId += 1;
    timers.set(timerId, { callback, delay });
    return timerId;
  };
  clock.clearTimeout = (timerId) => {
    const timer = timers.get(timerId);
    if (timer) clearedTimers.push(timer);
    timers.delete(timerId);
  };
  clock.fireNext = () => {
    const next = [...timers.entries()].sort((left, right) => left[1].delay - right[1].delay)[0];
    if (!next) return false;
    const [timerId, timer] = next;
    timers.delete(timerId);
    time += timer.delay;
    timer.callback();
    return true;
  };
  clock.pendingTimers = () => timers.size;
  clock.scheduledTimers = () => nextTimerId - 1;
  clock.nextDelay = () => [...timers.values()].sort((left, right) => left.delay - right.delay)[0]?.delay;
  clock.fireLastCleared = () => {
    const timer = clearedTimers.pop();
    if (!timer) return false;
    timer.callback();
    return true;
  };
  return clock;
}

function createAutoAdvanceClock(start = "2026-09-01T00:00:00.000Z", { parkedDelays = [] } = {}) {
  let time = Date.parse(start);
  const delays = [];
  const clock = () => new Date(time);
  clock.setTimeout = (callback, delay) => {
    const timer = { cancelled: false };
    if (parkedDelays.includes(delay)) return timer;
    delays.push(delay);
    queueMicrotask(() => {
      if (timer.cancelled) return;
      time += delay;
      callback();
    });
    return timer;
  };
  clock.clearTimeout = (timer) => { timer.cancelled = true; };
  clock.delays = delays;
  return clock;
}

function fakeStore(events, initialState, options = {}) {
  let state = initialState && structuredClone(initialState);
  let clearCount = 0;
  let loadCount = 0;
  let proposalPersistCount = 0;
  const currentState = () => state && { ...RECOVERED_OPERATION_IDENTITY, ...state };
  const assertExpected = (value, expected) => {
    const current = currentState();
    if (!isDeepStrictEqual(current, value) && !isDeepStrictEqual(current, expected)) {
      throw Object.assign(new Error("private state conflict"), { code: "RESEARCH_STATE_CONFLICT" });
    }
    return isDeepStrictEqual(current, value);
  };
  return {
    async load() {
      loadCount += 1;
      events.push("store.load");
      if (options.loadFailures?.includes(loadCount)) {
        throw Object.assign(new Error("private load failure"), { code: "RESEARCH_STATE_UNAVAILABLE" });
      }
      if (options.loadError) throw options.loadError;
      options.onLoadStarted?.();
      if (options.loadGate) await options.loadGate;
      return state && structuredClone({ ...RECOVERED_OPERATION_IDENTITY, ...state });
    },
    async clear(expected) {
      clearCount += 1;
      events.push("store.clear");
      if (options.clearGate) await options.clearGate;
      if (options.clearFailures?.includes(clearCount)) {
        throw Object.assign(new Error("private store failure"), { code: "RESEARCH_STATE_UNAVAILABLE" });
      }
      const current = state && { ...RECOVERED_OPERATION_IDENTITY, ...state };
      if (current !== undefined && !isDeepStrictEqual(current, expected)) {
        throw Object.assign(new Error("private state conflict"), { code: "RESEARCH_STATE_CONFLICT" });
      }
      state = undefined;
    },
    async persistNeedsOwnerAction(value, notifier, expected) {
      events.push("store.persistNeedsOwnerAction");
      if (options.persistError) throw options.persistError;
      const replacement = options.replaceBeforeNeedsOwnerAction?.({
        current: currentState() && structuredClone(currentState()),
        value: structuredClone(value),
      });
      if (replacement !== undefined) state = structuredClone(replacement);
      const idempotent = assertExpected(value, expected);
      if (idempotent) return structuredClone(currentState());
      state = structuredClone(value);
      options.onPersistStarted?.();
      if (options.persistGate) await options.persistGate;
      await notifier?.notifyOwnerAction("transition-key");
      return structuredClone(state);
    },
    async persistSelfRevokeReconciliation(value, expected) {
      events.push("store.persistSelfRevokeReconciliation");
      if (options.reconciliationPersistError) throw options.reconciliationPersistError;
      const idempotent = assertExpected(value, expected);
      if (idempotent) return structuredClone(currentState());
      state = structuredClone(value);
      options.onReconciliationPersisted?.(structuredClone(value));
      if (options.transformReconciliationAfterWrite) {
        state = options.transformReconciliationAfterWrite(structuredClone(state));
      }
      if (options.reconciliationPersistErrorAfterWrite) throw options.reconciliationPersistErrorAfterWrite;
      return structuredClone(state);
    },
    async persistProposalReconciliation(value, expected) {
      proposalPersistCount += 1;
      events.push("store.persistProposalReconciliation");
      if (options.proposalPersistFailures?.includes(proposalPersistCount)) {
        throw Object.assign(new Error("private proposal persist failure"), { code: "RESEARCH_STATE_UNAVAILABLE" });
      }
      if (options.proposalPersistError) throw options.proposalPersistError;
      const idempotent = assertExpected(value, expected);
      if (idempotent) return structuredClone(currentState());
      state = structuredClone(value);
      return structuredClone(state);
    },
    get state() { return state && structuredClone(state); },
  };
}

function fakeTransport(events, context, options = {}) {
  let claimed;
  let preparedMaterial;
  let preparationGeneration = 0;
  let contextAttempts = 0;
  let submitAttempts = 0;
  let revokeAttempts = 0;
  let proposalReconciliation;
  const submittedPayloads = [];
  const prepareRevokeSelf = () => {
    if (!claimed) throw Object.assign(new Error("not claimed"), { code: "AGENT_RUN_INACTIVE" });
    const envelope = {
      agentRunId: claimed.agentRunId,
      sequence: claimed.nextSequence,
      idempotencyKey: "revoke-operation-test",
      action: "revokeAgentRunSelf",
      payload: {},
      signature: "s".repeat(86),
    };
    return {
      agentRunId: claimed.agentRunId,
      expiresAt: claimed.expiresAt,
      firstSentAt: Date.parse("2026-09-01T00:00:00.000Z"),
      body: JSON.stringify(envelope),
    };
  };
  const reconcileRevokeSelf = async (snapshot) => {
    events.push("transport.revokeSelf");
    revokeAttempts += 1;
    if (options.revokeGate) await options.revokeGate;
    if (options.uncertainRevoke || revokeAttempts <= (options.uncertainRevokeCount ?? 0)) {
      throw Object.assign(new Error("private revoke detail"), {
        code: "AGENT_TRANSPORT_UNAVAILABLE",
        uncertain: true,
      });
    }
    if (snapshot.agentRunId !== claimed?.agentRunId) {
      throw Object.assign(new Error("inactive"), { code: "AGENT_RUN_INACTIVE" });
    }
    claimed = undefined;
    preparedMaterial = undefined;
    return { ok: true };
  };
  const performSubmit = async (payload) => {
    events.push("transport.submitProposalBatch");
    submittedPayloads.push(structuredClone(payload));
    submitAttempts += 1;
    if (options.submitGate) await options.submitGate;
    if (options.submitError) {
      if (options.clearProposalOnSubmitError) {
        claimed = undefined;
        proposalReconciliation = undefined;
      }
      throw options.submitError;
    }
    if (options.uncertainSubmitOnce && submitAttempts === 1) {
      throw Object.assign(new Error("private network detail"), {
        code: "AGENT_TRANSPORT_UNAVAILABLE",
        uncertain: true,
      });
    }
    if (claimed) claimed.nextSequence += 1;
    return { ok: true, action: "submitProposalBatch", data: { count: payload.candidates.length } };
  };
  return {
    prepare() {
      events.push("transport.prepare");
      preparedMaterial ??= { publicKeyJwk: { kty: "EC", x: `generation-${++preparationGeneration}` } };
      return structuredClone(preparedMaterial);
    },
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
    releaseUnboundClaim(agentRunId) {
      if (claimed?.agentRunId !== agentRunId) return false;
      claimed = undefined;
      preparedMaterial = undefined;
      return true;
    },
    expireUnboundClaim(agentRunId) {
      if (claimed?.agentRunId !== agentRunId) return false;
      claimed = undefined;
      preparedMaterial = undefined;
      return true;
    },
    async getDecisionContext() {
      events.push("transport.getDecisionContext");
      contextAttempts += 1;
      if (options.contextGate) await options.contextGate;
      if (contextAttempts <= (options.uncertainContextCount ?? 0)) {
        throw Object.assign(new Error("private context failure"), {
          code: "AGENT_TRANSPORT_UNAVAILABLE",
          uncertain: true,
        });
      }
      return structuredClone(context);
    },
    async submitProposalBatch(payload) {
      return performSubmit(payload);
    },
    prepareProposalSubmission(payload) {
      if (!claimed) throw Object.assign(new Error("not claimed"), { code: "AGENT_RUN_INACTIVE" });
      if (proposalReconciliation) return structuredClone(proposalReconciliation);
      const envelope = (action, commandPayload, sequence, suffix) => JSON.stringify({
        agentRunId: claimed.agentRunId,
        sequence,
        idempotencyKey: `${action}-${suffix}`,
        action,
        payload: commandPayload,
        signature: "s".repeat(86),
      });
      proposalReconciliation = {
        agentRunId: claimed.agentRunId,
        expiresAt: claimed.expiresAt,
        firstSentAt: Date.parse("2026-09-01T00:00:00.000Z"),
        submitBody: envelope("submitProposalBatch", structuredClone(payload), claimed.nextSequence, "submit"),
        successRevokeBody: envelope("revokeAgentRunSelf", {}, claimed.nextSequence + 1, "success"),
        failureRevokeBody: envelope("revokeAgentRunSelf", {}, claimed.nextSequence, "failure"),
      };
      return structuredClone(proposalReconciliation);
    },
    restoreProposalSubmission(snapshot) {
      proposalReconciliation = structuredClone(snapshot);
      claimed ??= {
        agentRunId: snapshot.agentRunId,
        expiresAt: snapshot.expiresAt,
        nextSequence: JSON.parse(snapshot.submitBody).sequence,
      };
      return true;
    },
    async reconcileProposalSubmission(snapshot) {
      return performSubmit(JSON.parse(snapshot.submitBody).payload);
    },
    restoreProposalRevoke(snapshot, outcome) {
      const body = outcome === "completed" ? snapshot.successRevokeBody : snapshot.failureRevokeBody;
      proposalReconciliation.revokeRequest = {
        agentRunId: snapshot.agentRunId,
        expiresAt: snapshot.expiresAt,
        firstSentAt: snapshot.firstSentAt,
        body,
      };
      return true;
    },
    async reconcileProposalRevoke(snapshot, outcome) {
      this.restoreProposalRevoke(snapshot, outcome);
      return reconcileRevokeSelf(proposalReconciliation.revokeRequest);
    },
    discardPreparedProposalSubmission(snapshot) {
      if (snapshot?.submitBody !== proposalReconciliation?.submitBody) return false;
      proposalReconciliation = undefined;
      return true;
    },
    prepareRevokeSelf,
    discardPreparedRevokeSelf(snapshot) {
      events.push("transport.discardPreparedRevokeSelf");
      if (snapshot?.agentRunId !== claimed?.agentRunId) return false;
      claimed = undefined;
      preparedMaterial = undefined;
      return true;
    },
    reconcileRevokeSelf,
    async revokeSelf() { return reconcileRevokeSelf(prepareRevokeSelf()); },
    submittedPayloads,
  };
}

function fakeRunner(events, scripts) {
  let createCount = 0;
  const initialInputs = [];
  const resumeInputs = [];
  const sessions = [];
  const createOptions = [];
  return {
    resolveHostname: PUBLIC_RESOLVER,
    create(options = {}) {
      createCount += 1;
      createOptions.push(structuredClone(options));
      const initialState = options.initialState;
      events.push(initialState ? `runner.create:${initialState.codexThreadId}` : "runner.create:new");
      let state = initialState && { ...initialState };
      let cancelled = false;
      const session = {
        async runInitial(input) {
          events.push("runner.runInitial");
          assert.equal(typeof input.prompt, "string");
          initialInputs.push(structuredClone(input));
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
    initialInputs,
    resumeInputs,
    sessions,
    createOptions,
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
    tripId: context.workspace.tripId,
    agentRunId: "agent-run-1",
    operationId: "operation-1",
    targetCategory: "hotel",
    targetScopeId,
    disclosureFingerprint: built.disclosureFingerprint,
  };
}

function recoveredReconciliation(request, overrides = {}) {
  return {
    recordType: "self_revoke_reconciliation",
    tripId: "trip-private",
    researchTaskId: "research-task-reconciliation",
    agentRunId: request.agentRunId,
    operationId: request.operationId,
    reconciliationState: "self_revoke_reconciling",
    activePhase: "validating",
    revokeRequest: {
      agentRunId: request.agentRunId,
      expiresAt: "2099-09-01T00:15:00.000Z",
      firstSentAt: Date.parse("2026-09-01T00:00:00.000Z"),
      body: JSON.stringify({
        agentRunId: request.agentRunId,
        sequence: 2,
        idempotencyKey: "revoke-reconciliation-test",
        action: "revokeAgentRunSelf",
        payload: {},
        signature: "s".repeat(86),
      }),
    },
    codexThreadId: "thread-reconciliation",
    targetCategory: "hotel",
    targetScopeId: request.targetScopeId,
    disclosureFingerprint: request.disclosureFingerprint,
    aliasSalt: "alias-salt-reconciliation",
    blockedReason: "codex_auth_required",
    blockedHostname: null,
    activeRuntimeMs: 12_000,
    terminalPhase: "needs_owner_action",
    startedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:01:00.000Z",
    ...overrides,
  };
}

function createHarness({
  context = contextFixture(),
  scripts = [],
  transportOptions,
  initialState,
  clock = createClock(),
  runnerFactory,
  transportFactory,
  storeOptions,
} = {}) {
  const events = [];
  const store = fakeStore(events, initialState, storeOptions);
  const notifier = { async notifyOwnerAction() { events.push("notifier.notifyOwnerAction"); return true; } };
  const transport = transportFactory
    ? transportFactory(events, clock)
    : fakeTransport(events, context, transportOptions);
  const runner = runnerFactory ? runnerFactory(events) : fakeRunner(events, [...scripts]);
  const generated = [
    "research-task-1", "alias-salt-1234567890",
    "research-task-2", "alias-salt-2234567890",
    "research-task-3", "alias-salt-3234567890",
  ];
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

async function cancelCurrentResearch(service) {
  const status = await service.getResearchStatus("trip-private");
  assert.notEqual(status.phase, "idle");
  return service.cancelResearch({
    tripId: status.tripId,
    researchTaskId: status.researchTaskId,
    agentRunId: status.agentRunId,
    operationId: status.operationId,
  });
}

test("happy path starts Codex only after prepare/claim and writes one validated batch before revoke", async () => {
  const harness = createHarness({ scripts: [{
    codexThreadId: "codex-thread-1",
    output: completedOutput(),
    activeDurationMs: 12_000,
  }] });
  const request = await targetRequest();

  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);
  assert.equal(harness.runner.createCount, 0);
  assert.deepEqual(harness.events, ["transport.prepare", "transport.claim:agent-run-1"]);

  const status = await harness.service.executeTravelResearch(request);

  assert.deepEqual(status, {
    phase: "completed",
    tripId: "trip-private",
    researchTaskId: "research-task-1",
    agentRunId: request.agentRunId,
    operationId: request.operationId,
    reconciliationState: "active",
    startedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  });
  assert.deepEqual(harness.events, [
    "transport.prepare",
    "transport.claim:agent-run-1",
    "store.load",
    "transport.getDecisionContext",
    "runner.create:new",
    "runner.runInitial",
    "store.clear",
    "store.persistProposalReconciliation",
    "transport.submitProposalBatch",
    "transport.revokeSelf",
    "store.clear",
  ]);
  assert.equal(harness.transport.submittedPayloads.length, 1);
  assert.equal(harness.transport.submittedPayloads[0].candidates.length, 2);
  assert.equal(harness.runner.initialInputs[0].prompt.includes(request.agentRunId), false);
  assert.equal(harness.runner.initialInputs[0].prompt.includes(request.operationId), false);
  assert.equal(harness.runner.initialInputs[0].prompt.includes(request.tripId), false);
});

test("store clear is a mandatory safety gate before the first signed submit", async () => {
  const harness = createHarness({
    scripts: [{ codexThreadId: "thread-store-gate", output: completedOutput(), activeDurationMs: 10_000 }],
    storeOptions: { clearFailures: [1] },
  });
  const request = await targetRequest();
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);

  const status = await harness.service.executeTravelResearch(request);

  assert.equal(status.phase, "failed");
  assert.equal(harness.transport.submittedPayloads.length, 0);
  assert.equal(harness.events.includes("transport.revokeSelf"), true);
  assert.equal(harness.events.filter((event) => event === "store.clear").length, 2);
});

test("cancel during the store safety gate prevents the first signed submit", async () => {
  let releaseClear;
  const clearGate = new Promise((resolve) => { releaseClear = resolve; });
  const harness = createHarness({
    scripts: [{ codexThreadId: "thread-store-cancel", output: completedOutput(), activeDurationMs: 10_000 }],
    storeOptions: { clearGate },
  });
  const request = await targetRequest();
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);
  const execution = harness.service.executeTravelResearch(request);
  while (!harness.events.includes("store.clear")) await new Promise((resolve) => setImmediate(resolve));

  const cancellation = cancelCurrentResearch(harness.service);
  releaseClear();
  const [executeStatus, cancelStatus] = await Promise.all([execution, cancellation]);

  assert.equal(executeStatus.phase, "cancelled");
  assert.equal(cancelStatus.phase, "cancelled");
  assert.equal(harness.transport.submittedPayloads.length, 0);
  assert.equal(harness.events.includes("transport.revokeSelf"), true);
});

test("an existing blocked recovery prevents execute from replacing it or creating a runner", async () => {
  const request = await targetRequest();
  const initialState = {
    researchTaskId: "research-task-existing",
    codexThreadId: "thread-existing",
    targetCategory: "hotel",
    targetScopeId: request.targetScopeId,
    disclosureFingerprint: request.disclosureFingerprint,
    aliasSalt: "alias-salt-existing-1234",
    blockedReason: "codex_auth_required",
    blockedHostname: null,
    activeRuntimeMs: 12_000,
    phase: "needs_owner_action",
    startedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:01:00.000Z",
  };
  const harness = createHarness({
    initialState,
    scripts: [{ codexThreadId: "must-not-run", output: completedOutput(), activeDurationMs: 1 }],
  });
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);

  await assert.rejects(harness.service.executeTravelResearch(request), { code: "CODEX_RESEARCH_FAILED" });

  assert.equal((await harness.service.getResearchStatus("trip-private")).researchTaskId, initialState.researchTaskId);
  assert.equal(harness.runner.createCount, 0);
  assert.equal(harness.events.includes("transport.getDecisionContext"), false);
  assert.deepEqual(harness.store.state, initialState);
  assert.equal(harness.transport.claimedRun, undefined);
  assert.doesNotThrow(() => harness.service.prepare("trip-private"));
});

test("execute fails closed when recovery state cannot be loaded", async () => {
  const harness = createHarness({
    scripts: [{ codexThreadId: "must-not-run", output: completedOutput(), activeDurationMs: 1 }],
    storeOptions: {
      loadError: Object.assign(new Error("private store failure"), { code: "RESEARCH_STATE_UNAVAILABLE" }),
    },
  });
  const request = await targetRequest();
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);

  await assert.rejects(harness.service.executeTravelResearch(request), { code: "CODEX_RESEARCH_FAILED" });
  await assert.rejects(harness.service.executeTravelResearch(request), { code: "CODEX_RESEARCH_FAILED" });

  assert.equal(harness.runner.createCount, 0);
  assert.equal(harness.events.includes("transport.getDecisionContext"), false);
  assert.equal(harness.events.includes("store.clear"), false);
  assert.equal(harness.events.filter((event) => event === "store.load").length, 2);
});

test("execute publishes an exact admission before a delayed recovery load so lifecycle cleanup can cancel it", async () => {
  let releaseLoad;
  let loadStarted;
  const loadGate = new Promise((resolve) => { releaseLoad = resolve; });
  const observedLoad = new Promise((resolve) => { loadStarted = resolve; });
  const harness = createHarness({
    storeOptions: { loadGate, onLoadStarted: loadStarted },
    scripts: [{ codexThreadId: "must-not-start", output: completedOutput(), activeDurationMs: 1 }],
  });
  const request = await targetRequest();
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);

  const execution = harness.service.executeTravelResearch(request);
  await observedLoad;
  const observedStatus = await harness.service.getResearchStatus("trip-private");

  assert.deepEqual(observedStatus, {
    phase: "researching",
    tripId: "trip-private",
    researchTaskId: "research-task-1",
    agentRunId: request.agentRunId,
    operationId: request.operationId,
    reconciliationState: "active",
    startedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    progress: {
      stage: "collecting_candidates",
      candidateCount: 0,
      previews: [],
      firstResultDeadlineAt: "2026-09-01T00:03:00.000Z",
    },
  });
  const cancellation = harness.service.cancelResearch({
    tripId: "trip-private",
    researchTaskId: observedStatus.researchTaskId,
    agentRunId: observedStatus.agentRunId,
    operationId: observedStatus.operationId,
  });
  releaseLoad();

  const [executed, cancelledStatus] = await Promise.all([execution, cancellation]);
  assert.equal(executed.phase, "cancelled");
  assert.equal(cancelledStatus.phase, "cancelled");
  assert.equal(harness.runner.createCount, 0);
  assert.equal(harness.transport.claimedRun, undefined);
});

test("a failed prepare for another trip cannot replace the trip bound to the claimed capability", async () => {
  const harness = createHarness({
    scripts: [{ codexThreadId: "thread-prepare-binding", output: completedOutput(), activeDurationMs: 10 }],
    transportFactory(events) {
      const transport = fakeTransport(events, contextFixture());
      const prepare = transport.prepare.bind(transport);
      let attempts = 0;
      transport.prepare = () => {
        attempts += 1;
        if (attempts === 2) throw Object.assign(new Error("busy"), { code: "BRIDGE_BUSY" });
        return prepare();
      };
      return transport;
    },
  });
  const request = await targetRequest();
  harness.service.prepare(request.tripId);
  await harness.service.claim(request.agentRunId);

  assert.throws(() => harness.service.prepare("trip-other"), { code: "BRIDGE_BUSY" });
  const result = await harness.service.executeTravelResearch(request);

  assert.equal(result.phase, "completed");
  assert.equal(harness.runner.createCount, 1);
});

test("a reused unclaimed capability cannot move from its prepared trip to another trip", async () => {
  const actions = [];
  const harness = createHarness({
    scripts: [{ codexThreadId: "thread-prepare-capability", output: completedOutput(), activeDurationMs: 10 }],
    transportFactory(events, runtimeClock) {
      const runtime = new LocalAgentBridgeRuntime({
        agentEndpoint: "https://api.public.org/api/agent",
        now: runtimeClock,
        fetch: async (_url, init) => {
          const body = JSON.parse(init.body);
          actions.push(body.action);
          if (body.action === "claimAgentRun") {
            return Response.json({ ok: true, data: {
              agentRunId: body.agentRunId,
              claimedAt: "2026-09-01T00:00:00.000Z",
              expiresAt: "2026-09-01T00:15:00.000Z",
              nextSequence: 1,
            } });
          }
          if (body.action === "getDecisionContext") {
            return Response.json({ ok: true, action: body.action, data: contextFixture() });
          }
          if (body.action === "submitProposalBatch") {
            return Response.json({ ok: true, action: body.action, data: candidateBatchData() });
          }
          assert.equal(body.action, "revokeAgentRunSelf");
          return Response.json({ ok: true, action: body.action, data: {
            agentRunId: body.agentRunId,
            revokedAt: runtimeClock().toISOString(),
          } });
        },
      });
      const release = runtime.releaseUnboundClaim.bind(runtime);
      runtime.releaseUnboundClaim = (agentRunId) => {
        events.push("transport.releaseUnboundClaim");
        return release(agentRunId);
      };
      return runtime;
    },
  });
  const request = await targetRequest();
  const material = harness.service.prepare(request.tripId);

  assert.throws(() => harness.service.prepare("trip-other"), { code: "CODEX_RESEARCH_FAILED" });
  assert.deepEqual(harness.transport.prepare(), material);
  await harness.service.claim(request.agentRunId);
  const result = await harness.service.executeTravelResearch(request);

  assert.equal(result.phase, "completed");
  assert.equal(harness.runner.createCount, 1);
  assert.equal(harness.events.includes("transport.releaseUnboundClaim"), false);
  assert.deepEqual(actions, [
    "claimAgentRun",
    "getDecisionContext",
    "submitProposalBatch",
    "revokeAgentRunSelf",
  ]);
});

test("a real runtime releases an unbound claim when execute fails before creating a task", async () => {
  const harness = createHarness({
    storeOptions: {
      loadError: Object.assign(new Error("private store failure"), { code: "RESEARCH_STATE_UNAVAILABLE" }),
    },
    transportFactory(_events, runtimeClock) {
      return new LocalAgentBridgeRuntime({
        agentEndpoint: "https://api.public.org/api/agent",
        now: runtimeClock,
        fetch: async (_url, init) => {
          const body = JSON.parse(init.body);
          assert.equal(body.action, "claimAgentRun");
          return Response.json({
            ok: true,
            data: {
              agentRunId: body.agentRunId,
              claimedAt: "2026-09-01T00:00:00.000Z",
              expiresAt: "2026-09-01T00:15:00.000Z",
              nextSequence: 1,
            },
          });
        },
      });
    },
  });
  const request = await targetRequest();
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);

  await assert.rejects(harness.service.executeTravelResearch(request), { code: "CODEX_RESEARCH_FAILED" });

  assert.equal(harness.transport.claimedRun, undefined);
  assert.doesNotThrow(() => harness.service.prepare("trip-private"));
});

test("a pre-task execute failure preserves a real runtime claim with an uncertain signed envelope", async () => {
  let contextAttempts = 0;
  const harness = createHarness({
    storeOptions: {
      loadError: Object.assign(new Error("private store failure"), { code: "RESEARCH_STATE_UNAVAILABLE" }),
    },
    transportFactory(_events, runtimeClock) {
      return new LocalAgentBridgeRuntime({
        agentEndpoint: "https://api.public.org/api/agent",
        now: runtimeClock,
        fetch: async (_url, init) => {
          const body = JSON.parse(init.body);
          if (body.action === "claimAgentRun") {
            return Response.json({
              ok: true,
              data: {
                agentRunId: body.agentRunId,
                claimedAt: "2026-09-01T00:00:00.000Z",
                expiresAt: "2026-09-01T00:15:00.000Z",
                nextSequence: 1,
              },
            });
          }
          assert.equal(body.action, "getDecisionContext");
          contextAttempts += 1;
          throw new TypeError("response lost");
        },
      });
    },
  });
  const request = await targetRequest();
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);
  await assert.rejects(harness.transport.getDecisionContext(), { code: "AGENT_TRANSPORT_UNAVAILABLE", uncertain: true });

  await assert.rejects(harness.service.executeTravelResearch(request), { code: "CODEX_RESEARCH_FAILED" });

  assert.equal(contextAttempts, 1);
  assert.equal(harness.transport.claimedRun?.agentRunId, request.agentRunId);
  assert.throws(() => harness.service.prepare("trip-private"), /BRIDGE_BUSY/);
});

test("service composes with a real createCodexRunner session contract", async () => {
  const output = completedOutput();
  const runnerFactory = (events) => ({
    resolveHostname: PUBLIC_RESOLVER,
    create(options) {
      events.push("runner.create:real");
      return createCodexRunner({
        codexPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
        isolatedDir: "/isolated",
        projectDir: "/project",
        schemaPath: "/schema.json",
        activeTimeoutMs: options.activeTimeoutMs,
        ...(options.initialState ? { initialState: options.initialState } : {}),
        sourceEnv: {
          PATH: "/usr/bin:/bin",
          HOME: "/Users/owner",
          CODEX_HOME: "/Users/owner/.codex",
        },
        pathVerifier: async (paths) => paths,
        probeIsolation: async () => ({
          isolatedDirectoryReadable: true,
          outsideDirectoryUnreadable: true,
          projectDirectoryUnreadable: true,
          httpsNetworkAvailable: true,
          authenticationAvailable: true,
          persistenceAvailable: true,
        }),
        processKillImpl: () => { throw new Error("successful fake child must not be killed"); },
        spawnImpl: () => {
          const child = new EventEmitter();
          child.pid = 40_001;
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          child.stdin = new EventEmitter();
          child.stdin.end = () => {};
          queueMicrotask(() => {
            child.stdout.emit("data", Buffer.from([
              JSON.stringify({ type: "thread.started", thread_id: "thread-real-contract" }),
              JSON.stringify({
                type: "session_configured",
                session_id: "thread-real-contract",
                approval_policy: "never",
                active_permission_profile: { id: "travel_research" },
              }),
              JSON.stringify({ type: "item.completed", item: { type: "web_search" } }),
              JSON.stringify({
                type: "item.completed",
                item: { type: "agent_message", text: JSON.stringify(output) },
              }),
              JSON.stringify({ type: "turn.completed" }),
              "",
            ].join("\n")));
            child.emit("close", 0);
          });
          return child;
        },
      });
    },
  });
  const harness = createHarness({ runnerFactory });
  const request = await targetRequest();
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);

  const status = await harness.service.executeTravelResearch(request);

  assert.equal(status.phase, "completed");
  assert.equal(harness.transport.submittedPayloads.length, 1);
  assert.equal(harness.events.includes("runner.create:real"), true);
});

test("a real runtime keeps a pending signed submit alive past the service deadline and then completes revoke", async () => {
  let releaseSubmit;
  const submitGate = new Promise((resolve) => { releaseSubmit = resolve; });
  const actions = [];
  const submitBodies = [];
  const clock = createControlledClock();
  const harness = createHarness({
    clock,
    scripts: [{
      codexThreadId: "thread-real-runtime",
      output: completedOutput(),
      activeDurationMs: 599_990,
    }],
    transportFactory(_events, runtimeClock) {
      return new LocalAgentBridgeRuntime({
        agentEndpoint: "https://api.public.org/api/agent",
        now: runtimeClock,
        fetch: async (_url, init) => {
          const body = JSON.parse(init.body);
          actions.push(body.action);
          if (body.action === "claimAgentRun") {
            return Response.json({
              ok: true,
              data: {
                agentRunId: body.agentRunId,
                claimedAt: "2026-09-01T00:00:00.000Z",
                expiresAt: "2026-09-01T00:15:00.000Z",
                nextSequence: 1,
              },
            });
          }
          if (body.action === "getDecisionContext") {
            return Response.json({ ok: true, action: body.action, data: contextFixture() });
          }
          if (body.action === "submitProposalBatch") {
            submitBodies.push(init.body);
            await submitGate;
            return Response.json({
              ok: true,
              action: body.action,
              data: candidateBatchData(),
            });
          }
          assert.equal(body.action, "revokeAgentRunSelf");
          return Response.json({
            ok: true,
            action: body.action,
            data: { agentRunId: body.agentRunId, revokedAt: runtimeClock().toISOString() },
          });
        },
      });
    },
  });
  const request = await targetRequest();
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);
  const execution = harness.service.executeTravelResearch(request);
  while (!actions.includes("submitProposalBatch")) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  const timerFired = clock.fireNext();
  clock.advance(20_000);
  await new Promise((resolve) => setImmediate(resolve));
  const pendingStatus = await harness.service.getResearchStatus("trip-private");
  const claimedWhilePending = harness.transport.claimedRun;
  releaseSubmit();
  const status = await execution;

  assert.equal(timerFired, false);
  assert.equal(pendingStatus.phase, "writing");
  assert.equal(claimedWhilePending.agentRunId, request.agentRunId);
  assert.equal(status.phase, "completed");
  assert.deepEqual(actions, [
    "claimAgentRun",
    "getDecisionContext",
    "submitProposalBatch",
    "revokeAgentRunSelf",
  ]);
  assert.equal(submitBodies.length, 1);
  assert.equal(harness.transport.claimedRun, undefined);
  assert.equal(harness.events.includes("store.clear"), true);
});

test("a definite real-runtime submit failure revokes and releases the capability", async () => {
  const actions = [];
  const harness = createHarness({
    scripts: [{
      codexThreadId: "thread-real-runtime-definite",
      output: completedOutput(),
      activeDurationMs: 10_000,
    }],
    transportFactory(_events, runtimeClock) {
      return new LocalAgentBridgeRuntime({
        agentEndpoint: "https://api.public.org/api/agent",
        now: runtimeClock,
        fetch: async (_url, init) => {
          const body = JSON.parse(init.body);
          actions.push(body.action);
          if (body.action === "claimAgentRun") {
            return Response.json({
              ok: true,
              data: {
                agentRunId: body.agentRunId,
                claimedAt: "2026-09-01T00:00:00.000Z",
                expiresAt: "2026-09-01T00:15:00.000Z",
                nextSequence: 1,
              },
            });
          }
          if (body.action === "getDecisionContext") {
            return Response.json({ ok: true, action: body.action, data: contextFixture() });
          }
          if (body.action === "submitProposalBatch") {
            return Response.json({ ok: false, error: "INVALID_REQUEST" }, { status: 400 });
          }
          assert.equal(body.action, "revokeAgentRunSelf");
          return Response.json({
            ok: true,
            action: body.action,
            data: { agentRunId: body.agentRunId, revokedAt: "2026-09-01T00:01:00.000Z" },
          });
        },
      });
    },
  });
  const request = await targetRequest();
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);

  const status = await harness.service.executeTravelResearch(request);

  assert.equal(status.phase, "failed");
  assert.equal(status.errorCode, "CODEX_RESEARCH_FAILED");
  assert.deepEqual(actions, [
    "claimAgentRun",
    "getDecisionContext",
    "submitProposalBatch",
    "revokeAgentRunSelf",
  ]);
  assert.equal(harness.transport.claimedRun, undefined);
  assert.equal(harness.events.includes("store.clear"), true);
  assert.doesNotThrow(() => harness.service.prepare("trip-private"));
});

test("external AgentRun revocation lets cancel release the real runtime capability and prepare again", async () => {
  let releaseRunner;
  let runnerStarted;
  const runnerGate = new Promise((resolve) => { releaseRunner = resolve; });
  const observedRunner = new Promise((resolve) => { runnerStarted = resolve; });
  const actions = [];
  const harness = createHarness({
    scripts: [async () => {
      runnerStarted();
      await runnerGate;
      return {
        codexThreadId: "thread-external-revoke",
        output: completedOutput(),
        activeDurationMs: 10_000,
        state: { codexThreadId: "thread-external-revoke", correctionUsed: false, activeDurationMs: 10_000 },
      };
    }],
    transportFactory(_events, runtimeClock) {
      return new LocalAgentBridgeRuntime({
        agentEndpoint: "https://api.public.org/api/agent",
        now: runtimeClock,
        fetch: async (_url, init) => {
          const body = JSON.parse(init.body);
          actions.push(body.action);
          if (body.action === "claimAgentRun") {
            return Response.json({
              ok: true,
              data: {
                agentRunId: body.agentRunId,
                claimedAt: "2026-09-01T00:00:00.000Z",
                expiresAt: "2026-09-01T00:15:00.000Z",
                nextSequence: 1,
              },
            });
          }
          if (body.action === "getDecisionContext") {
            return Response.json({ ok: true, action: body.action, data: contextFixture() });
          }
          assert.equal(body.action, "revokeAgentRunSelf");
          return Response.json({ ok: false, error: "INVALID_AGENT_CLAIM" }, { status: 403 });
        },
      });
    },
  });
  const request = await targetRequest();
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);
  const execution = harness.service.executeTravelResearch(request);
  await observedRunner;

  const cancellation = cancelCurrentResearch(harness.service);
  releaseRunner();
  const [executeStatus, cancelStatus] = await Promise.all([execution, cancellation]);

  assert.equal(executeStatus.phase, "cancelled");
  assert.equal(cancelStatus.phase, "cancelled");
  assert.equal(harness.transport.claimedRun, undefined);
  assert.doesNotThrow(() => harness.service.prepare("trip-private"));
  assert.deepEqual(actions, ["claimAgentRun", "getDecisionContext", "revokeAgentRunSelf"]);
});

test("two lost real-runtime submit responses replay one envelope until the third is determined", async () => {
  const actions = [];
  const submitBodies = [];
  const harness = createHarness({
    scripts: [{
      codexThreadId: "thread-real-runtime-uncertain",
      output: completedOutput(),
      activeDurationMs: 10_000,
    }],
    transportFactory(_events, runtimeClock) {
      return new LocalAgentBridgeRuntime({
        agentEndpoint: "https://api.public.org/api/agent",
        now: runtimeClock,
        fetch: async (_url, init) => {
          const body = JSON.parse(init.body);
          actions.push(body.action);
          if (body.action === "claimAgentRun") {
            return Response.json({
              ok: true,
              data: {
                agentRunId: body.agentRunId,
                claimedAt: "2026-09-01T00:00:00.000Z",
                expiresAt: "2026-09-01T00:15:00.000Z",
                nextSequence: 1,
              },
            });
          }
          if (body.action === "getDecisionContext") {
            return Response.json({ ok: true, action: body.action, data: contextFixture() });
          }
          if (body.action === "revokeAgentRunSelf") {
            return Response.json({
              ok: true,
              action: body.action,
              data: { agentRunId: body.agentRunId, revokedAt: "2026-09-01T00:02:00.000Z" },
            });
          }
          assert.equal(body.action, "submitProposalBatch");
          submitBodies.push(init.body);
          if (submitBodies.length <= 2) throw new TypeError("fake response lost");
          return Response.json({
            ok: true,
            action: body.action,
            data: candidateBatchData(),
            replayed: true,
          });
        },
      });
    },
  });
  const request = await targetRequest();
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);

  const status = await harness.service.executeTravelResearch(request);

  assert.equal(status.phase, "completed");
  assert.equal(submitBodies.length, 3);
  assert.equal(submitBodies[0], submitBodies[1]);
  assert.equal(submitBodies[1], submitBodies[2]);
  assert.equal(actions.includes("revokeAgentRunSelf"), true);
  assert.equal(harness.transport.claimedRun, undefined);
});

test("an uncertain proposal response persists exact replay responsibility and converges after restart", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "travel-submit-restart-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "application-data");
  const clock = createControlledClock();
  const scheduleTimer = clock.setTimeout.bind(clock);
  let firstProcessTerminated = false;
  clock.setTimeout = (callback, delay) => {
    if (firstProcessTerminated) throw new Error("simulated process termination");
    return scheduleTimer(callback, delay);
  };
  const request = await targetRequest();
  const firstSubmitBodies = [];
  const restartedSubmitBodies = [];
  const restartedRevokeBodies = [];

  const firstRuntime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.public.org/api/agent",
    now: clock,
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.action === "claimAgentRun") {
        return Response.json({
          ok: true,
          data: {
            agentRunId: body.agentRunId,
            claimedAt: "2026-09-01T00:00:00.000Z",
            expiresAt: "2026-09-01T00:15:00.000Z",
            nextSequence: 1,
          },
        });
      }
      if (body.action === "getDecisionContext") {
        return Response.json({ ok: true, action: body.action, data: contextFixture() });
      }
      assert.equal(body.action, "submitProposalBatch");
      firstSubmitBodies.push(init.body);
      firstProcessTerminated = true;
      throw new TypeError("server committed but response was lost before process crash");
    },
  });
  const firstStore = createResearchStateStore({ directory, resolveHostname: PUBLIC_RESOLVER });
  const firstRunner = fakeRunner([], [{
    codexThreadId: "thread-submit-restart",
    output: completedOutput(),
    activeDurationMs: 10_000,
  }]);
  const firstService = new TravelResearchService({
    transport: firstRuntime,
    runner: firstRunner,
    store: firstStore,
    notifier: { async notifyOwnerAction() { return true; } },
    clock,
    idGenerator: (() => {
      const generated = ["research-task-submit-restart", "alias-salt-submit-restart"];
      return () => generated.shift();
    })(),
  });
  firstService.prepare(request.tripId);
  await firstService.claim(request.agentRunId);
  const firstExecution = firstService.executeTravelResearch(request);
  while (firstSubmitBodies.length === 0) await new Promise((resolve) => setImmediate(resolve));

  const stoppedStatus = await firstExecution;
  assert.equal(stoppedStatus.phase, "writing");
  assert.equal(clock.pendingTimers(), 0);
  const stoppedSubmitCount = firstSubmitBodies.length;

  const persisted = await firstStore.load();
  assert.equal(persisted.recordType, "proposal_submit_reconciliation");
  assert.equal(persisted.tripId, request.tripId);
  assert.equal(persisted.agentRunId, request.agentRunId);
  assert.equal(persisted.operationId, request.operationId);
  assert.equal(JSON.stringify(persisted).includes("privateKey"), false);
  assert.equal(JSON.stringify(persisted).includes("pairingCode"), false);

  const restartedClock = createControlledClock();
  const restartedRuntime = new LocalAgentBridgeRuntime({
    agentEndpoint: "https://api.public.org/api/agent",
    now: restartedClock,
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.action === "submitProposalBatch") {
        restartedSubmitBodies.push(init.body);
        return Response.json({
          ok: true,
          action: body.action,
          data: candidateBatchData(),
          replayed: true,
        });
      }
      assert.equal(body.action, "revokeAgentRunSelf");
      restartedRevokeBodies.push(init.body);
      return Response.json({
        ok: true,
        action: body.action,
        data: { agentRunId: body.agentRunId, revokedAt: "2026-09-01T00:02:00.000Z" },
      });
    },
  });
  const restartedStore = createResearchStateStore({ directory, resolveHostname: PUBLIC_RESOLVER });
  const restartedRunner = fakeRunner([], []);
  const restartedService = new TravelResearchService({
    transport: restartedRuntime,
    runner: restartedRunner,
    store: restartedStore,
    notifier: { async notifyOwnerAction() { return true; } },
    clock: restartedClock,
    idGenerator: () => "must-not-generate",
  });

  assert.equal((await restartedService.getResearchStatus(request.tripId)).phase, "writing");
  let restartedStatus;
  do {
    await new Promise((resolve) => setImmediate(resolve));
    restartedStatus = await restartedService.getResearchStatus(request.tripId);
  } while (restartedStatus.phase === "writing");

  assert.equal(restartedStatus.phase, "completed");
  assert.equal(restartedRunner.createCount, 0);
  assert.equal(restartedSubmitBodies.length, 1);
  assert.equal(restartedSubmitBodies[0], firstSubmitBodies[0]);
  assert.equal(restartedRevokeBodies.length, 1);
  assert.equal(restartedRevokeBodies[0], persisted.submission.successRevokeBody);
  assert.equal(firstSubmitBodies.length, stoppedSubmitCount);
  assert.equal(await restartedStore.load(), undefined);
});

test("a confirmed proposal remains recoverable until final responsibility cleanup succeeds", async () => {
  const harness = createHarness({
    scripts: [{ codexThreadId: "thread-final-clear-retry", output: completedOutput(), activeDurationMs: 10_000 }],
    storeOptions: { clearFailures: [2] },
  });
  const request = await targetRequest();
  harness.service.prepare(request.tripId);
  await harness.service.claim(request.agentRunId);

  const pending = await harness.service.executeTravelResearch(request);

  assert.equal(pending.phase, "writing");
  assert.equal(harness.store.state.recordType, "proposal_submit_reconciliation");
  assert.equal(harness.transport.submittedPayloads.length, 1);

  let status = await harness.service.getResearchStatus(request.tripId);
  do {
    await new Promise((resolve) => setImmediate(resolve));
    status = await harness.service.getResearchStatus(request.tripId);
  } while (status.phase === "writing");

  assert.equal(status.phase, "completed");
  assert.equal(harness.transport.submittedPayloads.length, 2);
  assert.deepEqual(harness.transport.submittedPayloads[0], harness.transport.submittedPayloads[1]);
  assert.equal(harness.store.state, undefined);
});

test("an uncertain persistence readback retries in-process before any proposal is sent", async () => {
  const harness = createHarness({
    scripts: [{ codexThreadId: "thread-persist-retry", output: completedOutput(), activeDurationMs: 10_000 }],
    storeOptions: {
      proposalPersistFailures: [1],
      loadFailures: [2],
    },
  });
  const request = await targetRequest();
  harness.service.prepare(request.tripId);
  await harness.service.claim(request.agentRunId);

  const pending = await harness.service.executeTravelResearch(request);

  assert.equal(pending.phase, "writing");
  assert.equal(harness.transport.submittedPayloads.length, 0);
  assert.equal(harness.store.state, undefined);

  let status = await harness.service.getResearchStatus(request.tripId);
  for (let attempt = 0; attempt < 10 && status.phase === "writing"; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    status = await harness.service.getResearchStatus(request.tripId);
  }

  assert.equal(status.phase, "completed");
  assert.equal(harness.transport.submittedPayloads.length, 1);
  assert.equal(harness.store.state, undefined);
});

test("cancel retries an uncertain unsent persistence responsibility before terminal submission", async () => {
  const harness = createHarness({
    scripts: [{ codexThreadId: "thread-persist-cancel", output: completedOutput(), activeDurationMs: 10_000 }],
    storeOptions: {
      proposalPersistFailures: [1],
      loadFailures: [2],
    },
  });
  const request = await targetRequest();
  harness.service.prepare(request.tripId);
  await harness.service.claim(request.agentRunId);
  const pending = await harness.service.executeTravelResearch(request);
  assert.equal(pending.phase, "writing");
  assert.equal(harness.transport.submittedPayloads.length, 0);

  const status = await harness.service.cancelResearch({
    tripId: pending.tripId,
    researchTaskId: pending.researchTaskId,
    agentRunId: pending.agentRunId,
    operationId: pending.operationId,
  });

  assert.equal(status.phase, "completed");
  assert.equal(harness.transport.submittedPayloads.length, 1);
  assert.equal(harness.store.state, undefined);
});

test("a definitive expired or invalid proposal submit clears recovery and fails without attempting revoke", async (context) => {
  for (const code of ["AGENT_RUN_EXPIRED", "INVALID_AGENT_CLAIM"]) {
    await context.test(code, async () => {
      const harness = createHarness({
        scripts: [{ codexThreadId: `thread-inactive-submit-${code}`, output: completedOutput(), activeDurationMs: 10_000 }],
        transportOptions: {
          submitError: Object.assign(new Error("inactive"), { code }),
          clearProposalOnSubmitError: true,
        },
      });
      const request = await targetRequest();
      harness.service.prepare(request.tripId);
      await harness.service.claim(request.agentRunId);

      const status = await harness.service.executeTravelResearch(request);

      assert.equal(status.phase, "failed");
      assert.equal(status.errorCode, "AGENT_RUN_INACTIVE");
      assert.equal(harness.store.state, undefined);
      assert.equal(harness.events.includes("transport.revokeSelf"), false);
    });
  }
});

test("a competing owner-action path cannot replace or act after proposal ownership wins", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "travel-owner-action-cas-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "application-data");
  const proposalStore = createResearchStateStore({ directory, resolveHostname: PUBLIC_RESOLVER });
  const blockerBaseStore = createResearchStateStore({ directory, resolveHostname: PUBLIC_RESOLVER });
  let releaseBlockerPersist;
  let observeBlockerPersist;
  const blockerPersistGate = new Promise((resolve) => { releaseBlockerPersist = resolve; });
  const blockerPersistStarted = new Promise((resolve) => { observeBlockerPersist = resolve; });
  const blockerStore = {
    load: (...args) => blockerBaseStore.load(...args),
    clear: (...args) => blockerBaseStore.clear(...args),
    save: (...args) => blockerBaseStore.save(...args),
    persistNeedsOwnerAction: (...args) => blockerBaseStore.persistNeedsOwnerAction(...args),
    async persistSelfRevokeReconciliation(...args) {
      observeBlockerPersist();
      await blockerPersistGate;
      return blockerBaseStore.persistSelfRevokeReconciliation(...args);
    },
    persistProposalReconciliation: (...args) => blockerBaseStore.persistProposalReconciliation(...args),
  };
  const proposalEvents = [];
  const blockerEvents = [];
  let releaseProposalSubmit;
  const proposalSubmitGate = new Promise((resolve) => { releaseProposalSubmit = resolve; });
  const proposalTransport = fakeTransport(proposalEvents, contextFixture(), { submitGate: proposalSubmitGate });
  const blockerTransport = fakeTransport(blockerEvents, contextFixture());
  const proposalService = new TravelResearchService({
    transport: proposalTransport,
    runner: fakeRunner(proposalEvents, [{ codexThreadId: "thread-owner-cas-proposal", output: completedOutput(), activeDurationMs: 10 }]),
    store: proposalStore,
    notifier: { async notifyOwnerAction() { return true; } },
    clock: createClock(),
    idGenerator: (() => { const values = ["research-task-owner-cas-proposal", "alias-salt-owner-cas-proposal"]; return () => values.shift(); })(),
  });
  const blockerService = new TravelResearchService({
    transport: blockerTransport,
    runner: fakeRunner(blockerEvents, [{ codexThreadId: "thread-owner-cas-blocker", output: ownerAction(), activeDurationMs: 10 }]),
    store: blockerStore,
    notifier: { async notifyOwnerAction() { return true; } },
    clock: createClock(),
    idGenerator: (() => { const values = ["research-task-owner-cas-blocker", "alias-salt-owner-cas-blocker"]; return () => values.shift(); })(),
  });
  const proposalRequest = await targetRequest();
  const blockerRequest = {
    ...proposalRequest,
    agentRunId: "agent-run-owner-cas-blocker",
    operationId: "operation-owner-cas-blocker",
  };
  proposalService.prepare(proposalRequest.tripId);
  blockerService.prepare(blockerRequest.tripId);
  await proposalService.claim(proposalRequest.agentRunId);
  await blockerService.claim(blockerRequest.agentRunId);

  const blockerExecution = blockerService.executeTravelResearch(blockerRequest);
  await blockerPersistStarted;
  const proposalExecution = proposalService.executeTravelResearch(proposalRequest);
  while (proposalTransport.submittedPayloads.length === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  releaseBlockerPersist();

  const blockerStatus = await blockerExecution;
  const owned = await proposalStore.load();
  assert.equal(blockerStatus.phase, "failed");
  assert.equal(owned.recordType, "proposal_submit_reconciliation");
  assert.equal(owned.operationId, proposalRequest.operationId);
  assert.equal(blockerEvents.includes("transport.revokeSelf"), false);

  releaseProposalSubmit();
  assert.equal((await proposalExecution).phase, "completed");
});

test("two services crossing after the empty-state gate cannot overwrite proposal ownership", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "travel-proposal-cas-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "application-data");
  const firstBaseStore = createResearchStateStore({ directory, resolveHostname: PUBLIC_RESOLVER });
  const secondBaseStore = createResearchStateStore({ directory, resolveHostname: PUBLIC_RESOLVER });
  let releaseFirstClear;
  let releaseSecondClear;
  let observeFirstClear;
  let observeSecondClear;
  const firstClearGate = new Promise((resolve) => { releaseFirstClear = resolve; });
  const secondClearGate = new Promise((resolve) => { releaseSecondClear = resolve; });
  const firstCleared = new Promise((resolve) => { observeFirstClear = resolve; });
  const secondCleared = new Promise((resolve) => { observeSecondClear = resolve; });
  const gateInitialClear = (store, observe, gate) => {
    let first = true;
    return {
      load: (...args) => store.load(...args),
      async clear(...args) {
        const result = await store.clear(...args);
        if (first) {
          first = false;
          observe();
          await gate;
        }
        return result;
      },
      save: (...args) => store.save(...args),
      persistNeedsOwnerAction: (...args) => store.persistNeedsOwnerAction(...args),
      persistSelfRevokeReconciliation: (...args) => store.persistSelfRevokeReconciliation(...args),
      persistProposalReconciliation: (...args) => store.persistProposalReconciliation(...args),
    };
  };
  const firstEvents = [];
  const secondEvents = [];
  let releaseFirstSubmit;
  const firstSubmitGate = new Promise((resolve) => { releaseFirstSubmit = resolve; });
  const firstTransport = fakeTransport(firstEvents, contextFixture(), { submitGate: firstSubmitGate });
  const secondTransport = fakeTransport(secondEvents, contextFixture());
  const firstService = new TravelResearchService({
    transport: firstTransport,
    runner: fakeRunner(firstEvents, [{ codexThreadId: "thread-cas-first", output: completedOutput(), activeDurationMs: 10 }]),
    store: gateInitialClear(firstBaseStore, observeFirstClear, firstClearGate),
    notifier: { async notifyOwnerAction() { return true; } },
    clock: createClock(),
    idGenerator: (() => { const values = ["research-task-cas-first", "alias-salt-cas-first"]; return () => values.shift(); })(),
  });
  const secondService = new TravelResearchService({
    transport: secondTransport,
    runner: fakeRunner(secondEvents, [{ codexThreadId: "thread-cas-second", output: completedOutput(), activeDurationMs: 10 }]),
    store: gateInitialClear(secondBaseStore, observeSecondClear, secondClearGate),
    notifier: { async notifyOwnerAction() { return true; } },
    clock: createClock(),
    idGenerator: (() => { const values = ["research-task-cas-second", "alias-salt-cas-second"]; return () => values.shift(); })(),
  });
  const firstRequest = await targetRequest();
  const secondRequest = {
    ...firstRequest,
    agentRunId: "agent-run-cas-second",
    operationId: "operation-cas-second",
  };
  firstService.prepare(firstRequest.tripId);
  secondService.prepare(secondRequest.tripId);
  await firstService.claim(firstRequest.agentRunId);
  await secondService.claim(secondRequest.agentRunId);

  const firstExecution = firstService.executeTravelResearch(firstRequest);
  const secondExecution = secondService.executeTravelResearch(secondRequest);
  await Promise.all([firstCleared, secondCleared]);
  releaseFirstClear();
  while (firstTransport.submittedPayloads.length === 0) await new Promise((resolve) => setImmediate(resolve));
  releaseSecondClear();

  const secondStatus = await secondExecution;
  const owned = await secondBaseStore.load();
  assert.equal(secondStatus.phase, "writing");
  assert.equal(owned.operationId, firstRequest.operationId);
  assert.equal(owned.agentRunId, firstRequest.agentRunId);
  assert.equal(secondTransport.submittedPayloads.length, 0);

  releaseFirstSubmit();
  assert.equal((await firstExecution).phase, "completed");
  let retriedSecondStatus = await secondService.getResearchStatus(secondRequest.tripId);
  while (retriedSecondStatus.phase === "writing") {
    await new Promise((resolve) => setImmediate(resolve));
    retriedSecondStatus = await secondService.getResearchStatus(secondRequest.tripId);
  }
  assert.equal(retriedSecondStatus.phase, "completed");
  assert.equal(secondTransport.submittedPayloads.length, 1);
  assert.equal(await secondBaseStore.load(), undefined);
});

test("cancel waits for uncertain resumed context reconciliation and preserves blocked recovery until determined", async () => {
  const request = await targetRequest();
  const initialState = {
    researchTaskId: "research-task-context-retry",
    codexThreadId: "thread-context-retry",
    targetCategory: "hotel",
    targetScopeId: request.targetScopeId,
    disclosureFingerprint: request.disclosureFingerprint,
    aliasSalt: "alias-salt-context-retry",
    blockedReason: "codex_auth_required",
    blockedHostname: null,
    activeRuntimeMs: 12_000,
    phase: "needs_owner_action",
    startedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:01:00.000Z",
  };
  let releaseFirstContext;
  let firstContextStarted;
  const firstContextGate = new Promise((resolve) => { releaseFirstContext = resolve; });
  const contextStarted = new Promise((resolve) => { firstContextStarted = resolve; });
  const contextBodies = [];
  const actions = [];
  const harness = createHarness({
    initialState,
    transportFactory(_events, runtimeClock) {
      return new LocalAgentBridgeRuntime({
        agentEndpoint: "https://api.public.org/api/agent",
        now: runtimeClock,
        fetch: async (_url, init) => {
          const body = JSON.parse(init.body);
          actions.push(body.action);
          if (body.action === "claimAgentRun") {
            return Response.json({
              ok: true,
              data: {
                agentRunId: body.agentRunId,
                claimedAt: "2026-09-01T00:00:00.000Z",
                expiresAt: "2026-09-01T00:15:00.000Z",
                nextSequence: 1,
              },
            });
          }
          if (body.action === "getDecisionContext") {
            contextBodies.push(init.body);
            if (contextBodies.length === 1) {
              firstContextStarted();
              await firstContextGate;
            }
            if (contextBodies.length <= 2) throw new TypeError("fake context response lost");
            return Response.json({ ok: true, action: body.action, data: contextFixture(), replayed: true });
          }
          assert.equal(body.action, "revokeAgentRunSelf");
          return Response.json({
            ok: true,
            action: body.action,
            data: { agentRunId: body.agentRunId, revokedAt: "2026-09-01T00:02:00.000Z" },
          });
        },
      });
    },
  });
  assert.equal((await harness.service.getResearchStatus("trip-private")).phase, "needs_owner_action");
  harness.service.prepare("trip-private");
  await harness.service.claim("agent-run-context-retry");
  const resume = harness.service.resumeTravelResearch({
    tripId: "trip-private",
    agentRunId: "agent-run-context-retry",
    operationId: "resume-operation-context-retry",
    researchTaskId: initialState.researchTaskId,
    resumeAction: "retry_codex_auth",
  });
  await contextStarted;

  const pendingPhase = (await harness.service.getResearchStatus("trip-private")).phase;
  const cancellation = cancelCurrentResearch(harness.service);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await harness.service.getResearchStatus("trip-private")).phase, "cancelling");
  assert.deepEqual(harness.store.state, initialState);
  releaseFirstContext();
  const [resumeStatus, cancelStatus] = await Promise.all([resume, cancellation]);

  assert.equal(pendingPhase, "resuming");
  assert.equal(resumeStatus.phase, "cancelled");
  assert.equal(cancelStatus.phase, "cancelled");
  assert.equal(contextBodies.length, 3);
  assert.equal(contextBodies[0], contextBodies[1]);
  assert.equal(contextBodies[1], contextBodies[2]);
  assert.deepEqual(actions, [
    "claimAgentRun",
    "getDecisionContext",
    "getDecisionContext",
    "getDecisionContext",
    "revokeAgentRunSelf",
  ]);
  assert.equal(harness.store.state, undefined);
  assert.equal(harness.transport.claimedRun, undefined);
});

test("a submit confirmed after AgentRun expiry remains completed and clears local capability", async () => {
  let releaseSubmit;
  let submitStarted;
  const submitGate = new Promise((resolve) => { releaseSubmit = resolve; });
  const observedSubmit = new Promise((resolve) => { submitStarted = resolve; });
  const clock = createClock();
  const actions = [];
  const harness = createHarness({
    clock,
    scripts: [{
      codexThreadId: "thread-submit-cross-expiry",
      output: completedOutput(),
      activeDurationMs: 10,
    }],
    transportFactory(_events, runtimeClock) {
      return new LocalAgentBridgeRuntime({
        agentEndpoint: "https://api.public.org/api/agent",
        now: runtimeClock,
        fetch: async (_url, init) => {
          const body = JSON.parse(init.body);
          actions.push(body.action);
          if (body.action === "claimAgentRun") {
            return Response.json({
              ok: true,
              data: {
                agentRunId: body.agentRunId,
                claimedAt: "2026-09-01T00:00:00.000Z",
                expiresAt: "2026-09-01T00:00:00.010Z",
                nextSequence: 1,
              },
            });
          }
          if (body.action === "getDecisionContext") {
            return Response.json({ ok: true, action: body.action, data: contextFixture() });
          }
          assert.equal(body.action, "submitProposalBatch");
          submitStarted();
          await submitGate;
          return Response.json({ ok: true, action: body.action, data: candidateBatchData() });
        },
      });
    },
  });
  const request = await targetRequest();
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);
  const execution = harness.service.executeTravelResearch(request);
  await observedSubmit;

  clock.advance(20);
  releaseSubmit();
  const status = await execution;

  assert.equal(status.phase, "completed");
  assert.deepEqual(actions, ["claimAgentRun", "getDecisionContext", "submitProposalBatch"]);
  assert.equal(harness.transport.claimedRun, undefined);
  assert.equal(harness.store.state, undefined);
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
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);

  const first = harness.service.executeTravelResearch(request);
  const second = harness.service.executeTravelResearch(request);
  release();

  assert.deepEqual(await first, await second);
  assert.equal(harness.runner.createCount, 1);
  assert.equal(harness.transport.submittedPayloads.length, 1);
});

test("a settled execute replay returns the same task without another runner or submit", async () => {
  const harness = createHarness({ scripts: [{
    codexThreadId: "codex-thread-settled-execute",
    output: completedOutput(),
    activeDurationMs: 5_000,
  }] });
  const request = await targetRequest();
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);

  const first = await harness.service.executeTravelResearch(request);
  const replay = await harness.service.executeTravelResearch(structuredClone(request));

  assert.deepEqual(replay, first);
  assert.equal(harness.runner.createCount, 1);
  assert.equal(harness.transport.submittedPayloads.length, 1);
});

test("a different execute operation is rejected while research is in flight", async () => {
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
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);

  const first = harness.service.executeTravelResearch(request);
  await assert.rejects(harness.service.executeTravelResearch({
    ...request,
    targetCategory: "restaurant",
  }), { code: "CODEX_RESEARCH_FAILED" });
  assert.equal(harness.transport.claimedRun.agentRunId, request.agentRunId);
  release();

  assert.equal((await first).phase, "completed");
  assert.equal(harness.runner.createCount, 1);
});

test("a different execute operation releases its newly claimed unbound runtime capability", async () => {
  let releasePersist;
  let persistStarted;
  const persistGate = new Promise((resolve) => { releasePersist = resolve; });
  const observedPersist = new Promise((resolve) => { persistStarted = resolve; });
  const actions = [];
  const harness = createHarness({
    scripts: [{
      codexThreadId: "thread-old-execute",
      output: ownerAction(),
      activeDurationMs: 5_000,
    }],
    storeOptions: { persistGate, onPersistStarted: persistStarted },
    transportFactory(_events, runtimeClock) {
      return new LocalAgentBridgeRuntime({
        agentEndpoint: "https://api.public.org/api/agent",
        now: runtimeClock,
        fetch: async (_url, init) => {
          const body = JSON.parse(init.body);
          actions.push(body.action);
          if (body.action === "claimAgentRun") {
            return Response.json({ ok: true, data: {
              agentRunId: body.agentRunId,
              claimedAt: "2026-09-01T00:00:00.000Z",
              expiresAt: "2026-09-01T00:15:00.000Z",
              nextSequence: 1,
            } });
          }
          if (body.action === "getDecisionContext") {
            return Response.json({ ok: true, action: body.action, data: contextFixture() });
          }
          assert.equal(body.action, "revokeAgentRunSelf");
          return Response.json({ ok: true, action: body.action, data: {
            agentRunId: body.agentRunId,
            revokedAt: "2026-09-01T00:01:00.000Z",
          } });
        },
      });
    },
  });
  const request = await targetRequest();
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);
  const first = harness.service.executeTravelResearch(request);
  await observedPersist;
  harness.service.prepare("trip-private");
  await harness.service.claim("agent-run-new-execute");

  await assert.rejects(harness.service.executeTravelResearch({
    ...request,
    agentRunId: "agent-run-new-execute",
    targetCategory: "restaurant",
  }), { code: "CODEX_RESEARCH_FAILED" });

  assert.equal(harness.transport.claimedRun, undefined);
  assert.doesNotThrow(() => harness.service.prepare("trip-private"));
  releasePersist();
  assert.equal((await first).phase, "needs_owner_action");
  assert.deepEqual(actions, [
    "claimAgentRun",
    "getDecisionContext",
    "revokeAgentRunSelf",
    "claimAgentRun",
  ]);
});

test("an unbound successful claim has one bounded handoff lease that releases local capability", async () => {
  const clock = createControlledClock();
  const harness = createHarness({ clock });
  const request = await targetRequest();
  harness.service.prepare("trip-private");

  await harness.service.claim(request.agentRunId);
  await harness.service.claim(request.agentRunId);

  assert.equal(clock.scheduledTimers(), 1);
  assert.equal(clock.pendingTimers(), 1);
  assert.equal(clock.nextDelay() >= 5_000 && clock.nextDelay() <= 10_000, true);
  assert.equal(clock.fireNext(), true);
  assert.equal(harness.transport.claimedRun, undefined);
  assert.doesNotThrow(() => harness.service.prepare("trip-private"));
});

test("two uncertain claims share one lease that expires the real runtime pending envelope", async () => {
  const clock = createControlledClock();
  const claimBodies = [];
  const harness = createHarness({
    clock,
    transportFactory(_events, runtimeClock) {
      return new LocalAgentBridgeRuntime({
        agentEndpoint: "https://api.public.org/api/agent",
        now: runtimeClock,
        fetch: async (_url, init) => {
          claimBodies.push(init.body);
          throw new TypeError("claim response unknown");
        },
      });
    },
  });
  const request = await targetRequest();
  harness.service.prepare("trip-private");

  await assert.rejects(harness.service.claim(request.agentRunId), {
    code: "AGENT_TRANSPORT_UNAVAILABLE",
    uncertain: true,
  });
  await assert.rejects(harness.service.claim(request.agentRunId), {
    code: "AGENT_TRANSPORT_UNAVAILABLE",
    uncertain: true,
  });

  assert.equal(claimBodies.length, 2);
  assert.equal(claimBodies[0], claimBodies[1]);
  assert.equal(clock.scheduledTimers(), 1);
  assert.equal(clock.nextDelay(), 8_000);
  assert.throws(() => harness.service.prepare("trip-private"), { code: "BRIDGE_BUSY" });
  assert.equal(clock.fireNext(), true);
  assert.doesNotThrow(() => harness.service.prepare("trip-private"));
});

test("uncertain invalid claim responses share one lease and expire the exact pending envelope", async () => {
  const clock = createControlledClock();
  const claimBodies = [];
  const harness = createHarness({
    clock,
    transportFactory(_events, runtimeClock) {
      return new LocalAgentBridgeRuntime({
        agentEndpoint: "https://api.public.org/api/agent",
        now: runtimeClock,
        fetch: async (_url, init) => {
          const body = JSON.parse(init.body);
          claimBodies.push(init.body);
          return Response.json({
            ok: true,
            data: { agentRunId: body.agentRunId, status: "claimed" },
          });
        },
      });
    },
  });
  const request = await targetRequest();
  harness.service.prepare("trip-private");

  await assert.rejects(harness.service.claim(request.agentRunId), {
    code: "INVALID_AGENT_RESPONSE",
    uncertain: true,
  });
  await assert.rejects(harness.service.claim(request.agentRunId), {
    code: "INVALID_AGENT_RESPONSE",
    uncertain: true,
  });

  assert.equal(claimBodies.length, 2);
  assert.equal(claimBodies[0], claimBodies[1]);
  assert.equal(clock.scheduledTimers(), 1);
  assert.equal(clock.pendingTimers(), 1);
  assert.throws(() => harness.service.prepare("trip-private"), { code: "BRIDGE_BUSY" });
  assert.equal(clock.fireNext(), true);
  assert.doesNotThrow(() => harness.service.prepare("trip-private"));
});

test("a definite invalid claim response does not start an unbound claim lease", async () => {
  const clock = createControlledClock();
  const claimError = Object.assign(new Error("private invalid response"), {
    code: "INVALID_AGENT_RESPONSE",
    uncertain: false,
  });
  const harness = createHarness({
    clock,
    transportFactory(events) {
      const transport = fakeTransport(events, contextFixture());
      transport.claim = async () => { throw claimError; };
      return transport;
    },
  });
  const request = await targetRequest();
  harness.service.prepare("trip-private");

  await assert.rejects(harness.service.claim(request.agentRunId), (error) => error === claimError);
  assert.equal(clock.scheduledTimers(), 0);
  assert.equal(clock.pendingTimers(), 0);
});

test("an ordinary release refusal preserves the uncertain claim lease until expiry", async () => {
  const clock = createControlledClock();
  const harness = createHarness({
    clock,
    transportFactory(_events, runtimeClock) {
      return new LocalAgentBridgeRuntime({
        agentEndpoint: "https://api.public.org/api/agent",
        now: runtimeClock,
        fetch: async () => { throw new TypeError("claim response unknown"); },
      });
    },
  });
  const request = await targetRequest();
  harness.service.prepare("trip-private");
  await assert.rejects(harness.service.claim(request.agentRunId), {
    code: "AGENT_TRANSPORT_UNAVAILABLE",
    uncertain: true,
  });

  assert.equal(harness.service.releaseUnboundClaim(request.agentRunId), false);
  assert.equal(clock.pendingTimers(), 1);
  assert.equal(clock.fireNext(), true);
  assert.doesNotThrow(() => harness.service.prepare("trip-private"));
});

test("a successful ordinary release clears its claim lease", async () => {
  const clock = createControlledClock();
  const harness = createHarness({ clock });
  const request = await targetRequest();
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);

  assert.equal(harness.service.releaseUnboundClaim(request.agentRunId), true);
  assert.equal(clock.pendingTimers(), 0);
  assert.equal(clock.fireNext(), false);
  assert.doesNotThrow(() => harness.service.prepare("trip-private"));
});

test("an ordinary release exception preserves its claim lease and propagates", async () => {
  const clock = createControlledClock();
  const releaseError = Object.assign(new Error("private release failure"), {
    code: "AGENT_TRANSPORT_UNAVAILABLE",
    uncertain: true,
  });
  const harness = createHarness({
    clock,
    transportFactory(events) {
      const transport = fakeTransport(events, contextFixture());
      transport.releaseUnboundClaim = () => { throw releaseError; };
      return transport;
    },
  });
  const request = await targetRequest();
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);

  assert.throws(() => harness.service.releaseUnboundClaim(request.agentRunId), (error) => error === releaseError);
  assert.equal(clock.pendingTimers(), 1);
  assert.equal(clock.fireNext(), true);
  assert.doesNotThrow(() => harness.service.prepare("trip-private"));
});

test("TravelResearchService requires the internal unbound-claim expiry capability", () => {
  assert.throws(() => createHarness({
    transportFactory(events) {
      const transport = fakeTransport(events, contextFixture());
      delete transport.expireUnboundClaim;
      return transport;
    },
  }), { code: "CODEX_RESEARCH_FAILED" });
});

test("a handoff lease fails safe when runtime refuses to release an uncertain claim", async () => {
  const clock = createControlledClock();
  const harness = createHarness({
    clock,
    transportFactory(events) {
      const transport = fakeTransport(events, contextFixture());
      transport.expireUnboundClaim = () => false;
      return transport;
    },
  });
  const request = await targetRequest();
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);

  assert.equal(clock.fireNext(), true);

  assert.equal(harness.transport.claimedRun.agentRunId, request.agentRunId);
  assert.equal(clock.pendingTimers(), 0);
});

test("execute binds the claimed handoff before work and cancels its lease", async () => {
  const clock = createControlledClock();
  const harness = createHarness({
    clock,
    scripts: [{ codexThreadId: "thread-lease-execute", output: completedOutput(), activeDurationMs: 10 }],
  });
  const request = await targetRequest();
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);
  assert.equal(clock.pendingTimers(), 1);

  const execution = harness.service.executeTravelResearch(request);

  assert.equal(clock.pendingTimers(), 0);
  assert.equal(clock.fireLastCleared(), true);
  assert.equal(harness.transport.claimedRun.agentRunId, request.agentRunId);
  assert.equal((await execution).phase, "completed");
});

test("resume binds the claimed handoff before restoring its fixed task", async () => {
  const request = await targetRequest();
  const recovered = {
    researchTaskId: "research-task-lease-resume",
    codexThreadId: "thread-lease-resume",
    targetCategory: "hotel",
    targetScopeId: request.targetScopeId,
    disclosureFingerprint: request.disclosureFingerprint,
    aliasSalt: "alias-salt-lease-resume",
    blockedReason: "codex_auth_required",
    blockedHostname: null,
    activeRuntimeMs: 12_000,
    phase: "needs_owner_action",
    startedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:01:00.000Z",
  };
  const clock = createControlledClock();
  const harness = createHarness({
    clock,
    initialState: recovered,
    scripts: [{ codexThreadId: recovered.codexThreadId, output: completedOutput(), activeDurationMs: 13_000 }],
  });
  assert.equal((await harness.service.getResearchStatus("trip-private")).phase, "needs_owner_action");
  harness.service.prepare("trip-private");
  await harness.service.claim("agent-run-lease-resume");
  assert.equal(clock.pendingTimers(), 1);

  const resumed = harness.service.resumeTravelResearch({
    tripId: "trip-private",
    agentRunId: "agent-run-lease-resume",
    operationId: "resume-operation-lease",
    researchTaskId: recovered.researchTaskId,
    resumeAction: "retry_codex_auth",
  });

  assert.equal(clock.pendingTimers(), 0);
  assert.equal((await resumed).phase, "completed");
});

test("concurrent resume reuses only the identical operation and rejects a different task", async () => {
  const request = await targetRequest();
  const recovered = {
    researchTaskId: "research-task-concurrent-resume",
    codexThreadId: "thread-concurrent-resume",
    targetCategory: "hotel",
    targetScopeId: request.targetScopeId,
    disclosureFingerprint: request.disclosureFingerprint,
    aliasSalt: "alias-salt-concurrent-resume",
    blockedReason: "codex_auth_required",
    blockedHostname: null,
    activeRuntimeMs: 12_000,
    phase: "needs_owner_action",
    startedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:01:00.000Z",
  };
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const harness = createHarness({
    initialState: recovered,
    scripts: [async () => {
      await waiting;
      return {
        codexThreadId: recovered.codexThreadId,
        output: completedOutput(),
        activeDurationMs: 13_000,
        state: { codexThreadId: recovered.codexThreadId, correctionUsed: true, activeDurationMs: 13_000 },
      };
    }],
  });
  harness.service.prepare("trip-private");
  await harness.service.claim("agent-run-resume");
  const input = {
    tripId: "trip-private",
    agentRunId: "agent-run-resume",
    operationId: "resume-operation-concurrent",
    researchTaskId: recovered.researchTaskId,
    resumeAction: "retry_codex_auth",
  };

  const first = harness.service.resumeTravelResearch(input);
  const replay = harness.service.resumeTravelResearch(input);
  assert.equal(replay, first);
  await assert.rejects(harness.service.resumeTravelResearch({
    tripId: "trip-private",
    ...input,
    researchTaskId: "different-task",
  }), { code: "CODEX_RESEARCH_FAILED" });
  assert.equal(harness.transport.claimedRun.agentRunId, input.agentRunId);
  release();

  assert.equal((await first).phase, "completed");
  assert.equal(harness.runner.createCount, 1);
});

test("a settled resume replay returns the same task without another runner", async () => {
  const request = await targetRequest();
  const recovered = {
    researchTaskId: "research-task-settled-resume",
    codexThreadId: "thread-settled-resume",
    targetCategory: "hotel",
    targetScopeId: request.targetScopeId,
    disclosureFingerprint: request.disclosureFingerprint,
    aliasSalt: "alias-salt-settled-resume",
    blockedReason: "codex_auth_required",
    blockedHostname: null,
    activeRuntimeMs: 12_000,
    phase: "needs_owner_action",
    startedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:01:00.000Z",
  };
  const harness = createHarness({
    initialState: recovered,
    scripts: [{ codexThreadId: recovered.codexThreadId, output: completedOutput(), activeDurationMs: 13_000 }],
  });
  harness.service.prepare("trip-private");
  await harness.service.claim("agent-run-settled-resume");
  const input = {
    tripId: "trip-private",
    agentRunId: "agent-run-settled-resume",
    operationId: "resume-operation-settled",
    researchTaskId: recovered.researchTaskId,
    resumeAction: "retry_codex_auth",
  };

  const first = await harness.service.resumeTravelResearch(input);
  const replay = await harness.service.resumeTravelResearch(structuredClone(input));

  assert.deepEqual(replay, first);
  assert.equal(harness.runner.createCount, 1);
  assert.equal(harness.runner.resumeInputs.length, 1);
});

test("a different resume operation releases its newly claimed unbound runtime capability", async () => {
  const request = await targetRequest();
  const recovered = {
    researchTaskId: "research-task-old-resume",
    codexThreadId: "thread-old-resume",
    targetCategory: "hotel",
    targetScopeId: request.targetScopeId,
    disclosureFingerprint: request.disclosureFingerprint,
    aliasSalt: "alias-salt-old-resume",
    blockedReason: "codex_auth_required",
    blockedHostname: null,
    activeRuntimeMs: 12_000,
    phase: "needs_owner_action",
    startedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:01:00.000Z",
  };
  let releasePersist;
  let persistStarted;
  const persistGate = new Promise((resolve) => { releasePersist = resolve; });
  const observedPersist = new Promise((resolve) => { persistStarted = resolve; });
  const actions = [];
  const harness = createHarness({
    initialState: recovered,
    scripts: [{
      codexThreadId: recovered.codexThreadId,
      output: ownerAction(),
      activeDurationMs: 13_000,
    }],
    storeOptions: { persistGate, onPersistStarted: persistStarted },
    transportFactory(_events, runtimeClock) {
      return new LocalAgentBridgeRuntime({
        agentEndpoint: "https://api.public.org/api/agent",
        now: runtimeClock,
        fetch: async (_url, init) => {
          const body = JSON.parse(init.body);
          actions.push(body.action);
          if (body.action === "claimAgentRun") {
            return Response.json({ ok: true, data: {
              agentRunId: body.agentRunId,
              claimedAt: "2026-09-01T00:00:00.000Z",
              expiresAt: "2026-09-01T00:15:00.000Z",
              nextSequence: 1,
            } });
          }
          if (body.action === "getDecisionContext") {
            return Response.json({ ok: true, action: body.action, data: contextFixture() });
          }
          assert.equal(body.action, "revokeAgentRunSelf");
          return Response.json({ ok: true, action: body.action, data: {
            agentRunId: body.agentRunId,
            revokedAt: "2026-09-01T00:01:00.000Z",
          } });
        },
      });
    },
  });
  assert.equal((await harness.service.getResearchStatus("trip-private")).phase, "needs_owner_action");
  harness.service.prepare("trip-private");
  await harness.service.claim("agent-run-old-resume");
  const first = harness.service.resumeTravelResearch({
    tripId: "trip-private",
    agentRunId: "agent-run-old-resume",
    operationId: "resume-operation-old",
    researchTaskId: recovered.researchTaskId,
    resumeAction: "retry_codex_auth",
  });
  await observedPersist;
  harness.service.prepare("trip-private");
  await harness.service.claim("agent-run-new-resume");

  await assert.rejects(harness.service.resumeTravelResearch({
    tripId: "trip-private",
    agentRunId: "agent-run-new-resume",
    operationId: "resume-operation-new",
    researchTaskId: "different-task",
    resumeAction: "retry_codex_auth",
  }), { code: "CODEX_RESEARCH_FAILED" });

  assert.equal(harness.transport.claimedRun, undefined);
  assert.doesNotThrow(() => harness.service.prepare("trip-private"));
  releasePersist();
  assert.equal((await first).phase, "needs_owner_action");
  assert.deepEqual(actions, [
    "claimAgentRun",
    "getDecisionContext",
    "revokeAgentRunSelf",
    "claimAgentRun",
  ]);
});

test("changed disclosure revokes the run and never creates a Codex task", async () => {
  const harness = createHarness();
  const request = { ...await targetRequest(), disclosureFingerprint: "f".repeat(64) };
  harness.service.prepare("trip-private");
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
    harness.service.prepare("trip-private");
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

test("cancel during owner-action revoke skips persistence and finishes cancelled", async () => {
  let releaseRevoke;
  const revokeGate = new Promise((resolve) => { releaseRevoke = resolve; });
  const harness = createHarness({
    scripts: [{
      codexThreadId: "thread-cancel-block-revoke",
      output: ownerAction("codex_auth_required"),
      activeDurationMs: 10,
    }],
    transportOptions: { revokeGate },
  });
  const request = await targetRequest();
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);
  const execution = harness.service.executeTravelResearch(request);
  while (!harness.events.includes("transport.revokeSelf")) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  const cancellation = cancelCurrentResearch(harness.service);
  releaseRevoke();
  const [executeStatus, cancelStatus] = await Promise.all([execution, cancellation]);

  assert.equal(executeStatus.phase, "cancelled");
  assert.equal(cancelStatus.phase, "cancelled");
  assert.equal(harness.events.includes("store.persistNeedsOwnerAction"), false);
  assert.equal(harness.events.includes("notifier.notifyOwnerAction"), false);
  assert.equal(harness.events.includes("store.clear"), true);
  assert.equal(harness.store.state, undefined);
});

test("cancel during owner-action persistence clears the record and suppresses notification", async () => {
  let releasePersist;
  const persistGate = new Promise((resolve) => { releasePersist = resolve; });
  const harness = createHarness({
    scripts: [{
      codexThreadId: "thread-cancel-block-persist",
      output: ownerAction("codex_auth_required"),
      activeDurationMs: 10,
    }],
    storeOptions: { persistGate },
  });
  const request = await targetRequest();
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);
  const execution = harness.service.executeTravelResearch(request);
  while (!harness.events.includes("store.persistNeedsOwnerAction")) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  const cancellation = cancelCurrentResearch(harness.service);
  while ((await harness.service.getResearchStatus("trip-private")).phase !== "cancelling") {
    await new Promise((resolve) => setImmediate(resolve));
  }
  releasePersist();
  const [executeStatus, cancelStatus] = await Promise.all([execution, cancellation]);

  assert.equal(executeStatus.phase, "cancelled");
  assert.equal(cancelStatus.phase, "cancelled");
  assert.equal(harness.events.includes("notifier.notifyOwnerAction"), false);
  assert.equal(harness.events.includes("store.clear"), true);
  assert.equal(harness.store.state, undefined);
});

test("an issued owner-action revocation finishes reconciliation after the active deadline", async () => {
  let releaseRevoke;
  const revokeGate = new Promise((resolve) => { releaseRevoke = resolve; });
  const clock = createControlledClock();
  const harness = createHarness({
    clock,
    scripts: [{
      codexThreadId: "thread-block-deadline",
      output: ownerAction(),
      activeDurationMs: 599_990,
    }],
    transportOptions: { revokeGate },
  });
  const request = await targetRequest();
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);
  const execution = harness.service.executeTravelResearch(request);
  while (!harness.events.includes("transport.revokeSelf")) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  const timerFired = clock.fireNext();
  clock.advance(20);
  await new Promise((resolve) => setImmediate(resolve));
  const pendingStatus = await harness.service.getResearchStatus("trip-private");
  releaseRevoke();
  const status = await execution;

  assert.equal(timerFired, false);
  assert.equal(pendingStatus.phase, "validating");
  assert.equal(pendingStatus.agentRunId, request.agentRunId);
  assert.equal(pendingStatus.operationId, request.operationId);
  assert.equal(pendingStatus.reconciliationState, "self_revoke_reconciling");
  assert.equal(status.phase, "needs_owner_action");
  assert.equal(harness.events.includes("store.persistNeedsOwnerAction"), true);
});

test("runner authentication loss becomes owner action only with a recoverable thread state", async () => {
  const authError = Object.assign(new Error("private auth detail"), {
    code: "CODEX_NOT_AUTHENTICATED",
    state: { codexThreadId: "thread-auth-loss", correctionUsed: false, activeDurationMs: 22_000 },
  });
  const harness = createHarness({ scripts: [authError] });
  const request = await targetRequest();
  harness.service.prepare("trip-private");
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
  first.service.prepare("trip-private");
  await first.service.claim(initialRequest.agentRunId);
  await first.service.executeTravelResearch(initialRequest);

  const persisted = first.store.state;
  const resumed = createHarness({
    initialState: persisted,
    scripts: [{ codexThreadId: "thread-source", output: completedOutput(), activeDurationMs: 28_000 }],
  });
  resumed.service.prepare("trip-private");
  await resumed.service.claim("agent-run-2");

  const status = await resumed.service.resumeTravelResearch({
    tripId: "trip-private",
    agentRunId: "agent-run-2",
    operationId: "resume-operation-source",
    researchTaskId: persisted.researchTaskId,
    resumeAction: "skip_blocked_source",
  });

  assert.equal(status.phase, "completed");
  assert.deepEqual(resumed.runner.resumeInputs.map((input) => input.codexThreadId), ["thread-source"]);
  assert.match(resumed.runner.resumeInputs[0].prompt, /booking\.public\.org/u);
  assert.equal(resumed.runner.resumeInputs[0].prompt.includes("http"), false);
  assert.equal(resumed.transport.submittedPayloads.length, 1);
  assert.equal(resumed.store.state, undefined);
  assert.equal(
    resumed.events.indexOf("store.clear") < resumed.events.indexOf("transport.submitProposalBatch"),
    true,
  );
  assert.equal(resumed.events.filter((event) => event === "store.clear").length, 2);
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
  harness.service.prepare("trip-private");
  await harness.service.claim("agent-run-2");

  await assert.rejects(
    harness.service.resumeTravelResearch({
    tripId: "trip-private",
      agentRunId: "agent-run-2",
      operationId: "resume-operation-browser-input",
      researchTaskId: "research-task-1",
      resumeAction: "retry_codex_auth",
      prompt: "browser supplied",
    }),
    { code: "CODEX_RESEARCH_FAILED" },
  );
  harness.service.prepare("trip-private");
  await harness.service.claim("agent-run-2");
  const status = await harness.service.resumeTravelResearch({
    tripId: "trip-private",
    agentRunId: "agent-run-2",
    operationId: "resume-operation-changed-context",
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
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);

  const status = await harness.service.executeTravelResearch(request);

  assert.equal(status.phase, "completed");
  assert.equal(harness.runner.resumeInputs.length, 1);
  assert.equal(harness.runner.resumeInputs[0].codexThreadId, "thread-evidence");
  assert.equal(harness.runner.resumeInputs[0].prompt.includes("证据不足"), true);
});

test("active budget exhausted before validation times out with zero writes", async () => {
  const harness = createHarness({
    runnerFactory(events) {
      const runner = fakeRunner(events, [{
        codexThreadId: "thread-timeout",
        output: completedOutput(),
        activeDurationMs: 600_000,
      }]);
      runner.resolveHostname = async () => {
        events.push("runner.resolveHostname");
        return PUBLIC_RESOLVER();
      };
      return runner;
    },
  });
  const request = await targetRequest();
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);

  const status = await harness.service.executeTravelResearch(request);

  assert.equal(status.phase, "failed");
  assert.equal(status.errorCode, "CODEX_RESEARCH_TIMEOUT");
  assert.equal(harness.transport.submittedPayloads.length, 0);
  assert.equal(harness.runner.resumeInputs.length, 0);
  assert.equal(harness.events.includes("runner.resolveHostname"), false);
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
  harness.service.prepare("trip-private");
  await harness.service.claim("agent-run-new");

  await harness.service.resumeTravelResearch({
    tripId: "trip-private",
    agentRunId: "agent-run-new",
    operationId: "resume-operation-wait",
    researchTaskId: "research-task-wait",
    resumeAction: "retry_codex_auth",
  });

  assert.deepEqual(harness.runner.createOptions[0], {
    activeTimeoutMs: 600_000,
    initialState: {
      codexThreadId: "thread-wait",
      correctionUsed: true,
      activeDurationMs: 42_000,
    },
  });
});

test("fractional runner duration remains valid and recoverable persistence rounds it up conservatively", async () => {
  const completed = createHarness({ scripts: [{
    codexThreadId: "thread-fractional",
    output: completedOutput(),
    activeDurationMs: 1.5,
  }] });
  const request = await targetRequest();
  completed.service.prepare("trip-private");
  await completed.service.claim(request.agentRunId);
  assert.equal((await completed.service.executeTravelResearch(request)).phase, "completed");

  const blocked = createHarness({ scripts: [{
    codexThreadId: "thread-fractional-block",
    output: ownerAction(),
    activeDurationMs: 1.5,
  }] });
  blocked.service.prepare("trip-private");
  await blocked.service.claim(request.agentRunId);
  assert.equal((await blocked.service.executeTravelResearch(request)).phase, "needs_owner_action");
  assert.equal(blocked.store.state.activeRuntimeMs, 2);
});

test("runner factory receives the active deadline remaining after signed context work", async () => {
  let releaseContext;
  const contextGate = new Promise((resolve) => { releaseContext = resolve; });
  const clock = createClock();
  const harness = createHarness({
    clock,
    scripts: [{ codexThreadId: "thread-budget", output: completedOutput(), activeDurationMs: 1_000 }],
    transportOptions: { contextGate },
  });
  const request = await targetRequest();
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);
  const execution = harness.service.executeTravelResearch(request);
  while (!harness.events.includes("transport.getDecisionContext")) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  clock.advance(125);
  releaseContext();

  assert.equal((await execution).phase, "completed");
  assert.deepEqual(harness.runner.createOptions[0], { activeTimeoutMs: 599_875 });
});

test("wall-clock rollback cannot reduce service runtime or move status timestamps backward", async () => {
  let releaseContext;
  let releaseRunner;
  const contextGate = new Promise((resolve) => { releaseContext = resolve; });
  const runnerGate = new Promise((resolve) => { releaseRunner = resolve; });
  const clock = createClock();
  const harness = createHarness({
    clock,
    transportOptions: { contextGate },
    scripts: [async () => {
      await runnerGate;
      return {
        codexThreadId: "thread-clock-rollback",
        output: completedOutput(),
        activeDurationMs: 1_000,
        state: {
          codexThreadId: "thread-clock-rollback",
          correctionUsed: false,
          activeDurationMs: 1_000,
        },
      };
    }],
  });
  const request = await targetRequest();
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);
  const execution = harness.service.executeTravelResearch(request);
  while (!harness.events.includes("transport.getDecisionContext")) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  clock.advance(100);
  releaseContext();
  while (!harness.events.includes("runner.runInitial")) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  clock.set("2026-09-01T00:00:00.050Z");
  releaseRunner();
  const status = await execution;

  assert.equal(status.phase, "completed");
  assert.equal(status.updatedAt, "2026-09-01T00:00:00.100Z");
  assert.deepEqual(harness.runner.createOptions[0], { activeTimeoutMs: 599_900 });
});

test("claimed-run expiry bounds signed context before any runner or write starts", async () => {
  let releaseContext;
  const contextGate = new Promise((resolve) => { releaseContext = resolve; });
  const clock = createControlledClock();
  const harness = createHarness({
    clock,
    transportOptions: {
      claimExpiresAt: "2026-09-01T00:00:00.010Z",
      contextGate,
    },
  });
  const request = await targetRequest();
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);
  const execution = harness.service.executeTravelResearch(request);
  while (!harness.events.includes("transport.getDecisionContext")) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(clock.fireNext(), false);
  clock.advance(20);
  releaseContext();
  const status = await execution;

  assert.equal(status.phase, "failed");
  assert.equal(status.errorCode, "AGENT_RUN_INACTIVE");
  assert.equal(harness.runner.createCount, 0);
  assert.equal(harness.transport.submittedPayloads.length, 0);
});

test("a definitively expired task claim is released before terminal trip handoff", async () => {
  let releaseContext;
  const contextGate = new Promise((resolve) => { releaseContext = resolve; });
  const clock = createControlledClock();
  const harness = createHarness({
    clock,
    transportOptions: {
      claimExpiresAt: "2026-09-01T00:00:10.000Z",
      contextGate,
    },
  });
  const request = await targetRequest();
  harness.service.prepare(request.tripId);
  await harness.service.claim(request.agentRunId);
  const execution = harness.service.executeTravelResearch(request);
  while (!harness.events.includes("transport.getDecisionContext")) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  clock.advance(10_020);
  releaseContext();
  const failed = await execution;

  assert.equal(failed.phase, "failed");
  assert.equal(failed.errorCode, "AGENT_RUN_INACTIVE");
  assert.equal(harness.transport.claimedRun?.agentRunId, request.agentRunId);
  assert.deepEqual(await harness.service.getResearchStatus("trip-next"), { phase: "idle" });
  assert.equal(harness.transport.claimedRun, undefined);
  assert.doesNotThrow(() => harness.service.prepare("trip-next"));
  assert.equal(harness.runner.createCount, 0);
  assert.equal(harness.transport.submittedPayloads.length, 0);
});

test("active deadline bounds validation before cloud submission", async () => {
  let releaseResolution;
  const resolutionGate = new Promise((resolve) => { releaseResolution = resolve; });
  const clock = createControlledClock();
  const harness = createHarness({
    clock,
    runnerFactory(events) {
      const runner = fakeRunner(events, [{
        codexThreadId: "thread-validation-deadline",
        output: completedOutput(),
        activeDurationMs: 599_990,
      }]);
      runner.resolveHostname = async () => {
        events.push("runner.resolveHostname");
        await resolutionGate;
        return PUBLIC_RESOLVER();
      };
      return runner;
    },
  });
  const request = await targetRequest();
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);
  const execution = harness.service.executeTravelResearch(request);
  while (!harness.events.includes("runner.resolveHostname")) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(clock.fireNext(), true);
  const status = await execution;
  releaseResolution();

  assert.equal(status.phase, "failed");
  assert.equal(status.errorCode, "CODEX_RESEARCH_TIMEOUT");
  assert.equal(harness.transport.submittedPayloads.length, 0);
});

test("issued cloud submit and final revoke requests reconcile after the active deadline", async () => {
  for (const phase of ["submit", "revoke"]) {
    let releaseGate;
    const gate = new Promise((resolve) => { releaseGate = resolve; });
    const clock = createControlledClock();
    const harness = createHarness({
      clock,
      scripts: [{
        codexThreadId: `thread-${phase}-deadline`,
        output: completedOutput(),
        activeDurationMs: 599_990,
      }],
      transportOptions: phase === "submit" ? { submitGate: gate } : { revokeGate: gate },
    });
    const request = await targetRequest();
    harness.service.prepare("trip-private");
    await harness.service.claim(request.agentRunId);
    const execution = harness.service.executeTravelResearch(request);
    const expectedEvent = phase === "submit"
      ? "transport.submitProposalBatch"
      : "transport.revokeSelf";
    while (!harness.events.includes(expectedEvent)) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const timerFired = clock.fireNext();
    clock.advance(20);
    await new Promise((resolve) => setImmediate(resolve));
    const pendingStatus = await harness.service.getResearchStatus("trip-private");
    releaseGate();
    const status = await execution;

    assert.equal(timerFired, false, phase);
    assert.equal(pendingStatus.phase, "writing", phase);
    assert.equal(status.phase, "completed", phase);
    assert.equal(harness.transport.submittedPayloads.length, 1, phase);
  }
});

test("claimed-run expiry races an in-flight runner, cancels it and writes no candidates", async () => {
  let releaseRunner;
  const runnerGate = new Promise((resolve) => { releaseRunner = resolve; });
  const clock = createControlledClock();
  const harness = createHarness({
    clock,
    scripts: [async () => {
      await runnerGate;
      return {
        codexThreadId: "thread-too-late",
        output: completedOutput(),
        activeDurationMs: 10,
        state: { codexThreadId: "thread-too-late", correctionUsed: false, activeDurationMs: 10 },
      };
    }],
    transportOptions: { claimExpiresAt: "2026-09-01T00:00:00.010Z" },
  });
  const request = await targetRequest();
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);
  const execution = harness.service.executeTravelResearch(request);
  while (!harness.events.includes("runner.runInitial")) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  const timerFired = clock.fireNext();
  const status = await execution;
  releaseRunner();

  assert.equal(timerFired, true);
  assert.equal(status.phase, "failed");
  assert.equal(status.errorCode, "AGENT_RUN_INACTIVE");
  assert.equal(harness.events.includes("runner.cancel"), true);
  assert.equal(harness.transport.submittedPayloads.length, 0);
});

test("active deadline during evidence continuation cancels the runner and reports insufficient evidence", async () => {
  const insufficient = completedOutput();
  insufficient.candidates[0].evidence[1].sourceUrl = insufficient.candidates[0].evidence[0].sourceUrl;
  let releaseRunner;
  const runnerGate = new Promise((resolve) => { releaseRunner = resolve; });
  const clock = createControlledClock();
  const harness = createHarness({
    clock,
    scripts: [
      { codexThreadId: "thread-evidence-deadline", output: insufficient, activeDurationMs: 599_990 },
      async () => {
        await runnerGate;
        return {
          codexThreadId: "thread-evidence-deadline",
          output: completedOutput(),
          activeDurationMs: 600_000,
          state: { codexThreadId: "thread-evidence-deadline", correctionUsed: false, activeDurationMs: 600_000 },
        };
      },
    ],
  });
  const request = await targetRequest();
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);
  const execution = harness.service.executeTravelResearch(request);
  while (harness.runner.resumeInputs.length === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  const timerFired = clock.fireNext();
  const status = await execution;
  releaseRunner();

  assert.equal(timerFired, true);
  assert.equal(status.phase, "failed");
  assert.equal(status.errorCode, "CODEX_INSUFFICIENT_EVIDENCE");
  assert.equal(harness.events.includes("runner.cancel"), true);
  assert.equal(harness.transport.submittedPayloads.length, 0);
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
    harness.service.prepare("trip-private");
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
  harness.service.prepare("trip-private");
  await harness.service.claim("agent-run-new");

  await assert.rejects(harness.service.resumeTravelResearch({
    tripId: "trip-private",
    agentRunId: "agent-run-new",
    operationId: "resume-operation-invalid-action",
    researchTaskId: "research-task-auth",
    resumeAction: "skip_blocked_source",
  }), { code: "CODEX_RESEARCH_FAILED" });
  assert.equal(harness.runner.createCount, 0);
  assert.deepEqual(harness.store.state, initialState);
  await assert.rejects(harness.service.resumeTravelResearch({
    tripId: "trip-private",
    agentRunId: "agent-run-new",
    operationId: "resume-operation-private-input",
    researchTaskId: "research-task-auth",
    resumeAction: "retry_codex_auth",
    cookie: "private-cookie",
  }), { code: "CODEX_RESEARCH_FAILED" });
});

test("invalid resume state revokes a newly claimed real-runtime capability and preserves valid recovery", async () => {
  const request = await targetRequest();
  const recovered = {
    researchTaskId: "research-task-invalid-resume",
    codexThreadId: "thread-invalid-resume",
    targetCategory: "hotel",
    targetScopeId: request.targetScopeId,
    disclosureFingerprint: request.disclosureFingerprint,
    aliasSalt: "alias-salt-invalid-resume",
    blockedReason: "codex_auth_required",
    blockedHostname: null,
    activeRuntimeMs: 12_000,
    phase: "needs_owner_action",
    startedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:01:00.000Z",
  };
  const cases = [
    {
      name: "task mismatch",
      initialState: recovered,
      input: { researchTaskId: "different-task", resumeAction: "retry_codex_auth" },
    },
    {
      name: "action mismatch",
      initialState: recovered,
      input: { researchTaskId: recovered.researchTaskId, resumeAction: "skip_blocked_source" },
    },
    {
      name: "missing recovery",
      initialState: undefined,
      input: { researchTaskId: recovered.researchTaskId, resumeAction: "retry_codex_auth" },
    },
    {
      name: "invalid recovery",
      initialState: recovered,
      storeOptions: {
        loadError: Object.assign(new Error("private invalid state"), { code: "RESEARCH_STATE_INVALID" }),
      },
      input: { researchTaskId: recovered.researchTaskId, resumeAction: "retry_codex_auth" },
    },
  ];

  for (const scenario of cases) {
    const actions = [];
    const harness = createHarness({
      initialState: scenario.initialState,
      storeOptions: scenario.storeOptions,
      transportFactory(_events, runtimeClock) {
        return new LocalAgentBridgeRuntime({
          agentEndpoint: "https://api.public.org/api/agent",
          now: runtimeClock,
          fetch: async (_url, init) => {
            const body = JSON.parse(init.body);
            actions.push(body.action);
            if (body.action === "claimAgentRun") {
              return Response.json({
                ok: true,
                data: {
                  agentRunId: body.agentRunId,
                  claimedAt: "2026-09-01T00:00:00.000Z",
                  expiresAt: "2026-09-01T00:15:00.000Z",
                  nextSequence: 1,
                },
              });
            }
            assert.equal(body.action, "revokeAgentRunSelf");
            return Response.json({
              ok: true,
              action: body.action,
              data: { agentRunId: body.agentRunId, revokedAt: "2026-09-01T00:01:00.000Z" },
            });
          },
        });
      },
    });
    harness.service.prepare("trip-private");
    await harness.service.claim("agent-run-invalid-resume");

    await assert.rejects(harness.service.resumeTravelResearch({
    tripId: "trip-private",
      agentRunId: "agent-run-invalid-resume",
      operationId: "resume-operation-invalid-state",
      ...scenario.input,
    }), { code: "CODEX_RESEARCH_FAILED" }, scenario.name);

    assert.deepEqual(actions, ["claimAgentRun", "revokeAgentRunSelf"], scenario.name);
    assert.equal(harness.transport.claimedRun, undefined, scenario.name);
    if (scenario.initialState && !scenario.storeOptions) {
      assert.deepEqual(harness.store.state, recovered, scenario.name);
    }
    assert.doesNotThrow(() => harness.service.prepare("trip-private"), scenario.name);
  }
});

test("an unclaimed or mismatched resume preserves blocked recovery and never revokes another run", async () => {
  const request = await targetRequest();
  const recovered = {
    researchTaskId: "research-task-preserved-resume",
    codexThreadId: "thread-preserved-resume",
    targetCategory: "hotel",
    targetScopeId: request.targetScopeId,
    disclosureFingerprint: request.disclosureFingerprint,
    aliasSalt: "alias-salt-preserved-resume",
    blockedReason: "codex_auth_required",
    blockedHostname: null,
    activeRuntimeMs: 12_000,
    phase: "needs_owner_action",
    startedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:01:00.000Z",
  };
  const createRuntimeHarness = () => {
    const actions = [];
    const harness = createHarness({
      initialState: recovered,
      scripts: [{ codexThreadId: recovered.codexThreadId, output: completedOutput(), activeDurationMs: 13_000 }],
      transportFactory(_events, runtimeClock) {
        return new LocalAgentBridgeRuntime({
          agentEndpoint: "https://api.public.org/api/agent",
          now: runtimeClock,
          fetch: async (_url, init) => {
            const body = JSON.parse(init.body);
            actions.push(body.action);
            if (body.action === "claimAgentRun") {
              return Response.json({
                ok: true,
                data: {
                  agentRunId: body.agentRunId,
                  claimedAt: "2026-09-01T00:00:00.000Z",
                  expiresAt: "2026-09-01T00:15:00.000Z",
                  nextSequence: 1,
                },
              });
            }
            if (body.action === "getDecisionContext") {
              return Response.json({ ok: true, action: body.action, data: contextFixture() });
            }
            if (body.action === "submitProposalBatch") {
              return Response.json({ ok: true, action: body.action, data: candidateBatchData() });
            }
            assert.equal(body.action, "revokeAgentRunSelf");
            return Response.json({
              ok: true,
              action: body.action,
              data: { agentRunId: body.agentRunId, revokedAt: "2026-09-01T00:02:00.000Z" },
            });
          },
        });
      },
    });
    return { ...harness, actions };
  };

  const unclaimed = createRuntimeHarness();
  assert.equal((await unclaimed.service.getResearchStatus("trip-private")).phase, "needs_owner_action");
  await assert.rejects(unclaimed.service.resumeTravelResearch({
    tripId: "trip-private",
    agentRunId: "agent-run-correct-resume",
    operationId: "resume-operation-unclaimed",
    researchTaskId: recovered.researchTaskId,
    resumeAction: "retry_codex_auth",
  }), { code: "AGENT_RUN_INACTIVE" });
  assert.deepEqual(unclaimed.store.state, recovered);
  assert.equal((await unclaimed.service.getResearchStatus("trip-private")).phase, "needs_owner_action");
  assert.deepEqual(unclaimed.actions, []);

  unclaimed.service.prepare("trip-private");
  await unclaimed.service.claim("agent-run-correct-resume");
  const completed = await unclaimed.service.resumeTravelResearch({
    tripId: "trip-private",
    agentRunId: "agent-run-correct-resume",
    operationId: "resume-operation-completed",
    researchTaskId: recovered.researchTaskId,
    resumeAction: "retry_codex_auth",
  });
  assert.equal(completed.phase, "completed");
  assert.deepEqual(unclaimed.actions, [
    "claimAgentRun",
    "getDecisionContext",
    "submitProposalBatch",
    "revokeAgentRunSelf",
  ]);

  const mismatched = createRuntimeHarness();
  assert.equal((await mismatched.service.getResearchStatus("trip-private")).phase, "needs_owner_action");
  mismatched.service.prepare("trip-private");
  await mismatched.service.claim("agent-run-other");
  await assert.rejects(mismatched.service.resumeTravelResearch({
    tripId: "trip-private",
    agentRunId: "agent-run-correct-resume",
    operationId: "resume-operation-mismatch",
    researchTaskId: recovered.researchTaskId,
    resumeAction: "retry_codex_auth",
  }), { code: "AGENT_RUN_INACTIVE" });
  assert.deepEqual(mismatched.store.state, recovered);
  assert.equal((await mismatched.service.getResearchStatus("trip-private")).phase, "needs_owner_action");
  assert.equal(mismatched.transport.claimedRun.agentRunId, "agent-run-other");
  assert.deepEqual(mismatched.actions, ["claimAgentRun"]);
});

test("cancelling an old blocker releases a newer orphan claim after external cloud revocation", async () => {
  const request = await targetRequest();
  const recovered = {
    researchTaskId: "research-task-old-blocker",
    codexThreadId: "thread-old-blocker",
    targetCategory: "hotel",
    targetScopeId: request.targetScopeId,
    disclosureFingerprint: request.disclosureFingerprint,
    aliasSalt: "alias-salt-old-blocker",
    blockedReason: "codex_auth_required",
    blockedHostname: null,
    activeRuntimeMs: 12_000,
    phase: "needs_owner_action",
    startedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:01:00.000Z",
  };
  const actions = [];
  const harness = createHarness({
    initialState: recovered,
    transportFactory(_events, runtimeClock) {
      return new LocalAgentBridgeRuntime({
        agentEndpoint: "https://api.public.org/api/agent",
        now: runtimeClock,
        fetch: async (_url, init) => {
          const body = JSON.parse(init.body);
          actions.push(body.action);
          if (body.action === "claimAgentRun") {
            return Response.json({
              ok: true,
              data: {
                agentRunId: body.agentRunId,
                claimedAt: "2026-09-01T00:00:00.000Z",
                expiresAt: "2026-09-01T00:15:00.000Z",
                nextSequence: 1,
              },
            });
          }
          assert.equal(body.action, "revokeAgentRunSelf");
          return Response.json({ ok: false, error: "INVALID_AGENT_CLAIM" }, { status: 403 });
        },
      });
    },
  });
  assert.equal((await harness.service.getResearchStatus("trip-private")).phase, "needs_owner_action");
  harness.service.prepare("trip-private");
  await harness.service.claim("agent-run-new-orphan");

  const status = await cancelCurrentResearch(harness.service);

  assert.equal(status.phase, "cancelled");
  assert.deepEqual(actions, ["claimAgentRun", "revokeAgentRunSelf"]);
  assert.equal(harness.transport.claimedRun, undefined);
  assert.doesNotThrow(() => harness.service.prepare("trip-private"));
});

test("an uncertain orphan revoke keeps the claim and reports failed instead of cancelled", async () => {
  const request = await targetRequest();
  const recovered = {
    researchTaskId: "research-task-uncertain-orphan",
    codexThreadId: "thread-uncertain-orphan",
    targetCategory: "hotel",
    targetScopeId: request.targetScopeId,
    disclosureFingerprint: request.disclosureFingerprint,
    aliasSalt: "alias-salt-uncertain-orphan",
    blockedReason: "codex_auth_required",
    blockedHostname: null,
    activeRuntimeMs: 12_000,
    phase: "needs_owner_action",
    startedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:01:00.000Z",
  };
  const harness = createHarness({ initialState: recovered, transportOptions: { uncertainRevoke: true } });
  await harness.service.getResearchStatus("trip-private");
  harness.service.prepare("trip-private");
  await harness.service.claim("agent-run-uncertain-orphan");

  const status = await cancelCurrentResearch(harness.service);

  assert.equal(status.phase, "failed");
  assert.equal(status.errorCode, "AGENT_TRANSPORT_UNAVAILABLE");
  assert.equal(harness.transport.claimedRun?.agentRunId, "agent-run-uncertain-orphan");
  assert.equal(harness.events.filter((event) => event === "transport.revokeSelf").length, 1);
});

test("a failed trip with an uncertain retained claim cannot initialize another trip", async () => {
  const request = await targetRequest();
  const recovered = {
    researchTaskId: "research-task-uncertain-trip-handoff",
    codexThreadId: "thread-uncertain-trip-handoff",
    targetCategory: "hotel",
    targetScopeId: request.targetScopeId,
    disclosureFingerprint: request.disclosureFingerprint,
    aliasSalt: "alias-salt-uncertain-trip-handoff",
    blockedReason: "codex_auth_required",
    blockedHostname: null,
    activeRuntimeMs: 12_000,
    phase: "needs_owner_action",
    startedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:01:00.000Z",
  };
  const harness = createHarness({ initialState: recovered, transportOptions: { uncertainRevoke: true } });
  await harness.service.getResearchStatus("trip-private");
  harness.service.prepare("trip-private");
  await harness.service.claim("agent-run-uncertain-trip-handoff");
  const failed = await cancelCurrentResearch(harness.service);
  const eventCount = harness.events.length;

  assert.equal(failed.phase, "failed");
  assert.equal(failed.errorCode, "AGENT_TRANSPORT_UNAVAILABLE");
  await assert.rejects(harness.service.getResearchStatus("trip-next"), { code: "AGENT_RUN_INACTIVE" });
  assert.equal(harness.events.length, eventCount);
  assert.equal(harness.transport.claimedRun?.agentRunId, "agent-run-uncertain-trip-handoff");
  assert.equal(harness.runner.createCount, 0);
  assert.equal(harness.transport.submittedPayloads.length, 0);
});

test("cancelling an active task revokes its matching claim exactly once", async () => {
  let releaseContext;
  let contextStarted;
  const contextGate = new Promise((resolve) => { releaseContext = resolve; });
  const observedContext = new Promise((resolve) => { contextStarted = resolve; });
  const harness = createHarness({
    transportOptions: { contextGate },
    scripts: [{ codexThreadId: "must-not-run", output: completedOutput(), activeDurationMs: 1 }],
  });
  const originalGetContext = harness.transport.getDecisionContext.bind(harness.transport);
  harness.transport.getDecisionContext = async () => {
    contextStarted();
    return originalGetContext();
  };
  const request = await targetRequest();
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);
  const execution = harness.service.executeTravelResearch(request);
  await observedContext;

  const cancellation = cancelCurrentResearch(harness.service);
  releaseContext();
  const [executeStatus, cancelStatus] = await Promise.all([execution, cancellation]);

  assert.equal(executeStatus.phase, "cancelled");
  assert.equal(cancelStatus.phase, "cancelled");
  assert.equal(harness.events.filter((event) => event === "transport.revokeSelf").length, 1);
});

test("a cancelled trip becomes idle to another trip without weakening active trip isolation", async () => {
  let releaseContext;
  let contextStarted;
  const contextGate = new Promise((resolve) => { releaseContext = resolve; });
  const observedContext = new Promise((resolve) => { contextStarted = resolve; });
  const context = contextFixture();
  const harness = createHarness({
    context,
    transportOptions: { contextGate },
    scripts: [{ codexThreadId: "thread-next-trip", output: completedOutput(), activeDurationMs: 1 }],
  });
  const originalGetContext = harness.transport.getDecisionContext.bind(harness.transport);
  harness.transport.getDecisionContext = async () => {
    contextStarted();
    return originalGetContext();
  };
  const firstRequest = await targetRequest(context);
  harness.service.prepare(firstRequest.tripId);
  await harness.service.claim(firstRequest.agentRunId);
  const execution = harness.service.executeTravelResearch(firstRequest);
  await observedContext;

  await assert.rejects(harness.service.getResearchStatus("trip-next"), { code: "AGENT_RUN_INACTIVE" });

  const cancellation = cancelCurrentResearch(harness.service);
  releaseContext();
  const [executeStatus, cancelStatus] = await Promise.all([execution, cancellation]);
  assert.equal(executeStatus.phase, "cancelled");
  assert.equal(cancelStatus.phase, "cancelled");

  context.workspace.tripId = "trip-next";
  const nextRequest = {
    ...await targetRequest(context),
    agentRunId: "agent-run-2",
    operationId: "operation-2",
  };
  assert.deepEqual(await harness.service.getResearchStatus(nextRequest.tripId), { phase: "idle" });
  harness.service.prepare(nextRequest.tripId);
  await harness.service.claim(nextRequest.agentRunId);

  const nextStatus = await harness.service.executeTravelResearch(nextRequest);

  assert.equal(nextStatus.phase, "completed");
  assert.equal(nextStatus.tripId, nextRequest.tripId);
  assert.equal(nextStatus.researchTaskId, "research-task-2");
  assert.equal(harness.runner.createCount, 1);
});

test("cleanup revoke remains available after cancellation exhausts the active research budget", async () => {
  let releaseContext;
  let contextStarted;
  const contextGate = new Promise((resolve) => { releaseContext = resolve; });
  const observedContext = new Promise((resolve) => { contextStarted = resolve; });
  const clock = createClock();
  const actions = [];
  const harness = createHarness({
    clock,
    scripts: [{ codexThreadId: "must-not-run", output: completedOutput(), activeDurationMs: 1 }],
    transportFactory(_events, runtimeClock) {
      return new LocalAgentBridgeRuntime({
        agentEndpoint: "https://api.public.org/api/agent",
        now: runtimeClock,
        fetch: async (_url, init) => {
          const body = JSON.parse(init.body);
          actions.push(body.action);
          if (body.action === "claimAgentRun") {
            return Response.json({
              ok: true,
              data: {
                agentRunId: body.agentRunId,
                claimedAt: "2026-09-01T00:00:00.000Z",
                expiresAt: "2026-09-01T00:15:00.000Z",
                nextSequence: 1,
              },
            });
          }
          if (body.action === "getDecisionContext") {
            contextStarted();
            await contextGate;
            return Response.json({ ok: true, action: body.action, data: contextFixture() });
          }
          assert.equal(body.action, "revokeAgentRunSelf");
          return Response.json({
            ok: true,
            action: body.action,
            data: { agentRunId: body.agentRunId, revokedAt: "2026-09-01T00:10:00.001Z" },
          });
        },
      });
    },
  });
  const request = await targetRequest();
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);
  const execution = harness.service.executeTravelResearch(request);
  await observedContext;
  const cancellation = cancelCurrentResearch(harness.service);

  clock.advance(600_001);
  releaseContext();
  const [executeStatus, cancelStatus] = await Promise.all([execution, cancellation]);

  assert.equal(executeStatus.phase, "cancelled");
  assert.equal(cancelStatus.phase, "cancelled");
  assert.deepEqual(actions, ["claimAgentRun", "getDecisionContext", "revokeAgentRunSelf"]);
  assert.equal(harness.runner.createCount, 0);
  assert.equal(harness.transport.claimedRun, undefined);
  assert.equal(harness.store.state, undefined);
});

test("permanently uncertain context uses capped exponential backoff and releases only after run expiry", async () => {
  const clock = createAutoAdvanceClock(undefined, { parkedDelays: [8_000] });
  let contextAttempts = 0;
  const harness = createHarness({
    clock,
    scripts: [{ codexThreadId: "must-not-run", output: completedOutput(), activeDurationMs: 1 }],
    transportFactory(_events, runtimeClock) {
      return new LocalAgentBridgeRuntime({
        agentEndpoint: "https://api.public.org/api/agent",
        now: runtimeClock,
        fetch: async (_url, init) => {
          const body = JSON.parse(init.body);
          if (body.action === "claimAgentRun") {
            return Response.json({
              ok: true,
              data: {
                agentRunId: body.agentRunId,
                claimedAt: "2026-09-01T00:00:00.000Z",
                expiresAt: "2026-09-01T00:00:20.000Z",
                nextSequence: 1,
              },
            });
          }
          if (body.action === "revokeAgentRunSelf") {
            return Response.json({
              ok: true,
              action: body.action,
              data: { agentRunId: body.agentRunId, revokedAt: "2026-09-01T00:00:01.000Z" },
            });
          }
          assert.equal(body.action, "getDecisionContext");
          contextAttempts += 1;
          if (contextAttempts > 20) {
            return Response.json({ ok: false, error: "INVALID_REQUEST" }, { status: 400 });
          }
          throw new TypeError("context response permanently unknown");
        },
      });
    },
  });
  const request = await targetRequest();
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);

  const status = await harness.service.executeTravelResearch(request);

  assert.equal(status.phase, "failed");
  assert.equal(status.errorCode, "AGENT_RUN_INACTIVE");
  assert.equal(contextAttempts, 9);
  assert.deepEqual(clock.delays, [100, 200, 400, 800, 1_600, 3_200, 5_000, 5_000, 3_700]);
  assert.equal(harness.runner.createCount, 0);
  assert.equal(harness.transport.claimedRun, undefined);
  assert.equal(harness.store.state, undefined);
});

test("an expired uncertain resume context releases the run without deleting blocked recovery", async () => {
  const request = await targetRequest();
  const recovered = {
    researchTaskId: "research-task-expired-context",
    codexThreadId: "thread-expired-context",
    targetCategory: "hotel",
    targetScopeId: request.targetScopeId,
    disclosureFingerprint: request.disclosureFingerprint,
    aliasSalt: "alias-salt-expired-context",
    blockedReason: "codex_auth_required",
    blockedHostname: null,
    activeRuntimeMs: 12_000,
    phase: "needs_owner_action",
    startedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:01:00.000Z",
  };
  const clock = createAutoAdvanceClock(undefined, { parkedDelays: [8_000] });
  let contextAttempts = 0;
  const harness = createHarness({
    clock,
    initialState: recovered,
    scripts: [{ codexThreadId: "must-not-run", output: completedOutput(), activeDurationMs: 1 }],
    transportFactory(_events, runtimeClock) {
      return new LocalAgentBridgeRuntime({
        agentEndpoint: "https://api.public.org/api/agent",
        now: runtimeClock,
        fetch: async (_url, init) => {
          const body = JSON.parse(init.body);
          if (body.action === "claimAgentRun") {
            return Response.json({
              ok: true,
              data: {
                agentRunId: body.agentRunId,
                claimedAt: "2026-09-01T00:00:00.000Z",
                expiresAt: "2026-09-01T00:00:07.000Z",
                nextSequence: 1,
              },
            });
          }
          assert.equal(body.action, "getDecisionContext");
          contextAttempts += 1;
          if (contextAttempts > 20) {
            return Response.json({ ok: false, error: "INVALID_REQUEST" }, { status: 400 });
          }
          throw new TypeError("resume context response permanently unknown");
        },
      });
    },
  });
  assert.equal((await harness.service.getResearchStatus("trip-private")).phase, "needs_owner_action");
  harness.service.prepare("trip-private");
  await harness.service.claim("agent-run-expired-context");

  const status = await harness.service.resumeTravelResearch({
    tripId: "trip-private",
    agentRunId: "agent-run-expired-context",
    operationId: "resume-operation-expired-context",
    researchTaskId: recovered.researchTaskId,
    resumeAction: "retry_codex_auth",
  });

  assert.deepEqual(status, {
    phase: "needs_owner_action",
    researchTaskId: recovered.researchTaskId,
    ...RECOVERED_OPERATION_IDENTITY,
    startedAt: recovered.startedAt,
    updatedAt: recovered.updatedAt,
    blockedReason: "codex_auth_required",
  });
  assert.equal(contextAttempts, 7);
  assert.deepEqual(harness.store.state, recovered);
  assert.equal(harness.runner.createCount, 0);
  assert.equal(harness.transport.claimedRun, undefined);
});

test("restart resume fallback preserves the recovered operation identity so exact cancellation still works", async () => {
  const request = await targetRequest();
  const recovered = {
    researchTaskId: "research-task-restart-fallback",
    codexThreadId: "thread-restart-fallback",
    targetCategory: "hotel",
    targetScopeId: request.targetScopeId,
    disclosureFingerprint: request.disclosureFingerprint,
    aliasSalt: "alias-salt-restart-fallback",
    blockedReason: "codex_auth_required",
    blockedHostname: null,
    activeRuntimeMs: 12_000,
    phase: "needs_owner_action",
    startedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:01:00.000Z",
  };
  const harness = createHarness({
    initialState: recovered,
    transportFactory(events) {
      const transport = fakeTransport(events, contextFixture());
      transport.getDecisionContext = async () => {
        events.push("transport.getDecisionContext");
        throw Object.assign(new Error("run expired after resume admission"), { code: "AGENT_RUN_INACTIVE" });
      };
      return transport;
    },
  });
  harness.service.prepare("trip-private");
  await harness.service.claim("agent-run-restart-fallback");

  const fallback = await harness.service.resumeTravelResearch({
    tripId: "trip-private",
    agentRunId: "agent-run-restart-fallback",
    operationId: "operation-restart-fallback",
    researchTaskId: recovered.researchTaskId,
    resumeAction: "retry_codex_auth",
  });

  assert.deepEqual(fallback, {
    phase: "needs_owner_action",
    researchTaskId: recovered.researchTaskId,
    ...RECOVERED_OPERATION_IDENTITY,
    startedAt: recovered.startedAt,
    updatedAt: recovered.updatedAt,
    blockedReason: recovered.blockedReason,
  });
  const cancelled = await harness.service.cancelResearch({
    tripId: "trip-private",
    researchTaskId: fallback.researchTaskId,
    agentRunId: fallback.agentRunId,
    operationId: fallback.operationId,
  });
  assert.equal(cancelled.phase, "cancelled");
});

test("a recovered reconciliation is visible only to its exactly bound trip", async () => {
  const request = await targetRequest();
  let releaseRevoke;
  const revokeGate = new Promise((resolve) => { releaseRevoke = resolve; });
  const harness = createHarness({
    initialState: recoveredReconciliation(request),
    transportOptions: { revokeGate },
  });

  await assert.rejects(
    harness.service.getResearchStatus("trip-other-with-identical-projection"),
    { code: "AGENT_RUN_INACTIVE" },
  );
  const owned = await harness.service.getResearchStatus("trip-private");
  assert.equal(owned.tripId, "trip-private");
  assert.equal(owned.researchTaskId, "research-task-reconciliation");
  releaseRevoke();
});

test("a final owner-action CAS conflict prevents a recovered intent from revoking again", async () => {
  const request = await targetRequest();
  const recovered = recoveredReconciliation(request);
  const competing = {
    ...recovered,
    recordType: "proposal_submit_reconciliation",
    researchTaskId: "research-task-competing-proposal",
    operationId: "operation-competing-proposal",
  };
  const harness = createHarness({
    initialState: recovered,
    storeOptions: {
      replaceBeforeNeedsOwnerAction: () => competing,
    },
  });

  await harness.service.getResearchStatus(request.tripId);
  while (harness.store.state?.recordType !== "proposal_submit_reconciliation") {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(harness.events.filter((event) => event === "transport.revokeSelf").length, 1);

  await harness.service.getResearchStatus(request.tripId);
  await new Promise((resolve) => setImmediate(resolve));
  await harness.service.getResearchStatus(request.tripId);

  assert.equal(harness.events.filter((event) => event === "transport.revokeSelf").length, 1);
  assert.equal(harness.store.state.recordType, "proposal_submit_reconciliation");
});

test("a recovered revoke adopts an owner-action successor committed before a store error", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "travel-owner-action-readback-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "application-data");
  const stateFilePath = join(directory, "travel-research-state.json");
  let injectFault = false;
  let failDirectorySync = false;
  const fileSystem = {
    ...fs,
    async open(path, flags, mode) {
      const handle = await fs.open(path, flags, mode);
      if (path !== directory || !failDirectorySync) return handle;
      return {
        async stat(...args) { return handle.stat(...args); },
        async sync() {
          failDirectorySync = false;
          throw new Error("directory sync failed after owner action publish");
        },
        async close() { return handle.close(); },
      };
    },
    async rename(from, to) {
      const result = await fs.rename(from, to);
      if (injectFault && to === stateFilePath) failDirectorySync = true;
      return result;
    },
  };
  const store = createResearchStateStore({ directory, fileSystem, resolveHostname: PUBLIC_RESOLVER });
  const request = await targetRequest();
  const recovered = recoveredReconciliation(request);
  await store.persistSelfRevokeReconciliation(recovered);
  injectFault = true;
  const events = [];
  let notifications = 0;
  const service = new TravelResearchService({
    transport: fakeTransport(events, contextFixture()),
    runner: fakeRunner(events, []),
    store,
    notifier: { async notifyOwnerAction() { notifications += 1; return true; } },
    clock: createClock(),
    idGenerator: () => "unused-recovery-id",
  });

  let status = await service.getResearchStatus(request.tripId);
  for (let attempt = 0; attempt < 100 && status.phase !== "needs_owner_action"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    status = await service.getResearchStatus(request.tripId);
  }

  assert.equal(status.phase, "needs_owner_action");
  assert.equal(events.filter((event) => event === "transport.revokeSelf").length, 1);
  assert.equal(notifications, 1);
  assert.equal((await store.load()).recordType, undefined);
  await service.getResearchStatus(request.tripId);
  assert.equal(events.filter((event) => event === "transport.revokeSelf").length, 1);
});

test("an identical projection from another trip cannot resume or replace the bound blocker", async () => {
  const request = await targetRequest();
  const recovered = {
    tripId: "trip-private",
    researchTaskId: "research-task-trip-bound",
    codexThreadId: "thread-trip-bound",
    targetCategory: "hotel",
    targetScopeId: request.targetScopeId,
    disclosureFingerprint: request.disclosureFingerprint,
    aliasSalt: "alias-salt-trip-bound",
    blockedReason: "codex_auth_required",
    blockedHostname: null,
    activeRuntimeMs: 12_000,
    phase: "needs_owner_action",
    startedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:01:00.000Z",
  };
  const harness = createHarness({
    initialState: recovered,
    scripts: [{ codexThreadId: recovered.codexThreadId, output: completedOutput(), activeDurationMs: 13_000 }],
  });

  await assert.rejects(harness.service.getResearchStatus("trip-other-with-identical-projection"), { code: "AGENT_RUN_INACTIVE" });
  harness.service.prepare("trip-other-with-identical-projection");
  await harness.service.claim("agent-run-trip-other");
  await assert.rejects(harness.service.resumeTravelResearch({
    tripId: "trip-other-with-identical-projection",
    agentRunId: "agent-run-trip-other",
    operationId: "operation-trip-other",
    researchTaskId: recovered.researchTaskId,
    resumeAction: "retry_codex_auth",
  }), { code: "CODEX_RESEARCH_FAILED" });
  assert.equal(harness.runner.createCount, 0);
  assert.equal(harness.transport.submittedPayloads.length, 0);
  assert.deepEqual(harness.store.state, recovered);
  assert.equal(harness.transport.claimedRun, undefined);
  assert.equal(harness.transport.prepare().publicKeyJwk.x, "generation-2");

  harness.service.prepare("trip-private");
  await harness.service.claim("agent-run-trip-owner");
  const completed = await harness.service.resumeTravelResearch({
    tripId: "trip-private",
    agentRunId: "agent-run-trip-owner",
    operationId: "operation-trip-owner",
    researchTaskId: recovered.researchTaskId,
    resumeAction: "retry_codex_auth",
  });
  assert.equal(completed.phase, "completed");
});

test("resume rejects a signed context for another trip without clearing the original blocker", async () => {
  const request = await targetRequest();
  const recovered = {
    tripId: request.tripId,
    researchTaskId: "research-task-context-trip-mismatch",
    codexThreadId: "thread-context-trip-mismatch",
    targetCategory: "hotel",
    targetScopeId: request.targetScopeId,
    disclosureFingerprint: request.disclosureFingerprint,
    aliasSalt: "alias-salt-context-trip-mismatch",
    blockedReason: "codex_auth_required",
    blockedHostname: null,
    activeRuntimeMs: 12_000,
    phase: "needs_owner_action",
    startedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:01:00.000Z",
  };
  const mismatchedContext = contextFixture();
  mismatchedContext.trip.id = "trip-other";
  mismatchedContext.workspace.tripId = "trip-other";
  const harness = createHarness({ context: mismatchedContext, initialState: recovered });
  harness.service.prepare(request.tripId);
  await harness.service.claim("agent-run-context-trip-mismatch");

  await assert.rejects(harness.service.resumeTravelResearch({
    tripId: request.tripId,
    agentRunId: "agent-run-context-trip-mismatch",
    operationId: "operation-context-trip-mismatch",
    researchTaskId: recovered.researchTaskId,
    resumeAction: "retry_codex_auth",
  }), { code: "CODEX_RESEARCH_FAILED" });

  assert.equal(harness.runner.createCount, 0);
  assert.equal(harness.transport.submittedPayloads.length, 0);
  assert.equal(harness.transport.claimedRun, undefined);
  assert.deepEqual(harness.store.state, recovered);
  assert.deepEqual(await harness.service.getResearchStatus(request.tripId), {
    phase: "needs_owner_action",
    tripId: request.tripId,
    researchTaskId: recovered.researchTaskId,
    ...RECOVERED_OPERATION_IDENTITY,
    startedAt: recovered.startedAt,
    updatedAt: recovered.updatedAt,
    blockedReason: recovered.blockedReason,
  });
});

test("a matching exact cancel wins while recovered self-revoke reconciliation is in flight", async () => {
  const request = await targetRequest();
  let releaseRevoke;
  let revokeStarted;
  const revokeGate = new Promise((resolve) => { releaseRevoke = resolve; });
  const observedRevoke = new Promise((resolve) => { revokeStarted = resolve; });
  const harness = createHarness({
    initialState: recoveredReconciliation(request),
    transportFactory(events) {
      const transport = fakeTransport(events, contextFixture());
      transport.reconcileRevokeSelf = async () => {
        events.push("transport.revokeSelf");
        revokeStarted();
        await revokeGate;
        throw Object.assign(new Error("already revoked"), { code: "AGENT_RUN_INACTIVE" });
      };
      return transport;
    },
  });

  const reconciling = await harness.service.getResearchStatus("trip-private");
  await observedRevoke;
  const cancellation = harness.service.cancelResearch({
    tripId: "trip-private",
    researchTaskId: reconciling.researchTaskId,
    agentRunId: reconciling.agentRunId,
    operationId: reconciling.operationId,
  });
  releaseRevoke();

  const cancelledStatus = await cancellation;
  assert.equal(cancelledStatus.phase, "cancelled");
  assert.equal(cancelledStatus.tripId, "trip-private");
  assert.equal(harness.store.state, undefined);
  assert.equal(harness.events.includes("notifier.notifyOwnerAction"), false);
});

test("one recovered cancel retries a transient store clear and finishes cancelled", async () => {
  const request = await targetRequest();
  let releaseRevoke;
  let revokeStarted;
  const revokeGate = new Promise((resolve) => { releaseRevoke = resolve; });
  const observedRevoke = new Promise((resolve) => { revokeStarted = resolve; });
  const harness = createHarness({
    initialState: recoveredReconciliation(request),
    storeOptions: { clearFailures: [1] },
    transportFactory(events) {
      const transport = fakeTransport(events, contextFixture());
      transport.reconcileRevokeSelf = async () => {
        events.push("transport.revokeSelf");
        revokeStarted();
        await revokeGate;
        throw Object.assign(new Error("already revoked"), { code: "AGENT_RUN_INACTIVE" });
      };
      return transport;
    },
  });

  const reconciling = await harness.service.getResearchStatus("trip-private");
  await observedRevoke;
  const cancellation = harness.service.cancelResearch({
    tripId: reconciling.tripId,
    researchTaskId: reconciling.researchTaskId,
    agentRunId: reconciling.agentRunId,
    operationId: reconciling.operationId,
  });
  releaseRevoke();

  const cancelledStatus = await cancellation;
  assert.equal(cancelledStatus.phase, "cancelled");
  assert.equal(harness.events.filter((event) => event === "store.clear").length, 2);
  assert.equal(harness.store.state, undefined);
  assert.equal((await harness.service.getResearchStatus("trip-private")).phase, "cancelled");
});

test("a self-revoke intent persistence failure discards only the unsent runtime envelope", async () => {
  const harness = createHarness({
    scripts: [{ codexThreadId: "thread-persist-failure", output: ownerAction("codex_auth_required"), activeDurationMs: 10 }],
    storeOptions: { reconciliationPersistError: Object.assign(new Error("persist failed"), { code: "RESEARCH_STATE_UNAVAILABLE" }) },
  });
  const request = await targetRequest();
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);

  const result = await harness.service.executeTravelResearch(request);

  assert.equal(result.phase, "failed");
  assert.equal(harness.events.filter((event) => event === "transport.discardPreparedRevokeSelf").length, 1);
  assert.equal(harness.store.state, undefined);
});

test("a self-revoke intent published before a persistence error is read back and retained", async () => {
  const harness = createHarness({
    scripts: [{ codexThreadId: "thread-persist-read-back", output: ownerAction("codex_auth_required"), activeDurationMs: 10 }],
    storeOptions: {
      reconciliationPersistErrorAfterWrite: Object.assign(new Error("directory sync failed after rename"), {
        code: "RESEARCH_STATE_UNAVAILABLE",
      }),
    },
  });
  const request = await targetRequest();
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);

  const result = await harness.service.executeTravelResearch(request);

  assert.equal(result.reconciliationState, "self_revoke_reconciling");
  assert.equal(harness.store.state?.recordType, "self_revoke_reconciliation");
  assert.equal(harness.store.state?.tripId, request.tripId);
  assert.equal(harness.store.state?.agentRunId, request.agentRunId);
  assert.equal(harness.events.includes("transport.discardPreparedRevokeSelf"), false);
});

test("a non-exact self-revoke intent read back after a persistence error fails without acting on it", async () => {
  const mismatches = [
    ["recordType", "other_reconciliation"],
    ["reconciliationState", "active"],
    ["activePhase", "writing"],
    ["codexThreadId", "thread-read-back-mismatch"],
    ["targetCategory", "restaurant"],
    ["targetScopeId", `scope_${"b".repeat(64)}`],
    ["disclosureFingerprint", "c".repeat(64)],
    ["aliasSalt", "alias-salt-read-back-mismatch"],
    ["blockedReason", "source_login_required"],
    ["blockedHostname", "login.example.com"],
    ["activeRuntimeMs", 11],
    ["terminalPhase", "failed"],
    ["startedAt", "2026-09-01T00:00:01.000Z"],
    ["updatedAt", "2026-09-01T00:00:02.000Z"],
    ["revokeRequest", (value) => ({ ...value, agentRunId: "agent-run-read-back-mismatch" })],
    ["revokeRequest", (value) => ({ ...value, expiresAt: "2099-09-01T00:15:01.000Z" })],
    ["revokeRequest", (value) => ({ ...value, firstSentAt: value.firstSentAt + 1 })],
    ["revokeRequest", (value) => ({ ...value, body: `${value.body} ` })],
    ["revokeRequest", (value) => ({ ...value, extra: "not-allowed" })],
  ];

  for (const [field, replacement] of mismatches) {
    const harness = createHarness({
      scripts: [{ codexThreadId: "thread-persist-mismatch", output: ownerAction("codex_auth_required"), activeDurationMs: 10 }],
      storeOptions: {
        transformReconciliationAfterWrite: (state) => ({
          ...state,
          [field]: typeof replacement === "function" ? replacement(state[field]) : replacement,
        }),
        reconciliationPersistErrorAfterWrite: Object.assign(new Error("directory sync failed after rename"), {
          code: "RESEARCH_STATE_UNAVAILABLE",
        }),
      },
    });
    const request = await targetRequest();
    harness.service.prepare("trip-private");
    await harness.service.claim(request.agentRunId);

    const result = await harness.service.executeTravelResearch(request);
    const polled = await harness.service.getResearchStatus(request.tripId);

    assert.equal(result.phase, "failed", field);
    assert.equal(polled.phase, "failed", field);
    assert.equal(harness.events.includes("transport.revokeSelf"), false, field);
    assert.equal(harness.events.includes("transport.discardPreparedRevokeSelf"), true, field);
    assert.equal(harness.store.state === undefined, false, field);
  }
});

test("a persisted self-revoke responsibility survives definitive revoke and final blocker persistence failures", async () => {
  for (const failure of ["revoke", "final-persist"]) {
    const request = await targetRequest();
    const harness = createHarness({
      scripts: [{ codexThreadId: `thread-${failure}`, output: ownerAction("codex_auth_required"), activeDurationMs: 10 }],
      transportFactory: failure === "revoke" ? (events) => {
        const transport = fakeTransport(events, contextFixture());
        transport.reconcileRevokeSelf = async () => {
          events.push("transport.revokeSelf");
          throw Object.assign(new Error("definitive 4xx"), { code: "CODEX_RESEARCH_FAILED" });
        };
        return transport;
      } : undefined,
      storeOptions: failure === "final-persist"
        ? { persistError: Object.assign(new Error("final persist failed"), { code: "RESEARCH_STATE_UNAVAILABLE" }) }
        : undefined,
    });
    harness.service.prepare("trip-private");
    await harness.service.claim(request.agentRunId);

    await harness.service.executeTravelResearch(request).catch(() => undefined);

    assert.equal(harness.store.state?.recordType, "self_revoke_reconciliation", failure);
    assert.equal(harness.store.state?.agentRunId, request.agentRunId, failure);
  }
});

test("a persisted self-revoke intent survives a committed-response crash and converges to the blocker after restart", async () => {
  let releaseOriginalRevoke;
  let originalRevokeStarted;
  const originalRevokeGate = new Promise((resolve) => { releaseOriginalRevoke = resolve; });
  const observedOriginalRevoke = new Promise((resolve) => { originalRevokeStarted = resolve; });
  const original = createHarness({
    scripts: [{ codexThreadId: "thread-crash-recovery", output: ownerAction("codex_auth_required"), activeDurationMs: 10 }],
    transportOptions: { revokeGate: originalRevokeGate },
  });
  const originalReconcile = original.transport.reconcileRevokeSelf.bind(original.transport);
  original.transport.reconcileRevokeSelf = async (snapshot) => {
    originalRevokeStarted();
    return originalReconcile(snapshot);
  };
  const request = await targetRequest();
  original.service.prepare("trip-private");
  await original.service.claim(request.agentRunId);
  const originalExecution = original.service.executeTravelResearch(request);
  await observedOriginalRevoke;

  const persistedIntent = original.store.state;
  assert.equal(persistedIntent.recordType, "self_revoke_reconciliation");
  assert.equal(persistedIntent.agentRunId, request.agentRunId);
  assert.equal(persistedIntent.operationId, request.operationId);
  assert.equal(persistedIntent.reconciliationState, "self_revoke_reconciling");

  let releaseRestartRevoke;
  let restartRevokeStarted;
  const restartRevokeGate = new Promise((resolve) => { releaseRestartRevoke = resolve; });
  const observedRestartRevoke = new Promise((resolve) => { restartRevokeStarted = resolve; });
  const restarted = createHarness({
    initialState: persistedIntent,
    transportFactory(events) {
      const transport = fakeTransport(events, contextFixture());
      transport.reconcileRevokeSelf = async () => {
        events.push("transport.revokeSelf");
        restartRevokeStarted();
        await restartRevokeGate;
        throw Object.assign(new Error("revoke already committed"), { code: "AGENT_RUN_INACTIVE" });
      };
      return transport;
    },
  });

  const reconciling = await restarted.service.getResearchStatus("trip-private");
  assert.equal(reconciling.phase, "validating");
  assert.equal(reconciling.reconciliationState, "self_revoke_reconciling");
  await observedRestartRevoke;
  releaseRestartRevoke();
  await new Promise((resolve) => setImmediate(resolve));
  const blocked = await restarted.service.getResearchStatus("trip-private");
  assert.equal(blocked.phase, "needs_owner_action");
  assert.equal(blocked.researchTaskId, persistedIntent.researchTaskId);
  assert.equal(blocked.agentRunId, request.agentRunId);
  assert.equal(blocked.operationId, request.operationId);
  assert.equal(blocked.reconciliationState, "active");
  assert.equal(restarted.runner.createCount, 0);
  assert.equal(restarted.store.state.phase, "needs_owner_action");

  releaseOriginalRevoke();
  assert.equal((await originalExecution).phase, "needs_owner_action");
});

test("an expired uncertain cleanup revoke releases capability before persisting owner action", async () => {
  const clock = createControlledClock();
  const revokeBodies = [];
  const harness = createHarness({
    clock,
    scripts: [{
      codexThreadId: "thread-expired-revoke",
      output: ownerAction("codex_auth_required"),
      activeDurationMs: 10,
    }],
    transportFactory(_events, runtimeClock) {
      return new LocalAgentBridgeRuntime({
        agentEndpoint: "https://api.public.org/api/agent",
        now: runtimeClock,
        fetch: async (_url, init) => {
          const body = JSON.parse(init.body);
          if (body.action === "claimAgentRun") {
            return Response.json({
              ok: true,
              data: {
                agentRunId: body.agentRunId,
                claimedAt: "2026-09-01T00:00:00.000Z",
                expiresAt: "2026-09-01T00:00:07.000Z",
                nextSequence: 1,
              },
            });
          }
          if (body.action === "getDecisionContext") {
            return Response.json({ ok: true, action: body.action, data: contextFixture() });
          }
          assert.equal(body.action, "revokeAgentRunSelf");
          revokeBodies.push(init.body);
          if (revokeBodies.length > 20) {
            return Response.json({ ok: false, error: "INVALID_REQUEST" }, { status: 400 });
          }
          throw new TypeError("revoke response permanently unknown");
        },
      });
    },
  });
  const request = await targetRequest();
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);
  const execution = harness.service.executeTravelResearch(request);
  while (revokeBodies.length === 0) await new Promise((resolve) => setImmediate(resolve));

  for (const delay of [100, 200, 400, 800, 1_600, 3_200, 700]) {
    while (clock.pendingTimers() === 0) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(clock.nextDelay(), delay);
    assert.equal(clock.fireNext(), true);
    await new Promise((resolve) => setImmediate(resolve));
  }
  const status = await execution;

  assert.equal(status.phase, "needs_owner_action");
  assert.equal(revokeBodies.length, 7);
  assert.equal(new Set(revokeBodies).size, 1);
  assert.equal(harness.transport.claimedRun, undefined);
  assert.equal(harness.store.state.phase, "needs_owner_action");
});

test("an expired uncertain submit stays pending and replays before authoritative completion", async () => {
  const clock = createControlledClock();
  const submitBodies = [];
  const harness = createHarness({
    clock,
    scripts: [{ codexThreadId: "thread-expired-submit", output: completedOutput(), activeDurationMs: 10 }],
    transportFactory(_events, runtimeClock) {
      return new LocalAgentBridgeRuntime({
        agentEndpoint: "https://api.public.org/api/agent",
        now: runtimeClock,
        fetch: async (_url, init) => {
          const body = JSON.parse(init.body);
          if (body.action === "claimAgentRun") {
            return Response.json({
              ok: true,
              data: {
                agentRunId: body.agentRunId,
                claimedAt: "2026-09-01T00:00:00.000Z",
                expiresAt: "2026-09-01T00:00:00.150Z",
                nextSequence: 1,
              },
            });
          }
          if (body.action === "getDecisionContext") {
            return Response.json({ ok: true, action: body.action, data: contextFixture() });
          }
          assert.equal(body.action, "submitProposalBatch");
          submitBodies.push(init.body);
          if (submitBodies.length <= 2) throw new TypeError("submit response unknown");
          return Response.json({
            ok: true,
            action: body.action,
            data: candidateBatchData(),
            replayed: true,
          });
        },
      });
    },
  });
  const request = await targetRequest();
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);
  const execution = harness.service.executeTravelResearch(request);
  while (submitBodies.length === 0) await new Promise((resolve) => setImmediate(resolve));

  for (const delay of [100, 200]) {
    while (clock.pendingTimers() === 0) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(clock.nextDelay(), delay);
    assert.equal(clock.fireNext(), true);
    await new Promise((resolve) => setImmediate(resolve));
  }
  const status = await execution;

  assert.equal(status.phase, "completed");
  assert.equal(submitBodies.length, 3);
  assert.equal(new Set(submitBodies).size, 1);
  assert.equal(harness.transport.claimedRun, undefined);
  assert.equal(harness.store.state, undefined);
});

test("cancelling during signed context recheck prevents runner creation and candidate writes", async () => {
  let releaseContext;
  const contextGate = new Promise((resolve) => { releaseContext = resolve; });
  const harness = createHarness({
    scripts: [{ codexThreadId: "must-not-run", output: completedOutput(), activeDurationMs: 1 }],
    transportOptions: { contextGate },
  });
  const request = await targetRequest();
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);
  const execution = harness.service.executeTravelResearch(request);
  while (!harness.events.includes("transport.getDecisionContext")) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  const cancellation = cancelCurrentResearch(harness.service);
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
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);
  const execution = harness.service.executeTravelResearch(request);
  while (!harness.events.includes("runner.runInitial")) await new Promise((resolve) => setImmediate(resolve));

    const cancellation = cancelCurrentResearch(harness.service);
  while (!harness.events.includes("runner.cancel")) await new Promise((resolve) => setImmediate(resolve));
  release();
  const [executeStatus, cancelStatus] = await Promise.all([execution, cancellation]);

  assert.equal(executeStatus.phase, "cancelled");
  assert.equal(cancelStatus.phase, "cancelled");
  assert.equal(harness.transport.submittedPayloads.length, 0);
  assert.equal(harness.store.state, undefined);
});

test("cancel requires the exact task, run, and operation without affecting the current runner on mismatch", async () => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const harness = createHarness({ scripts: [async () => {
    await waiting;
    return { codexThreadId: "thread-exact-cancel", output: completedOutput(), activeDurationMs: 10 };
  }] });
  const request = await targetRequest();
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);
  const execution = harness.service.executeTravelResearch(request);
  while (!harness.events.includes("runner.runInitial")) await new Promise((resolve) => setImmediate(resolve));
  const status = await harness.service.getResearchStatus("trip-private");

  await assert.rejects(harness.service.cancelResearch({
    tripId: "trip-private",
    researchTaskId: status.researchTaskId,
    agentRunId: "agent-run-other",
    operationId: status.operationId,
  }), { code: "AGENT_RUN_INACTIVE" });
  assert.equal(harness.events.includes("runner.cancel"), false);
  assert.equal((await harness.service.getResearchStatus("trip-private")).phase, "researching");

  const cancellation = cancelCurrentResearch(harness.service);
  release();
  const [executeStatus, cancelStatus] = await Promise.all([execution, cancellation]);
  assert.equal(executeStatus.phase, "cancelled");
  assert.equal(cancelStatus.phase, "cancelled");
});

test("cancel during writing waits for terminal reconciliation and never reports cancelled", async () => {
  for (const submitError of [undefined, Object.assign(new Error("private submit failure"), {
    code: "AGENT_TRANSPORT_UNAVAILABLE",
  })]) {
    let releaseSubmit;
    const submitGate = new Promise((resolve) => { releaseSubmit = resolve; });
    const harness = createHarness({
      scripts: [{
        codexThreadId: "thread-writing-cancel",
        output: completedOutput(),
        activeDurationMs: 10_000,
      }],
      transportOptions: { submitGate, submitError },
    });
    const request = await targetRequest();
    harness.service.prepare("trip-private");
    await harness.service.claim(request.agentRunId);
    const execution = harness.service.executeTravelResearch(request);
    while (!harness.events.includes("transport.submitProposalBatch")) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const cancellation = cancelCurrentResearch(harness.service);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await harness.service.getResearchStatus("trip-private")).phase, "cancelling");
    releaseSubmit();
    const [executeStatus, cancelStatus] = await Promise.all([execution, cancellation]);

    const expectedPhase = submitError ? "failed" : "completed";
    assert.equal(executeStatus.phase, expectedPhase);
    assert.equal(cancelStatus.phase, expectedPhase);
    assert.notEqual(executeStatus.phase, "cancelled");
    if (submitError) {
      assert.equal(executeStatus.errorCode, "AGENT_TRANSPORT_UNAVAILABLE");
      assert.equal(harness.events.includes("transport.revokeSelf"), true);
      assert.equal(harness.transport.claimedRun, undefined);
    }
  }
});

test("uncertain cloud submit retries an identical payload and writes only once logically", async () => {
  const harness = createHarness({
    scripts: [{ codexThreadId: "thread-submit", output: completedOutput(), activeDurationMs: 20_000 }],
    transportOptions: { uncertainSubmitOnce: true },
  });
  const request = await targetRequest();
  harness.service.prepare("trip-private");
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

test("uncertain blocker revocation replays until determined before persistence", async () => {
  const harness = createHarness({
    scripts: [{ codexThreadId: "thread-block", output: ownerAction(), activeDurationMs: 10_000 }],
    transportOptions: { uncertainRevokeCount: 2 },
  });
  const request = await targetRequest();
  harness.service.prepare("trip-private");
  await harness.service.claim(request.agentRunId);

  const status = await harness.service.executeTravelResearch(request);

  assert.equal(status.phase, "needs_owner_action");
  assert.equal(harness.events.filter((event) => event === "transport.revokeSelf").length, 3);
  assert.equal(harness.events.includes("store.persistNeedsOwnerAction"), true);
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

  const status = await harness.service.getResearchStatus("trip-private");
  assert.deepEqual(status, {
    phase: "needs_owner_action",
    researchTaskId: "research-task-1",
    ...RECOVERED_OPERATION_IDENTITY,
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
    tripId: "trip-private",
    researchTaskId: "task-2",
    agentRunId: "agent-run-safe",
    operationId: "operation-safe",
    reconciliationState: "active",
    startedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:01:00.000Z",
    errorCode: "CODEX_RESEARCH_FAILED",
    codexThreadId: "secret",
    output: { private: true },
    detail: "/Users/private/path",
  }), {
    phase: "failed",
    tripId: "trip-private",
    researchTaskId: "task-2",
    agentRunId: "agent-run-safe",
    operationId: "operation-safe",
    reconciliationState: "active",
    startedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:01:00.000Z",
    errorCode: "CODEX_RESEARCH_FAILED",
  });

  for (const [phase, stage] of [
    ["researching", "collecting_candidates"],
    ["resuming", "collecting_candidates"],
    ["validating", "verifying_sources"],
    ["writing", "writing_shared_decisions"],
    ["cancelling", "stopping"],
  ]) {
    assert.deepEqual(safeResearchStatus({
      phase,
      tripId: "trip-private",
      researchTaskId: "task-active",
      agentRunId: "agent-run-safe",
      operationId: "operation-safe",
      reconciliationState: "active",
      startedAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:04:00.000Z",
      codexThreadId: "secret-thread",
      output: { evidence: "private" },
    }), {
      phase,
      tripId: "trip-private",
      researchTaskId: "task-active",
      agentRunId: "agent-run-safe",
      operationId: "operation-safe",
      reconciliationState: "active",
      startedAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:04:00.000Z",
      progress: {
        stage,
        candidateCount: 0,
        previews: [],
        firstResultDeadlineAt: "2026-09-01T00:03:00.000Z",
        delayNotice: "first_results_delayed",
      },
    });
  }

  assert.throws(() => safeResearchStatus({
    phase: "researching",
    tripId: "trip-private",
    researchTaskId: "task-active",
    agentRunId: "agent-run-safe",
    operationId: "operation-safe",
    reconciliationState: "active",
    startedAt: "+275760-09-13T00:00:00.000Z",
    updatedAt: "+275760-09-13T00:00:00.000Z",
  }), { code: "CODEX_RESEARCH_FAILED" });

  for (const blockedHostname of ["127.0.0.1", "agent.localhost", "source.internal"]) {
    assert.throws(() => safeResearchStatus({
      phase: "needs_owner_action",
      researchTaskId: "task-3",
      agentRunId: "agent-run-safe",
      operationId: "operation-safe",
      reconciliationState: "active",
      startedAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:01:00.000Z",
      blockedReason: "source_login_required",
      blockedHostname,
    }), { code: "CODEX_RESEARCH_FAILED" });
  }
});
