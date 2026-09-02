import { createHash } from "node:crypto";
import { isIP } from "node:net";

import {
  PROPOSAL_RECONCILIATION_STATE_FIELDS,
  RECONCILIATION_STATE_FIELDS,
} from "./research-state-store.mjs";
import { buildTravelResearchInput } from "./travel-research-input.mjs";
import { validateTravelResearchOutput } from "./travel-research-output.mjs";

const ACTIVE_BUDGET_MS = 10 * 60 * 1_000;
const CLAIM_HANDOFF_LEASE_MS = 8_000;
const CATEGORIES = new Set(["hotel", "restaurant", "attraction"]);
const RESUME_ACTIONS = new Set(["retry_codex_auth", "skip_blocked_source"]);
const SOURCE_BLOCK_REASONS = new Set([
  "source_login_required",
  "source_captcha",
  "source_risk_control",
]);
const NON_PUBLIC_HOST_SUFFIXES = [
  "localhost", "local", "internal", "lan", "home", "home.arpa", "localdomain", "corp", "intranet",
  "private", "test", "invalid", "example", "onion",
];
const ACTIVE_PHASES = new Set(["researching", "resuming", "validating", "writing", "cancelling"]);
const TERMINAL_PHASES = new Set(["completed", "failed", "cancelled", "superseded"]);
const FAILURE_CODES = new Set([
  "CODEX_NOT_AVAILABLE",
  "CODEX_ISOLATION_UNAVAILABLE",
  "CODEX_USAGE_UNAVAILABLE",
  "CODEX_RESEARCH_TIMEOUT",
  "CODEX_OUTPUT_INVALID",
  "CODEX_INSUFFICIENT_EVIDENCE",
  "INVALID_RESEARCH_TARGET",
  "AGENT_RUN_INACTIVE",
  "AGENT_TRANSPORT_UNAVAILABLE",
  "CODEX_RESEARCH_FAILED",
]);
const CONTINUE_EVIDENCE_PROMPT = "现有结果证据不足。请在原旅行研究任务和原授权范围内继续搜索公开来源，并按原固定 JSON Schema 输出完整结果。";
const RETRY_AUTH_PROMPT = "Codex 登录已由设备所有者恢复。请继续原旅行研究任务，不得扩大范围，并按原固定 JSON Schema 输出完整结果。";
const RECONCILIATION_BACKOFF_INITIAL_MS = 100;
const RECONCILIATION_BACKOFF_CAP_MS = 5_000;

function codedError(code, uncertain = false) {
  return Object.assign(new Error(code), { code, uncertain });
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys) {
  return plainObject(value)
    && Reflect.ownKeys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function preparedCapabilityIdentity(value) {
  const key = plainObject(value?.publicKeyJwk) ? value.publicKeyJwk : {};
  const publicFields = [
    key.kty,
    key.crv,
    key.x,
    key.y,
    value?.pairingCodeHash,
    value?.pairingCodeFingerprint,
  ].map((field) => typeof field === "string" ? field : null);
  return createHash("sha256").update(JSON.stringify(publicFields)).digest("base64url");
}

function opaqueIdentifier(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}

function canonicalTimestamp(value) {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function safeHostname(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 253 || value !== value.toLowerCase()) return false;
  if (!value.includes(".") || value.startsWith(".") || value.endsWith(".") || value.includes("..")) return false;
  if (isIP(value) !== 0
    || NON_PUBLIC_HOST_SUFFIXES.some((suffix) => value === suffix || value.endsWith(`.${suffix}`))) return false;
  return value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label));
}

function baseStatus(value) {
  if (!opaqueIdentifier(value.tripId)
    || !opaqueIdentifier(value.researchTaskId)
    || !opaqueIdentifier(value.agentRunId)
    || !opaqueIdentifier(value.operationId)
    || !["active", "self_revoke_reconciling"].includes(value.reconciliationState)
    || !canonicalTimestamp(value.startedAt) || !canonicalTimestamp(value.updatedAt)) {
    throw codedError("CODEX_RESEARCH_FAILED");
  }
  return {
    phase: value.phase,
    tripId: value.tripId,
    researchTaskId: value.researchTaskId,
    agentRunId: value.agentRunId,
    operationId: value.operationId,
    reconciliationState: value.reconciliationState,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
  };
}

function sameReconciliationIntent(left, right) {
  const revokeRequestFields = ["agentRunId", "expiresAt", "firstSentAt", "body"];
  if (!exactKeys(left, RECONCILIATION_STATE_FIELDS)
    || !exactKeys(right, RECONCILIATION_STATE_FIELDS)
    || !exactKeys(left.revokeRequest, revokeRequestFields)
    || !exactKeys(right.revokeRequest, revokeRequestFields)) return false;
  return RECONCILIATION_STATE_FIELDS.every((field) => field === "revokeRequest"
    ? revokeRequestFields.every((requestField) => left.revokeRequest[requestField] === right.revokeRequest[requestField])
    : left[field] === right[field]);
}

function sameProposalReconciliation(left, right) {
  const submissionFields = [
    "agentRunId", "expiresAt", "firstSentAt", "submitBody", "successRevokeBody", "failureRevokeBody",
  ];
  if (!exactKeys(left, PROPOSAL_RECONCILIATION_STATE_FIELDS)
    || !exactKeys(right, PROPOSAL_RECONCILIATION_STATE_FIELDS)
    || !exactKeys(left.submission, submissionFields)
    || !exactKeys(right.submission, submissionFields)) return false;
  return PROPOSAL_RECONCILIATION_STATE_FIELDS.every((field) => field === "submission"
    ? submissionFields.every((requestField) => left.submission[requestField] === right.submission[requestField])
    : left[field] === right[field]);
}

export function safeResearchStatus(value) {
  if (!plainObject(value) || typeof value.phase !== "string") throw codedError("CODEX_RESEARCH_FAILED");
  if (value.phase === "idle") return Object.freeze({ phase: "idle" });
  const result = baseStatus(value);
  if (ACTIVE_PHASES.has(value.phase)) return Object.freeze(result);
  if (value.reconciliationState !== "active") throw codedError("CODEX_RESEARCH_FAILED");
  if (value.phase === "completed") return Object.freeze(result);
  if (value.phase === "needs_owner_action") {
    if (value.blockedReason === "codex_auth_required") {
      return Object.freeze({ ...result, blockedReason: value.blockedReason });
    }
    if (!SOURCE_BLOCK_REASONS.has(value.blockedReason) || !safeHostname(value.blockedHostname)) {
      throw codedError("CODEX_RESEARCH_FAILED");
    }
    return Object.freeze({
      ...result,
      blockedReason: value.blockedReason,
      blockedHostname: value.blockedHostname,
    });
  }
  if (value.phase === "superseded") {
    if (value.errorCode !== "DISCLOSURE_CONTEXT_CHANGED") throw codedError("CODEX_RESEARCH_FAILED");
    return Object.freeze({ ...result, errorCode: value.errorCode });
  }
  if (value.phase === "failed") {
    if (!FAILURE_CODES.has(value.errorCode)) throw codedError("CODEX_RESEARCH_FAILED");
    return Object.freeze({ ...result, errorCode: value.errorCode });
  }
  if (value.phase === "cancelled") {
    if (value.errorCode !== "CODEX_RESEARCH_CANCELLED") throw codedError("CODEX_RESEARCH_FAILED");
    return Object.freeze({ ...result, errorCode: value.errorCode });
  }
  throw codedError("CODEX_RESEARCH_FAILED");
}

function recoverableRunnerState(session, error, result) {
  const candidates = [result?.state, error?.state];
  try {
    if (typeof session?.getState === "function") candidates.push(session.getState());
  } catch {
    // A broken runner state accessor cannot make private failure details public.
  }
  for (const state of candidates) {
    if (!plainObject(state)) continue;
    if (typeof state.codexThreadId !== "string" || state.codexThreadId.length === 0) continue;
    if (typeof state.activeDurationMs !== "number" || !Number.isFinite(state.activeDurationMs)
      || state.activeDurationMs < 0 || state.activeDurationMs > ACTIVE_BUDGET_MS) continue;
    return {
      codexThreadId: state.codexThreadId,
      activeDurationMs: state.activeDurationMs,
    };
  }
  if (typeof result?.codexThreadId === "string"
    && typeof result.activeDurationMs === "number" && Number.isFinite(result.activeDurationMs)
    && result.activeDurationMs >= 0 && result.activeDurationMs <= ACTIVE_BUDGET_MS) {
    return { codexThreadId: result.codexThreadId, activeDurationMs: result.activeDurationMs };
  }
  return undefined;
}

function stableFailureCode(error, evidenceContinuation = false) {
  if (evidenceContinuation && error?.code === "CODEX_RESEARCH_TIMEOUT") return "CODEX_INSUFFICIENT_EVIDENCE";
  if (error?.code === "AGENT_RUN_EXPIRED" || error?.code === "BRIDGE_NOT_CLAIMED"
    || error?.code === "AGENT_RUN_MISMATCH" || error?.code === "INVALID_AGENT_CLAIM") return "AGENT_RUN_INACTIVE";
  if (FAILURE_CODES.has(error?.code)) return error.code;
  if (error?.code === "CODEX_NOT_AUTHENTICATED") return "CODEX_RESEARCH_FAILED";
  if (error?.code === "RESEARCH_STATE_UNAVAILABLE" || error?.code === "RESEARCH_STATE_INVALID"
    || error?.code === "RESEARCH_STATE_BUSY") return "CODEX_RESEARCH_FAILED";
  return "CODEX_RESEARCH_FAILED";
}

export class TravelResearchService {
  #transport;
  #runner;
  #store;
  #notifier;
  #guardedNotifier;
  #clock;
  #idGenerator;
  #setTimer;
  #clearTimer;
  #status = Object.freeze({ phase: "idle" });
  #task;
  #session;
  #inflight;
  #operationKey;
  #operationAgentRunId;
  #claimHandoffLease;
  #recoveryRecord;
  #reconciliationRecord;
  #proposalReconciliationRecord;
  #preparedTripId;
  #preparedCapabilityIdentity;
  #restored = false;
  #cancelRequested = false;
  #lastSeenTime;

  constructor(dependencies) {
    const keys = ["transport", "runner", "store", "notifier", "clock", "idGenerator"];
    if (!exactKeys(dependencies, keys)) throw codedError("CODEX_RESEARCH_FAILED");
    const { transport, runner, store, notifier, clock, idGenerator } = dependencies;
    if (!transport || typeof transport.prepare !== "function" || typeof transport.claim !== "function"
      || typeof transport.getDecisionContext !== "function" || typeof transport.revokeSelf !== "function"
      || typeof transport.releaseUnboundClaim !== "function"
      || typeof transport.expireUnboundClaim !== "function"
      || typeof transport.prepareRevokeSelf !== "function"
      || typeof transport.discardPreparedRevokeSelf !== "function"
      || typeof transport.reconcileRevokeSelf !== "function"
      || typeof transport.prepareProposalSubmission !== "function"
      || typeof transport.restoreProposalSubmission !== "function"
      || typeof transport.reconcileProposalSubmission !== "function"
      || typeof transport.restoreProposalRevoke !== "function"
      || typeof transport.reconcileProposalRevoke !== "function"
      || typeof transport.discardPreparedProposalSubmission !== "function"
      || (typeof transport.submitProposalBatch !== "function" && typeof transport.command !== "function")
      || !runner || typeof runner.create !== "function"
      || !store || typeof store.load !== "function" || typeof store.clear !== "function"
      || typeof store.persistNeedsOwnerAction !== "function"
      || typeof store.persistSelfRevokeReconciliation !== "function"
      || typeof store.persistProposalReconciliation !== "function"
      || !notifier || typeof notifier.notifyOwnerAction !== "function"
      || typeof clock !== "function" || typeof idGenerator !== "function") {
      throw codedError("CODEX_RESEARCH_FAILED");
    }
    this.#transport = transport;
    this.#runner = runner;
    this.#store = store;
    this.#notifier = notifier;
    this.#guardedNotifier = Object.freeze({
      notifyOwnerAction: (transitionKey) => {
        if (this.#cancelRequested) return false;
        return this.#notifier.notifyOwnerAction(transitionKey);
      },
    });
    this.#clock = clock;
    this.#idGenerator = idGenerator;
    this.#setTimer = typeof clock.setTimeout === "function" ? clock.setTimeout.bind(clock) : setTimeout;
    this.#clearTimer = typeof clock.clearTimeout === "function" ? clock.clearTimeout.bind(clock) : clearTimeout;
  }

  #date() {
    let value;
    try {
      value = this.#clock();
    } catch {
      throw codedError("CODEX_RESEARCH_FAILED");
    }
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw codedError("CODEX_RESEARCH_FAILED");
    const observed = value.getTime();
    this.#lastSeenTime = this.#lastSeenTime === undefined
      ? observed
      : Math.max(this.#lastSeenTime, observed);
    return new Date(this.#lastSeenTime);
  }

  #now() {
    return this.#date().toISOString();
  }

  #setStatus(phase, extras = {}) {
    if (!this.#task) throw codedError("CODEX_RESEARCH_FAILED");
    this.#status = safeResearchStatus({
      phase,
      tripId: this.#task.tripId,
      researchTaskId: this.#task.researchTaskId,
      agentRunId: this.#task.agentRunId,
      operationId: this.#task.operationId,
      reconciliationState: this.#task.selfRevokeReconciling ? "self_revoke_reconciling" : "active",
      startedAt: this.#task.startedAt,
      updatedAt: this.#now(),
      ...extras,
    });
    return this.#status;
  }

  #finishStatus(phase, extras = {}) {
    this.#task.selfRevokeReconciling = false;
    return this.#setStatus(phase, extras);
  }

  #restoreRecoveredState(recovered) {
    const proposalReconciling = recovered.recordType === "proposal_submit_reconciliation";
    const reconciling = recovered.recordType === "self_revoke_reconciliation";
    this.#recoveryRecord = recovered;
    this.#proposalReconciliationRecord = proposalReconciling ? recovered : undefined;
    this.#reconciliationRecord = reconciling ? recovered : undefined;
    if (proposalReconciling) {
      this.#task = {
        tripId: recovered.tripId,
        researchTaskId: recovered.researchTaskId,
        agentRunId: recovered.agentRunId,
        operationId: recovered.operationId,
        agentExpiresAt: Date.parse(recovered.submission.expiresAt),
        activeRuntimeMs: recovered.activeRuntimeMs,
        runnerRuntimeMs: recovered.activeRuntimeMs,
        serviceRuntimeMs: 0,
        startedAt: recovered.startedAt,
        terminalStarted: true,
      };
      this.#status = safeResearchStatus({
        phase: "writing",
        tripId: recovered.tripId,
        researchTaskId: recovered.researchTaskId,
        agentRunId: recovered.agentRunId,
        operationId: recovered.operationId,
        reconciliationState: "active",
        startedAt: recovered.startedAt,
        updatedAt: recovered.updatedAt,
      });
      return this.#status;
    }
    this.#task = {
      tripId: recovered.tripId,
      researchTaskId: recovered.researchTaskId,
      agentRunId: recovered.agentRunId,
      operationId: recovered.operationId,
      aliasSalt: recovered.aliasSalt,
      targetCategory: recovered.targetCategory,
      targetScopeId: recovered.targetScopeId,
      disclosureFingerprint: recovered.disclosureFingerprint,
      codexThreadId: recovered.codexThreadId,
      activeRuntimeMs: recovered.activeRuntimeMs,
      runnerRuntimeMs: recovered.activeRuntimeMs,
      serviceRuntimeMs: 0,
      startedAt: recovered.startedAt,
      ...(reconciling ? {
        agentExpiresAt: Date.parse(recovered.revokeRequest.expiresAt),
        terminalStarted: true,
        pendingSignedAction: "revokeAgentRunSelf",
        selfRevokeReconciling: true,
      } : {}),
    };
    this.#status = reconciling
      ? safeResearchStatus({
          phase: recovered.activePhase,
          tripId: recovered.tripId,
          researchTaskId: recovered.researchTaskId,
          agentRunId: recovered.agentRunId,
          operationId: recovered.operationId,
          reconciliationState: "self_revoke_reconciling",
          startedAt: recovered.startedAt,
          updatedAt: recovered.updatedAt,
        })
      : safeResearchStatus(recovered);
    return this.#status;
  }

  #assertClaimed(agentRunId) {
    const claimed = this.#transport.claimedRun;
    const expiry = Date.parse(claimed?.expiresAt);
    if (!claimed || claimed.agentRunId !== agentRunId || !Number.isFinite(expiry) || expiry <= this.#date().getTime()) {
      throw codedError("AGENT_RUN_INACTIVE");
    }
    return expiry;
  }

  #newIdentifier() {
    let value;
    try {
      value = this.#idGenerator();
    } catch {
      throw codedError("CODEX_RESEARCH_FAILED");
    }
    if (!opaqueIdentifier(value)) {
      throw codedError("CODEX_RESEARCH_FAILED");
    }
    return value;
  }

  #syncActiveRuntime(runnerRuntimeMs = this.#task.runnerRuntimeMs) {
    if (typeof runnerRuntimeMs !== "number" || !Number.isFinite(runnerRuntimeMs)
      || runnerRuntimeMs < 0 || runnerRuntimeMs > ACTIVE_BUDGET_MS) {
      throw codedError("CODEX_RESEARCH_FAILED");
    }
    this.#task.runnerRuntimeMs = runnerRuntimeMs;
    this.#task.activeRuntimeMs = Math.min(
      ACTIVE_BUDGET_MS,
      runnerRuntimeMs + this.#task.serviceRuntimeMs,
    );
    return this.#task.activeRuntimeMs;
  }

  #deadline(evidenceContinuation) {
    const now = this.#date().getTime();
    const activeRemaining = ACTIVE_BUDGET_MS - this.#task.activeRuntimeMs;
    const agentRemaining = this.#task.agentExpiresAt - now;
    if (agentRemaining <= activeRemaining) {
      return { delay: Math.max(0, agentRemaining), code: "AGENT_RUN_INACTIVE" };
    }
    return {
      delay: Math.max(0, activeRemaining),
      code: evidenceContinuation ? "CODEX_INSUFFICIENT_EVIDENCE" : "CODEX_RESEARCH_TIMEOUT",
    };
  }

  async #bounded(task, {
    countService = true,
    cancelRunner = false,
    evidenceContinuation = false,
  } = {}) {
    const startedAt = this.#date().getTime();
    const deadline = this.#deadline(evidenceContinuation);
    let timer;
    let deadlineReached = false;
    try {
      if (deadline.delay <= 0) {
        if (cancelRunner && this.#session) await this.#session.cancel();
        throw codedError(deadline.code);
      }
      const operation = Promise.resolve().then(task);
      return await Promise.race([
        operation,
        new Promise((_, reject) => {
          timer = this.#setTimer(() => {
            deadlineReached = true;
            const rejectDeadline = () => reject(codedError(deadline.code));
            if (cancelRunner && this.#session) {
              Promise.resolve(this.#session.cancel()).then(rejectDeadline, rejectDeadline);
            } else {
              rejectDeadline();
            }
          }, deadline.delay);
          timer?.unref?.();
        }),
      ]);
    } catch (error) {
      if (deadlineReached) throw codedError(deadline.code);
      throw error;
    } finally {
      if (timer !== undefined) this.#clearTimer(timer);
      if (countService) {
        const elapsed = Math.max(0, this.#date().getTime() - startedAt);
        this.#task.serviceRuntimeMs += elapsed;
        this.#syncActiveRuntime();
      }
    }
  }

  #createSession(initialState) {
    const activeTimeoutMs = Math.floor(ACTIVE_BUDGET_MS - this.#task.serviceRuntimeMs);
    if (activeTimeoutMs <= 0 || (initialState && initialState.activeDurationMs >= activeTimeoutMs)) {
      throw codedError("CODEX_RESEARCH_TIMEOUT");
    }
    let session;
    try {
      session = this.#runner.create({
        activeTimeoutMs,
        ...(initialState ? { initialState } : {}),
      });
    } catch {
      throw codedError("CODEX_RESEARCH_FAILED");
    }
    if (!session || typeof session.runInitial !== "function" || typeof session.resume !== "function"
      || typeof session.cancel !== "function" || typeof session.getState !== "function") {
      throw codedError("CODEX_RESEARCH_FAILED");
    }
    return session;
  }

  prepare(tripId) {
    if (!opaqueIdentifier(tripId)) throw codedError("CODEX_RESEARCH_FAILED");
    const prepared = this.#transport.prepare();
    const capabilityIdentity = preparedCapabilityIdentity(prepared);
    if (this.#preparedTripId !== undefined && this.#preparedTripId !== tripId
      && this.#preparedCapabilityIdentity === capabilityIdentity) {
      throw codedError("CODEX_RESEARCH_FAILED");
    }
    this.#preparedTripId = tripId;
    this.#preparedCapabilityIdentity = capabilityIdentity;
    return prepared;
  }

  async claim(agentRunId) {
    if (!opaqueIdentifier(agentRunId)) throw codedError("AGENT_RUN_INACTIVE");
    try {
      const claimed = await this.#transport.claim(agentRunId);
      this.#startClaimHandoffLease(agentRunId);
      return claimed;
    } catch (error) {
      if (error?.uncertain === true || error?.code === "AGENT_TRANSPORT_UNAVAILABLE") {
        this.#startClaimHandoffLease(agentRunId);
      } else {
        this.#clearClaimHandoffLease(agentRunId);
      }
      throw error;
    }
  }

  releaseUnboundClaim(agentRunId) {
    if (!opaqueIdentifier(agentRunId)) return false;
    return this.#releaseRejectedOperation(agentRunId);
  }

  #releaseRejectedOperation(agentRunId) {
    if (agentRunId === this.#operationAgentRunId || agentRunId === this.#task?.agentRunId) return false;
    const released = this.#transport.releaseUnboundClaim(agentRunId);
    if (released === true) this.#clearClaimHandoffLease(agentRunId);
    return released;
  }

  #clearClaimHandoffLease(agentRunId) {
    const lease = this.#claimHandoffLease;
    if (!lease || lease.agentRunId !== agentRunId) return false;
    if (lease.timer !== undefined) this.#clearTimer(lease.timer);
    this.#claimHandoffLease = undefined;
    return true;
  }

  #startClaimHandoffLease(agentRunId) {
    if (this.#claimHandoffLease?.agentRunId === agentRunId) return;
    if (this.#claimHandoffLease) this.#clearClaimHandoffLease(this.#claimHandoffLease.agentRunId);
    const lease = { agentRunId, timer: undefined };
    lease.timer = this.#setTimer(() => {
      if (this.#claimHandoffLease !== lease) return;
      lease.timer = undefined;
      if (agentRunId === this.#operationAgentRunId || agentRunId === this.#task?.agentRunId) {
        this.#claimHandoffLease = undefined;
        return;
      }
      let released = false;
      try {
        released = this.#transport.expireUnboundClaim(agentRunId, CLAIM_HANDOFF_LEASE_MS) === true;
      } catch { /* A failed lease release leaves the runtime capability fail-safe busy. */ }
      if (released && this.#claimHandoffLease === lease) this.#claimHandoffLease = undefined;
    }, CLAIM_HANDOFF_LEASE_MS);
    lease.timer?.unref?.();
    this.#claimHandoffLease = lease;
  }

  #bindClaimHandoff(agentRunId) {
    this.#clearClaimHandoffLease(agentRunId);
  }

  executeTravelResearch(input) {
    if (!exactKeys(input, ["tripId", "agentRunId", "operationId", "targetCategory", "targetScopeId", "disclosureFingerprint"])
      || !opaqueIdentifier(input.tripId)
      || input.tripId !== this.#preparedTripId
      || !opaqueIdentifier(input.agentRunId)
      || !opaqueIdentifier(input.operationId)
      || !CATEGORIES.has(input.targetCategory)
      || typeof input.targetScopeId !== "string" || !/^scope_[a-f0-9]{64}$/u.test(input.targetScopeId)
      || typeof input.disclosureFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(input.disclosureFingerprint)) {
      if (typeof input?.agentRunId === "string") this.#releaseRejectedOperation(input.agentRunId);
      return Promise.reject(codedError("CODEX_RESEARCH_FAILED"));
    }
    const key = `execute:${JSON.stringify(input)}`;
    if (this.#inflight) {
      if (this.#operationKey === key) return this.#inflight;
      this.#releaseRejectedOperation(input.agentRunId);
      return Promise.reject(codedError("CODEX_RESEARCH_FAILED"));
    }
    if (this.#task?.operationKey === key && this.#task.agentRunId === input.agentRunId
      && this.#status.phase !== "idle") {
      return Promise.resolve(safeResearchStatus(this.#status));
    }
    if (this.#status.phase !== "idle" && !TERMINAL_PHASES.has(this.#status.phase)) {
      this.#releaseRejectedOperation(input.agentRunId);
      return Promise.reject(codedError("CODEX_RESEARCH_FAILED"));
    }
    this.#bindClaimHandoff(input.agentRunId);
    let operation;
    operation = this.#execute(input, key).finally(() => {
      if (this.#inflight === operation) {
        this.#inflight = undefined;
        this.#operationKey = undefined;
        this.#operationAgentRunId = undefined;
      }
    });
    this.#inflight = operation;
    this.#operationKey = key;
    this.#operationAgentRunId = input.agentRunId;
    return operation;
  }

  async #execute(input, operationKey) {
    let created = false;
    try {
      if (this.#status.phase !== "idle" && !TERMINAL_PHASES.has(this.#status.phase)) {
        throw codedError("CODEX_RESEARCH_FAILED");
      }
      const shouldRestore = this.#status.phase === "idle" && !this.#restored;
      const startedAt = this.#now();
      this.#task = {
        tripId: input.tripId,
        researchTaskId: this.#newIdentifier(),
        aliasSalt: this.#newIdentifier(),
        targetCategory: input.targetCategory,
        targetScopeId: input.targetScopeId,
        disclosureFingerprint: input.disclosureFingerprint,
        agentRunId: input.agentRunId,
        operationId: input.operationId,
        operationKey,
        startedAt,
        activeRuntimeMs: 0,
        runnerRuntimeMs: 0,
        serviceRuntimeMs: 0,
      };
      this.#cancelRequested = false;
      created = true;
      this.#task.agentExpiresAt = this.#assertClaimed(input.agentRunId);
      this.#setStatus("researching");
      if (shouldRestore) {
        let recovered;
        try {
          recovered = await this.#store.load();
        } catch (error) {
          this.#task = undefined;
          this.#status = Object.freeze({ phase: "idle" });
          this.#transport.releaseUnboundClaim(input.agentRunId);
          created = false;
          throw error;
        }
        this.#restored = true;
        if (recovered) {
          this.#transport.releaseUnboundClaim(input.agentRunId);
          this.#restoreRecoveredState(recovered);
          created = false;
          throw codedError("CODEX_RESEARCH_FAILED");
        }
      }
      if (this.#cancelRequested) return this.#finishCancelled();
      const context = await this.#getDecisionContext();
      if (context?.workspace?.tripId !== input.tripId) throw codedError("CODEX_RESEARCH_FAILED");
      if (this.#cancelRequested) return this.#finishCancelled();
      const built = await this.#bounded(() => buildTravelResearchInput(context, {
        targetCategory: input.targetCategory,
        targetScopeId: input.targetScopeId,
        aliasSalt: this.#task.aliasSalt,
      }));
      if (built.disclosureFingerprint !== input.disclosureFingerprint) {
        await this.#revokeStrict({ cleanup: true });
        await this.#clearRecovery();
        return this.#finishStatus("superseded", { errorCode: "DISCLOSURE_CONTEXT_CHANGED" });
      }
      if (this.#cancelRequested) return this.#finishCancelled();
      this.#task.built = built;
      this.#session = this.#createSession();
      const result = await this.#bounded(
        () => this.#session.runInitial({ prompt: built.prompt }),
        { countService: false, cancelRunner: true },
      );
      return await this.#consume(result, "researching");
    } catch (error) {
      if (created && this.#status.phase === "idle" && !this.#restored
        && stableFailureCode(error) === "AGENT_RUN_INACTIVE") {
        let recovered;
        try {
          recovered = await this.#store.load();
        } catch {
          this.#task = undefined;
          this.#status = Object.freeze({ phase: "idle" });
          created = false;
          throw codedError("CODEX_RESEARCH_FAILED");
        }
        this.#restored = true;
        if (recovered) {
          this.#restoreRecoveredState(recovered);
          created = false;
          throw codedError("CODEX_RESEARCH_FAILED");
        }
      }
      if (!created) {
        if (this.#task?.agentRunId !== input.agentRunId) {
          try {
            this.#transport.releaseUnboundClaim(input.agentRunId);
          } catch { /* The original stable failure remains authoritative. */ }
        }
        throw codedError(stableFailureCode(error));
      }
      if (error?.code === "CODEX_NOT_AUTHENTICATED") {
        const state = recoverableRunnerState(this.#session, error);
        if (state) {
          this.#task.codexThreadId = state.codexThreadId;
          this.#syncActiveRuntime(state.activeDurationMs);
          return this.#block({ status: "needs_owner_action", reason: "codex_auth_required" });
        }
      }
      return this.#handleOperationFailure(error);
    }
  }

  async #clearRecovery() {
    await this.#store.clear(this.#recoveryRecord);
    this.#recoveryRecord = undefined;
    this.#task.recoveryCleared = true;
  }

  #terminalCleanupConfirmed() {
    if (!TERMINAL_PHASES.has(this.#status.phase)
      || this.#task?.recoveryCleared !== true
      || this.#task?.pendingSignedAction
      || this.#task?.selfRevokeReconciling
      || this.#recoveryRecord
      || this.#proposalReconciliationRecord
      || this.#reconciliationRecord
      || this.#inflight) return false;
    try {
      const claimed = this.#transport.claimedRun;
      if (claimed === undefined) return true;
      const expiresAt = Date.parse(claimed.expiresAt);
      if (claimed.agentRunId !== this.#task.agentRunId
        || !Number.isFinite(expiresAt)
        || expiresAt !== this.#task.agentExpiresAt
        || expiresAt > this.#date().getTime()
        || this.#transport.expireUnboundClaim(this.#task.agentRunId, 0) !== true) return false;
      return this.#transport.claimedRun === undefined;
    } catch {
      return false;
    }
  }

  async getResearchStatus(tripId) {
    if (tripId !== undefined && !opaqueIdentifier(tripId)) throw codedError("CODEX_RESEARCH_FAILED");
    if (this.#status.phase !== "idle" || this.#restored) {
      if (tripId !== undefined && this.#task && this.#task.tripId !== tripId) {
        if (this.#terminalCleanupConfirmed()) return safeResearchStatus({ phase: "idle" });
        throw codedError("AGENT_RUN_INACTIVE");
      }
      if (this.#proposalReconciliationRecord && !this.#inflight) this.#startRecoveredProposal();
      else if (this.#reconciliationRecord && !this.#inflight) this.#startRecoveredSelfRevoke();
      return safeResearchStatus(this.#status);
    }
    let recovered;
    try {
      recovered = await this.#store.load();
    } catch {
      throw codedError("CODEX_RESEARCH_FAILED");
    }
    this.#restored = true;
    if (!recovered) return this.#status;
    this.#restoreRecoveredState(recovered);
    if (tripId !== undefined && recovered.tripId !== tripId) throw codedError("AGENT_RUN_INACTIVE");
    if (recovered.recordType === "proposal_submit_reconciliation") this.#startRecoveredProposal();
    else if (recovered.recordType === "self_revoke_reconciliation") this.#startRecoveredSelfRevoke();
    return this.#status;
  }

  #startRecoveredProposal() {
    if (!this.#proposalReconciliationRecord || this.#inflight) return;
    const record = this.#proposalReconciliationRecord;
    let operation;
    operation = (async () => {
      if (!await this.#persistProposalResponsibility(record)) {
        return safeResearchStatus(this.#status);
      }
      return this.#finishProposalReconciliation(record);
    })().finally(() => {
      if (this.#inflight === operation) this.#inflight = undefined;
    });
    this.#inflight = operation;
    void operation.catch(() => undefined);
  }

  #startRecoveredSelfRevoke() {
    if (!this.#reconciliationRecord || this.#inflight) return;
    const record = this.#reconciliationRecord;
    let operation;
    operation = this.#finishRecoveredSelfRevoke(record).finally(() => {
      if (this.#inflight === operation) this.#inflight = undefined;
    });
    this.#inflight = operation;
    void operation.catch(() => undefined);
  }

  async #finishRecoveredSelfRevoke(record) {
    if (this.#cancelRequested) return this.#finishCancelled();
    await this.#store.persistSelfRevokeReconciliation(record, record);
    this.#recoveryRecord = record;
    try {
      await this.#revokeStrict({ cleanup: true, revokeRequest: record.revokeRequest });
    } catch (error) {
      if (stableFailureCode(error) !== "AGENT_RUN_INACTIVE") throw error;
    }
    if (this.#cancelRequested) return this.#finishCancelled();
    const finalRecord = {
      researchTaskId: record.researchTaskId,
      tripId: record.tripId,
      agentRunId: record.agentRunId,
      operationId: record.operationId,
      reconciliationState: "active",
      codexThreadId: record.codexThreadId,
      targetCategory: record.targetCategory,
      targetScopeId: record.targetScopeId,
      disclosureFingerprint: record.disclosureFingerprint,
      aliasSalt: record.aliasSalt,
      blockedReason: record.blockedReason,
      blockedHostname: record.blockedHostname,
      activeRuntimeMs: record.activeRuntimeMs,
      phase: "needs_owner_action",
      startedAt: record.startedAt,
      updatedAt: this.#now(),
    };
    await this.#store.persistNeedsOwnerAction(finalRecord, this.#guardedNotifier, record);
    this.#recoveryRecord = finalRecord;
    if (this.#cancelRequested) return this.#finishCancelled();
    this.#reconciliationRecord = undefined;
    this.#task.selfRevokeReconciling = false;
    this.#status = safeResearchStatus(finalRecord);
    return this.#status;
  }

  resumeTravelResearch(input) {
    if (!exactKeys(input, ["tripId", "agentRunId", "operationId", "researchTaskId", "resumeAction"])
      || !opaqueIdentifier(input.tripId)
      || !opaqueIdentifier(input.agentRunId)
      || !opaqueIdentifier(input.operationId)
      || !opaqueIdentifier(input.researchTaskId)
      || !RESUME_ACTIONS.has(input.resumeAction)) {
      if (typeof input?.agentRunId === "string") this.#releaseRejectedOperation(input.agentRunId);
      return Promise.reject(codedError("CODEX_RESEARCH_FAILED"));
    }
    if (input.tripId !== this.#preparedTripId) {
      this.#releaseRejectedOperation(input.agentRunId);
      return Promise.reject(codedError("AGENT_RUN_INACTIVE"));
    }
    const operationKey = `resume:${JSON.stringify(input)}`;
    if (this.#inflight) {
      if (this.#operationKey === operationKey) return this.#inflight;
      this.#releaseRejectedOperation(input.agentRunId);
      return Promise.reject(codedError("CODEX_RESEARCH_FAILED"));
    }
    if (this.#task?.operationKey === operationKey && this.#task.agentRunId === input.agentRunId
      && this.#status.phase !== "idle") {
      return Promise.resolve(safeResearchStatus(this.#status));
    }
    if (this.#status.phase !== "idle"
      && (this.#status.phase !== "needs_owner_action"
        || this.#task?.researchTaskId !== input.researchTaskId
        || (input.resumeAction === "retry_codex_auth") !== (this.#status.blockedReason === "codex_auth_required"))) {
      this.#releaseRejectedOperation(input.agentRunId);
      return Promise.reject(codedError("CODEX_RESEARCH_FAILED"));
    }
    this.#bindClaimHandoff(input.agentRunId);
    let operation;
    operation = this.#resume(input, operationKey).finally(() => {
      if (this.#inflight === operation) {
        this.#inflight = undefined;
        this.#operationKey = undefined;
        this.#operationAgentRunId = undefined;
      }
    });
    this.#inflight = operation;
    this.#operationKey = operationKey;
    this.#operationAgentRunId = input.agentRunId;
    return operation;
  }

  async #resume(input, operationKey) {
    let recovered;
    const previousTask = this.#task;
    const previousStatus = this.#status;
    let claimedValidated = false;
    let resumeValidated = false;
    let contextTripRejected = false;
    try {
      const agentExpiresAt = this.#assertClaimed(input.agentRunId);
      claimedValidated = true;
      this.#task = {
        tripId: input.tripId,
        researchTaskId: input.researchTaskId,
        agentRunId: input.agentRunId,
        operationId: input.operationId,
        operationKey,
        agentExpiresAt,
        activeRuntimeMs: 0,
        runnerRuntimeMs: 0,
        serviceRuntimeMs: 0,
        startedAt: this.#now(),
      };
      recovered = await this.#store.load();
      if (!recovered || recovered.phase !== "needs_owner_action"
        || recovered.tripId !== input.tripId
        || recovered.researchTaskId !== input.researchTaskId) {
        throw codedError("CODEX_RESEARCH_FAILED");
      }
      if ((input.resumeAction === "retry_codex_auth") !== (recovered.blockedReason === "codex_auth_required")) {
        throw codedError("INVALID_RESUME_ACTION");
      }
      this.#task = {
        tripId: recovered.tripId,
        researchTaskId: recovered.researchTaskId,
        aliasSalt: recovered.aliasSalt,
        targetCategory: recovered.targetCategory,
        targetScopeId: recovered.targetScopeId,
        disclosureFingerprint: recovered.disclosureFingerprint,
        codexThreadId: recovered.codexThreadId,
        activeRuntimeMs: recovered.activeRuntimeMs,
        runnerRuntimeMs: recovered.activeRuntimeMs,
        serviceRuntimeMs: 0,
        agentRunId: input.agentRunId,
        operationId: input.operationId,
        operationKey,
        agentExpiresAt,
        startedAt: recovered.startedAt,
      };
      this.#recoveryRecord = recovered;
      resumeValidated = true;
      this.#cancelRequested = false;
      this.#setStatus("resuming");
      const context = await this.#getDecisionContext();
      if (context?.workspace?.tripId !== input.tripId) {
        contextTripRejected = true;
        throw codedError("CODEX_RESEARCH_FAILED");
      }
      let built;
      try {
        built = await this.#bounded(() => buildTravelResearchInput(context, {
          targetCategory: recovered.targetCategory,
          targetScopeId: recovered.targetScopeId,
          aliasSalt: recovered.aliasSalt,
        }));
      } catch (error) {
        if (error?.code !== "INVALID_RESEARCH_TARGET") throw error;
        await this.#supersedeCurrentRun();
        return this.#status;
      }
      if (built.disclosureFingerprint !== recovered.disclosureFingerprint) {
        await this.#supersedeCurrentRun();
        return this.#status;
      }
      if (this.#cancelRequested) return this.#finishCancelled();
      this.#task.built = built;
      if (this.#task.activeRuntimeMs >= ACTIVE_BUDGET_MS) {
        return this.#finishFailure("CODEX_INSUFFICIENT_EVIDENCE");
      }
      this.#session = this.#createSession({
        codexThreadId: recovered.codexThreadId,
        correctionUsed: true,
        activeDurationMs: recovered.activeRuntimeMs,
      });
      const prompt = input.resumeAction === "retry_codex_auth"
        ? RETRY_AUTH_PROMPT
        : `继续原旅行研究任务。不得再访问 ${recovered.blockedHostname}；只能寻找其他公开来源，并按原固定 JSON Schema 输出完整结果。`;
      const result = await this.#bounded(
        () => this.#session.resume({ codexThreadId: recovered.codexThreadId, prompt }),
        { countService: false, cancelRunner: true },
      );
      return await this.#consume(result, "resuming");
    } catch (error) {
      if (!claimedValidated) {
        this.#task = previousTask;
        this.#status = previousStatus;
        throw codedError(stableFailureCode(error));
      }
      if ((!resumeValidated || contextTripRejected) && this.#task?.agentRunId === input.agentRunId) {
        try {
          await this.#revokeStrict({ cleanup: true });
        } catch (revokeError) {
          throw codedError(stableFailureCode(revokeError));
        } finally {
          this.#task = previousTask;
          this.#status = previousStatus;
        }
        throw codedError("CODEX_RESEARCH_FAILED");
      }
      if (resumeValidated && !this.#cancelRequested
        && stableFailureCode(error) === "AGENT_RUN_INACTIVE") {
        this.#task = previousTask ?? {
          tripId: recovered.tripId,
          researchTaskId: recovered.researchTaskId,
          aliasSalt: recovered.aliasSalt,
          targetCategory: recovered.targetCategory,
          targetScopeId: recovered.targetScopeId,
          disclosureFingerprint: recovered.disclosureFingerprint,
          codexThreadId: recovered.codexThreadId,
          activeRuntimeMs: recovered.activeRuntimeMs,
          runnerRuntimeMs: recovered.activeRuntimeMs,
          serviceRuntimeMs: 0,
          agentRunId: recovered.agentRunId,
          operationId: recovered.operationId,
          startedAt: recovered.startedAt,
        };
        this.#status = previousStatus.phase === "needs_owner_action"
          ? previousStatus
          : safeResearchStatus(recovered);
        return this.#status;
      }
      if (!this.#task) throw codedError(stableFailureCode(error));
      if (error?.code === "CODEX_NOT_AUTHENTICATED") {
        const state = recoverableRunnerState(this.#session, error);
        if (state) {
          this.#task.codexThreadId = state.codexThreadId;
          this.#syncActiveRuntime(state.activeDurationMs);
          return this.#block({ status: "needs_owner_action", reason: "codex_auth_required" });
        }
      }
      return this.#handleOperationFailure(error);
    }
  }

  async #supersedeCurrentRun() {
    try {
      await this.#revokeStrict({ cleanup: true });
    } catch {
      return this.#finishFailure("AGENT_TRANSPORT_UNAVAILABLE", false);
    }
    await this.#clearRecovery();
    this.#finishStatus("superseded", { errorCode: "DISCLOSURE_CONTEXT_CHANGED" });
    return this.#status;
  }

  async #consume(initialResult, runningPhase) {
    let result = initialResult;
    let evidenceContinuation = false;
    try {
      for (;;) {
        if (this.#cancelRequested) return this.#finishCancelled();
        const runnerState = recoverableRunnerState(this.#session, undefined, result);
        if (!runnerState) throw codedError("CODEX_RESEARCH_FAILED");
        this.#task.codexThreadId = runnerState.codexThreadId;
        this.#syncActiveRuntime(runnerState.activeDurationMs);
        this.#setStatus("validating");
        let validated;
        try {
          validated = await this.#bounded(() => validateTravelResearchOutput(result.output, {
            targetCategory: this.#task.targetCategory,
            segment: this.#task.built.disclosure.segment,
            aliasMap: this.#task.built.aliasMap,
            round: this.#task.built.round,
            now: () => this.#date(),
            ...(typeof this.#runner.resolveHostname === "function"
              ? { resolveHostname: this.#runner.resolveHostname }
              : {}),
          }), { evidenceContinuation });
        } catch (error) {
          if (error?.code !== "CODEX_INSUFFICIENT_EVIDENCE") throw error;
          if (this.#task.activeRuntimeMs >= ACTIVE_BUDGET_MS) {
            throw codedError("CODEX_INSUFFICIENT_EVIDENCE");
          }
          evidenceContinuation = true;
          this.#setStatus(runningPhase);
          result = await this.#bounded(
            () => this.#session.resume({
              codexThreadId: this.#task.codexThreadId,
              prompt: CONTINUE_EVIDENCE_PROMPT,
            }),
            { countService: false, cancelRunner: true, evidenceContinuation: true },
          );
          continue;
        }
        if (this.#task.activeRuntimeMs >= ACTIVE_BUDGET_MS && validated.status === "completed") {
          throw codedError("CODEX_RESEARCH_TIMEOUT");
        }
        if (this.#cancelRequested) return this.#finishCancelled();
        if (validated.status === "needs_owner_action") {
          return this.#block(validated);
        }
        this.#assertClaimed(this.#task.agentRunId);
        this.#setStatus("writing");
        if (this.#cancelRequested) return this.#finishCancelled();
        await this.#bounded(() => this.#clearRecovery());
        if (this.#cancelRequested) return this.#finishCancelled();
        const submission = this.#transport.prepareProposalSubmission(validated.payload);
        const record = {
          recordType: "proposal_submit_reconciliation",
          tripId: this.#task.tripId,
          researchTaskId: this.#task.researchTaskId,
          agentRunId: this.#task.agentRunId,
          operationId: this.#task.operationId,
          reconciliationState: "active",
          submission,
          activeRuntimeMs: Math.min(ACTIVE_BUDGET_MS, Math.ceil(this.#task.activeRuntimeMs)),
          startedAt: this.#task.startedAt,
          updatedAt: this.#now(),
        };
        this.#proposalReconciliationRecord = record;
        if (!await this.#persistProposalResponsibility(record, { discardIfAbsent: true })) {
          return safeResearchStatus(this.#status);
        }
        return this.#finishProposalReconciliation(record);
      }
    } catch (error) {
      if (error?.code === "CODEX_NOT_AUTHENTICATED") {
        const state = recoverableRunnerState(this.#session, error, result);
        if (state) {
          this.#task.codexThreadId = state.codexThreadId;
          this.#syncActiveRuntime(state.activeDurationMs);
          return this.#block({ status: "needs_owner_action", reason: "codex_auth_required" });
        }
      }
      return this.#handleOperationFailure(error, evidenceContinuation);
    }
  }

  async #block(blocked) {
    try {
      if (!this.#task.codexThreadId) throw codedError("CODEX_RESEARCH_FAILED");
      const updatedAt = this.#now();
      const record = {
        tripId: this.#task.tripId,
        researchTaskId: this.#task.researchTaskId,
        agentRunId: this.#task.agentRunId,
        operationId: this.#task.operationId,
        reconciliationState: "active",
        codexThreadId: this.#task.codexThreadId,
        targetCategory: this.#task.targetCategory,
        targetScopeId: this.#task.targetScopeId,
        disclosureFingerprint: this.#task.disclosureFingerprint,
        aliasSalt: this.#task.aliasSalt,
        blockedReason: blocked.reason,
        blockedHostname: SOURCE_BLOCK_REASONS.has(blocked.reason) ? blocked.sourceHostname : null,
        activeRuntimeMs: Math.min(ACTIVE_BUDGET_MS, Math.ceil(this.#task.activeRuntimeMs)),
        phase: "needs_owner_action",
        startedAt: this.#task.startedAt,
        updatedAt,
      };
      const revokeRequest = this.#transport.prepareRevokeSelf();
      const reconciliationRecord = {
        recordType: "self_revoke_reconciliation",
        tripId: record.tripId,
        researchTaskId: record.researchTaskId,
        agentRunId: record.agentRunId,
        operationId: record.operationId,
        reconciliationState: "self_revoke_reconciling",
        activePhase: ACTIVE_PHASES.has(this.#status.phase) ? this.#status.phase : "validating",
        revokeRequest,
        codexThreadId: record.codexThreadId,
        targetCategory: record.targetCategory,
        targetScopeId: record.targetScopeId,
        disclosureFingerprint: record.disclosureFingerprint,
        aliasSalt: record.aliasSalt,
        blockedReason: record.blockedReason,
        blockedHostname: record.blockedHostname,
        activeRuntimeMs: record.activeRuntimeMs,
        terminalPhase: "needs_owner_action",
        startedAt: record.startedAt,
        updatedAt: record.updatedAt,
      };
      try {
        await this.#store.persistSelfRevokeReconciliation(reconciliationRecord, this.#recoveryRecord);
      } catch (error) {
        let observed;
        let readBackCertain = true;
        try {
          observed = await this.#store.load();
        } catch {
          readBackCertain = false;
        }
        if (readBackCertain && observed === undefined) {
          this.#transport.discardPreparedRevokeSelf(revokeRequest);
          throw error;
        }
        const exactReadBack = readBackCertain && sameReconciliationIntent(observed, reconciliationRecord);
        if (readBackCertain && !exactReadBack) {
          this.#transport.discardPreparedRevokeSelf(revokeRequest);
          throw error;
        }
        this.#reconciliationRecord = readBackCertain
          ? (exactReadBack ? observed : undefined)
          : reconciliationRecord;
        this.#recoveryRecord = this.#reconciliationRecord;
        this.#task.selfRevokeReconciling = true;
        this.#status = safeResearchStatus({
          ...this.#status,
          reconciliationState: "self_revoke_reconciling",
          updatedAt: this.#now(),
        });
        return this.#status;
      }
      this.#reconciliationRecord = reconciliationRecord;
      this.#recoveryRecord = reconciliationRecord;
      this.#task.selfRevokeReconciling = true;
      this.#status = safeResearchStatus({
        ...this.#status,
        reconciliationState: "self_revoke_reconciling",
        updatedAt: this.#now(),
      });
      try {
        await this.#revokeStrict({ cleanup: true, revokeRequest });
      } catch (error) {
        if (stableFailureCode(error) !== "AGENT_RUN_INACTIVE") throw error;
      }
      if (this.#cancelRequested) return this.#finishCancelled();
      await this.#store.persistNeedsOwnerAction(record, this.#guardedNotifier, reconciliationRecord);
      this.#recoveryRecord = record;
      if (this.#cancelRequested) return this.#finishCancelled();
      this.#reconciliationRecord = undefined;
      this.#task.selfRevokeReconciling = false;
      this.#status = safeResearchStatus(record);
      return this.#status;
    } catch (error) {
      if (this.#reconciliationRecord) return safeResearchStatus(this.#status);
      return this.#finishFailure(stableFailureCode(error), false);
    }
  }

  async #submitWithRetry(payload, submission) {
    const submit = submission
      ? () => this.#transport.reconcileProposalSubmission(submission)
      : typeof this.#transport.submitProposalBatch === "function"
        ? () => this.#transport.submitProposalBatch(payload)
        : () => this.#transport.command("submitProposalBatch", payload);
    return this.#reconcileSigned("submitProposalBatch", submit, { terminal: true });
  }

  async #persistProposalResponsibility(record, { discardIfAbsent = false } = {}) {
    try {
      await this.#store.persistProposalReconciliation(record, this.#recoveryRecord);
      this.#recoveryRecord = record;
      return true;
    } catch (error) {
      let observed;
      let readBackCertain = true;
      try {
        observed = await this.#store.load();
      } catch {
        readBackCertain = false;
      }
      if (readBackCertain && sameProposalReconciliation(observed, record)) {
        this.#recoveryRecord = observed;
        return true;
      }
      if (discardIfAbsent && readBackCertain && observed === undefined) {
        this.#transport.discardPreparedProposalSubmission(record.submission);
        this.#proposalReconciliationRecord = undefined;
        throw error;
      }
      this.#proposalReconciliationRecord = record;
      return false;
    }
  }

  async #finishProposalReconciliation(record) {
    let outcome = "completed";
    let submitError;
    try {
      this.#transport.restoreProposalSubmission(record.submission);
      try {
        await this.#submitWithRetry(undefined, record.submission);
      } catch (error) {
        if (error?.uncertain) return safeResearchStatus(this.#status);
        if (stableFailureCode(error) === "AGENT_RUN_INACTIVE") {
          try {
            await this.#clearRecovery();
          } catch {
            return safeResearchStatus(this.#status);
          }
          this.#proposalReconciliationRecord = undefined;
          return this.#finishStatus("failed", { errorCode: "AGENT_RUN_INACTIVE" });
        }
        outcome = "failed";
        submitError = error;
      }
      try {
        this.#transport.restoreProposalRevoke(record.submission, outcome);
        await this.#reconcileSigned(
          "revokeAgentRunSelf",
          () => this.#transport.reconcileProposalRevoke(record.submission, outcome),
          { terminal: true, cleanup: true },
        );
      } catch (error) {
        if (stableFailureCode(error) !== "AGENT_RUN_INACTIVE") return safeResearchStatus(this.#status);
      }
      try {
        await this.#clearRecovery();
      } catch {
        return safeResearchStatus(this.#status);
      }
      this.#proposalReconciliationRecord = undefined;
      if (outcome === "completed") return this.#finishStatus("completed");
      return this.#finishStatus("failed", { errorCode: stableFailureCode(submitError) });
    } catch {
      return safeResearchStatus(this.#status);
    }
  }

  async #revokeStrict({ cleanup = false, revokeRequest } = {}) {
    try {
      return await this.#reconcileSigned(
        "revokeAgentRunSelf",
        () => revokeRequest
          ? this.#transport.reconcileRevokeSelf(revokeRequest)
          : this.#transport.revokeSelf(),
        { terminal: true, cleanup },
      );
    } catch (error) {
      if (cleanup && stableFailureCode(error) === "AGENT_RUN_INACTIVE") return { ok: true };
      throw error;
    }
  }

  async #getDecisionContext() {
    return this.#reconcileSigned("getDecisionContext", () => this.#transport.getDecisionContext());
  }

  #reconciliationState(startedAt) {
    const now = this.#date().getTime();
    const elapsed = Math.max(0, now - startedAt);
    return {
      activeExpired: this.#task.activeRuntimeMs + elapsed >= ACTIVE_BUDGET_MS,
      agentExpired: this.#task.agentExpiresAt <= now,
      agentRemainingMs: Math.max(0, this.#task.agentExpiresAt - now),
      cancelled: this.#cancelRequested,
    };
  }

  async #waitForReconciliation(delay) {
    await new Promise((resolve, reject) => {
      try {
        this.#setTimer(resolve, delay);
      } catch {
        reject(codedError("CODEX_RESEARCH_FAILED"));
      }
    });
  }

  #releaseExpiredPending(action) {
    if (action === "submitProposalBatch"
      || typeof this.#transport.releaseExpiredReadOnlyPending !== "function") return false;
    return this.#transport.releaseExpiredReadOnlyPending() === true;
  }

  async #reconcileSigned(action, operation, { terminal = false, cleanup = false } = {}) {
    const startedAt = this.#date().getTime();
    let backoffMs = RECONCILIATION_BACKOFF_INITIAL_MS;
    if (terminal) {
      this.#beginTerminalReconciliation(action, { cleanup });
    } else {
      if (this.#task.pendingSignedAction && this.#task.pendingSignedAction !== action) {
        throw codedError("AGENT_TRANSPORT_UNAVAILABLE", true);
      }
      this.#assertClaimed(this.#task.agentRunId);
      const deadline = this.#deadline(false);
      if (deadline.delay <= 0) throw codedError(deadline.code);
      this.#task.pendingSignedAction = action;
    }
    try {
      for (;;) {
        let state = this.#reconciliationState(startedAt);
        if (state.agentExpired && this.#releaseExpiredPending(action)) {
          this.#task.pendingSignedAction = undefined;
          if (action === "revokeAgentRunSelf") return { ok: true };
          throw codedError(state.cancelled ? "CODEX_RESEARCH_CANCELLED" : "AGENT_RUN_INACTIVE");
        }
        try {
          const result = await operation();
          this.#task.pendingSignedAction = undefined;
          state = this.#reconciliationState(startedAt);
          if (action === "getDecisionContext") {
            if (state.cancelled) throw codedError("CODEX_RESEARCH_CANCELLED");
            if (state.agentExpired) throw codedError("AGENT_RUN_INACTIVE");
            if (state.activeExpired) throw codedError("CODEX_RESEARCH_TIMEOUT");
          }
          return result;
        } catch (error) {
          if (!error?.uncertain) {
            this.#task.pendingSignedAction = undefined;
            throw error;
          }
          state = this.#reconciliationState(startedAt);
          if (state.agentExpired && this.#releaseExpiredPending(action)) {
            this.#task.pendingSignedAction = undefined;
            if (action === "revokeAgentRunSelf") return { ok: true };
            throw codedError(state.cancelled ? "CODEX_RESEARCH_CANCELLED" : "AGENT_RUN_INACTIVE");
          }
          const delay = action === "submitProposalBatch" || state.agentExpired
            ? backoffMs
            : Math.min(backoffMs, Math.max(1, state.agentRemainingMs));
          await this.#waitForReconciliation(delay);
          backoffMs = Math.min(RECONCILIATION_BACKOFF_CAP_MS, backoffMs * 2);
        }
      }
    } finally {
      const elapsed = Math.max(0, this.#date().getTime() - startedAt);
      this.#task.serviceRuntimeMs += elapsed;
      this.#syncActiveRuntime();
    }
  }

  #beginTerminalReconciliation(action, { cleanup = false } = {}) {
    if (this.#task.pendingSignedAction && this.#task.pendingSignedAction !== action) {
      throw codedError("AGENT_TRANSPORT_UNAVAILABLE", true);
    }
    if (!this.#task.terminalStarted) {
      if (cleanup) {
        const claimed = this.#transport.claimedRun;
        if (!claimed || claimed.agentRunId !== this.#task.agentRunId) throw codedError("AGENT_RUN_INACTIVE");
      } else {
        this.#assertClaimed(this.#task.agentRunId);
        const deadline = this.#deadline(false);
        if (deadline.delay <= 0) throw codedError(deadline.code);
      }
      this.#task.terminalStarted = true;
    }
    if (action === "revokeAgentRunSelf" && !this.#task.selfRevokeReconciling) {
      this.#task.selfRevokeReconciling = true;
      if (this.#status.phase !== "idle"
        && this.#status.tripId === this.#task.tripId
        && this.#status.researchTaskId === this.#task.researchTaskId
        && this.#status.agentRunId === this.#task.agentRunId
        && this.#status.operationId === this.#task.operationId) {
        this.#status = safeResearchStatus({
          ...this.#status,
          updatedAt: this.#now(),
          reconciliationState: "self_revoke_reconciling",
        });
      }
    }
    this.#task.pendingSignedAction = action;
  }

  async #handleOperationFailure(error, evidenceContinuation = false) {
    if (!this.#task.terminalStarted
      && (this.#cancelRequested || error?.code === "CODEX_RESEARCH_CANCELLED")) {
      return this.#finishCancelled();
    }
    const code = stableFailureCode(error, evidenceContinuation);
    return this.#finishFailure(code, code !== "AGENT_RUN_INACTIVE" && !this.#task.pendingSignedAction);
  }

  async #finishFailure(code, revoke = true) {
    let finalCode = FAILURE_CODES.has(code) ? code : "CODEX_RESEARCH_FAILED";
    if (revoke) {
      try {
        await this.#revokeStrict({ cleanup: true });
      } catch (error) {
        if (error?.code !== "CODEX_RESEARCH_TIMEOUT" && error?.code !== "AGENT_RUN_INACTIVE") {
          finalCode = "AGENT_TRANSPORT_UNAVAILABLE";
        }
      }
    }
    try {
      await this.#clearRecovery();
    } catch {
      finalCode = "CODEX_RESEARCH_FAILED";
    }
    return this.#finishStatus("failed", { errorCode: finalCode });
  }

  async #releaseOrphanClaim() {
    const claimed = this.#transport.claimedRun;
    if (!claimed || (this.#task.agentRunId && claimed.agentRunId === this.#task.agentRunId)) return;
    try {
      await this.#transport.revokeSelf();
    } catch (error) {
      if (stableFailureCode(error) !== "AGENT_RUN_INACTIVE") throw error;
    }
  }

  async #finishCancelled() {
    try {
      await this.#releaseOrphanClaim();
    } catch (error) {
      return this.#finishFailure(stableFailureCode(error), false);
    }
    if (this.#status.phase === "cancelled") return this.#status;
    if (this.#task.agentRunId && this.#transport.claimedRun?.agentRunId === this.#task.agentRunId) {
      try {
        await this.#revokeStrict({ cleanup: true });
      } catch (error) {
        return this.#finishFailure(stableFailureCode(error), false);
      }
    }
    let clearFailure;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.#clearRecovery();
        clearFailure = undefined;
        break;
      } catch (error) {
        clearFailure = error;
      }
    }
    if (clearFailure) {
      if (this.#reconciliationRecord) return safeResearchStatus(this.#status);
      return this.#finishFailure("CODEX_RESEARCH_FAILED", false);
    }
    this.#reconciliationRecord = undefined;
    return this.#finishStatus("cancelled", { errorCode: "CODEX_RESEARCH_CANCELLED" });
  }

  async cancelResearch(input) {
    if (!exactKeys(input, ["tripId", "researchTaskId", "agentRunId", "operationId"])
      || !opaqueIdentifier(input.tripId)
      || !opaqueIdentifier(input.researchTaskId)
      || !opaqueIdentifier(input.agentRunId)
      || !opaqueIdentifier(input.operationId)) {
      throw codedError("CODEX_RESEARCH_FAILED");
    }
    await this.getResearchStatus(input.tripId);
    if (!this.#task || this.#task.tripId !== input.tripId
      || this.#task.researchTaskId !== input.researchTaskId
      || this.#task.agentRunId !== input.agentRunId || this.#task.operationId !== input.operationId) {
      throw codedError("AGENT_RUN_INACTIVE");
    }
    if (["completed", "failed", "cancelled", "superseded"].includes(this.#status.phase)) {
      return safeResearchStatus(this.#status);
    }
    this.#cancelRequested = true;
    this.#setStatus("cancelling");
    try {
      if (this.#session) await this.#session.cancel();
    } catch {
      // The operation still observes cancelRequested before validation or writing.
    }
    if (this.#inflight) return this.#inflight;
    return this.#finishCancelled();
  }
}
