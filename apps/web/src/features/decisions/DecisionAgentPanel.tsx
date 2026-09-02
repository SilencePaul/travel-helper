import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AgentRunSchema,
  buildResearchDisclosure,
  buildResearchTargetScopes,
  computeDisclosureFingerprint,
  type AgentRun,
  type CandidateCategory,
  type DecisionCommand,
  type DecisionWorkspace,
  type DecisionWorkspaceRepository,
  type ResearchDisclosure,
  type ResearchResumeAction,
  type ResearchStatus,
  type Trip,
} from "@travel/contracts";
import {
  LocalAgentBridgeError,
  type ExecuteTravelResearchInput,
  type LocalAgentBridge,
  type PreparedAgentRun,
  type ResumeTravelResearchInput,
} from "../../infrastructure/localAgentBridgeClient";
import { DecisionResearchDisclosure } from "./DecisionResearchDisclosure";

type Props = {
  repository: DecisionWorkspaceRepository;
  bridge?: LocalAgentBridge;
  trip: Trip;
  workspace: DecisionWorkspace;
  onResearchCompleted: () => void | Promise<void>;
  newIdempotencyKey: () => string;
};

type Operation = "idle" | "restoring" | "preparing" | "starting" | "resuming" | "cancelling" | "error";
type CreateAgentRunCommand = Extract<DecisionCommand, { action: "createAgentRun" }>;
type AttemptStage = "create" | "claim" | "execute" | "resume";
type PendingCloudStage = "create" | "claimed" | "bridgeOperationStarted";
type PendingClaimState = "notStarted" | "uncertain" | "confirmed";
type PendingBridgeRequest =
  | { operation: "execute"; input: ExecuteTravelResearchInput }
  | { operation: "resume"; input: ResumeTravelResearchInput };
type PendingBridgeReplay =
  | { kind: "attached"; status: ResearchStatus }
  | { kind: "definitive" }
  | { kind: "uncertain" };
type PendingAttemptSettlement =
  | { kind: "attached"; status: ResearchStatus }
  | { kind: "cleaned"; status?: ResearchStatus }
  | { kind: "uncertain"; status?: ResearchStatus };
type BridgeFailureReconciliation =
  | { kind: "restored"; status: ResearchStatus }
  | { kind: "cleaned"; status?: ResearchStatus }
  | { kind: "uncertain"; status?: ResearchStatus };
type PendingCloudAttempt = {
  kind: "start" | "resume";
  stage: PendingCloudStage;
  claimState: PendingClaimState;
  repository: DecisionWorkspaceRepository;
  bridge: LocalAgentBridge;
  tripId: string;
  material: PreparedAgentRun;
  createIdempotencyKey: string;
  newIdempotencyKey: () => string;
  targetCategory?: CandidateCategory;
  targetScopeId?: string;
  disclosureFingerprint?: string;
  researchTaskId?: string;
  resumeAction?: ResearchResumeAction;
  agentRunId?: string;
  revokeIdempotencyKey?: string;
  createPromise?: Promise<string>;
  reconcilePromise?: Promise<boolean>;
  settlementPromise?: Promise<PendingAttemptSettlement>;
  bridgeRequest?: PendingBridgeRequest;
  createDefinitivelyFailed?: boolean;
};
type CloudRunHandle = {
  repository: DecisionWorkspaceRepository;
  tripId: string;
  agentRunId: string;
  revokeIdempotencyKey: string;
  statusPromise?: Promise<AgentRun>;
  reconcilePromise?: Promise<boolean>;
};
type AttachedCloudRun = CloudRunHandle & { researchTaskId: string; operationId: string };
type ResearchOperationIdentity = { researchTaskId: string; agentRunId: string; operationId: string };
type LifecycleContext = { tripSafetyKey: string; bridge?: LocalAgentBridge; repository: DecisionWorkspaceRepository };
type TripCleanupTransition = {
  lifecycle: number;
  controller: AbortController;
  sourceTripSafetyKey: string;
  bridge: LocalAgentBridge;
  repository: DecisionWorkspaceRepository;
  status: ResearchStatus;
  pending?: PendingCloudAttempt;
  attached?: CloudRunHandle;
  targetTripSafetyKey: string;
  targetBridge?: LocalAgentBridge;
  targetRepository: DecisionWorkspaceRepository;
  targetScopeId?: string;
  cleanupPromise?: Promise<ResearchStatus | undefined>;
};

const categoryOptions: Array<{ value: CandidateCategory; label: string; description: string }> = [
  { value: "hotel", label: "酒店", description: "住宿与房型" },
  { value: "restaurant", label: "餐厅", description: "用餐与营业信息" },
  { value: "attraction", label: "景点", description: "参观与票务" },
];
const categoryCopy: Record<CandidateCategory, string> = { hotel: "酒店", restaurant: "餐厅", attraction: "景点" };
const activePhases = new Set<ResearchStatus["phase"]>(["researching", "resuming", "validating", "writing", "cancelling"]);
const bridgeSelfRevokedPhases = new Set<ResearchStatus["phase"]>(["needs_owner_action", "completed", "cancelled", "superseded"]);
const cloudRevokedSafePhases = new Set<ResearchStatus["phase"]>([...bridgeSelfRevokedPhases, "failed"]);
const pollDelayMs = 2_000;
const lifecycleStatusTimeoutMs = 2_000;

function tripProjection(trip: Trip) {
  return {
    version: trip.version,
    days: trip.days.map(({ id, date, city }) => ({ id, date, city })),
    travelerNames: trip.travelers.map(({ name }) => name),
    travelerCount: trip.travelers.length,
  };
}

function statusPresentation(status: ResearchStatus): { text?: string; role: "status" | "alert" } {
  switch (status.phase) {
    case "idle": return { role: "status" };
    case "researching": return { text: "正在请 Codex 搜索候选与可核验来源", role: "status" };
    case "resuming": return { text: "Codex 正在继续研究", role: "status" };
    case "validating": return { text: "正在校验候选与来源", role: "status" };
    case "writing": return { text: "正在安全写入共同决定", role: "status" };
    case "completed": return { text: "Codex 候选已写入共同决定", role: "status" };
    case "failed": return { text: "Codex 研究未完成", role: "alert" };
    case "cancelling": return { text: "正在停止本机 Codex 研究并对账。", role: "status" };
    case "cancelled": return { text: "Codex 研究已停止", role: "status" };
    case "superseded": return { text: "将发送的内容已更新，请重新确认并启动新任务。", role: "alert" };
    case "needs_owner_action":
      return status.blockedReason === "codex_auth_required"
        ? { text: "研究已安全暂停。请在 ChatGPT/Codex 中恢复登录，项目不会索要账号或凭据。", role: "alert" }
        : { text: `研究已安全暂停：${status.blockedHostname} 需要额外访问验证。`, role: "alert" };
  }
}

function statusPhaseLabel(status: ResearchStatus): string {
  switch (status.phase) {
    case "idle": return "等待启动";
    case "researching": return "搜索中";
    case "resuming": return "恢复中";
    case "validating": return "校验中";
    case "writing": return "写入中";
    case "completed": return "已完成";
    case "failed": return "未完成";
    case "cancelling": return "停止并对账中";
    case "cancelled": return "已停止";
    case "superseded": return "内容已更新";
    case "needs_owner_action": return "等待设备管理员处理";
  }
}

async function runBoundedCleanupCall<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        timeout = globalThis.setTimeout(() => {
          controller.abort();
          reject(new Error("RESEARCH_STATUS_TIMEOUT"));
        }, lifecycleStatusTimeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) globalThis.clearTimeout(timeout);
  }
}

async function readResearchStatusForCleanup(bridge: LocalAgentBridge): Promise<ResearchStatus> {
  return runBoundedCleanupCall((signal) => bridge.getResearchStatus({ signal }));
}

async function waitForBoundedCleanup<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = globalThis.setTimeout(() => reject(new Error("CLOUD_RECONCILIATION_TIMEOUT")), lifecycleStatusTimeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) globalThis.clearTimeout(timeout);
  }
}

async function loadAgentRunStatus(
  repository: DecisionWorkspaceRepository,
  tripId: string,
  agentRunId: string,
): Promise<AgentRun> {
  if (!repository.getAgentRunStatus) throw new Error("AGENT_STATUS_UNAVAILABLE");
  const value = await repository.getAgentRunStatus(tripId, agentRunId);
  const parsed = AgentRunSchema.safeParse(value);
  if (!parsed.success || parsed.data.tripId !== tripId || parsed.data.agentRunId !== agentRunId) {
    throw new Error("INVALID_AGENT_RUN_STATUS");
  }
  return parsed.data;
}

async function readAgentRunStatus(
  owner: { statusPromise?: Promise<AgentRun> },
  repository: DecisionWorkspaceRepository,
  tripId: string,
  agentRunId: string,
): Promise<AgentRun> {
  if (!owner.statusPromise) {
    const request = loadAgentRunStatus(repository, tripId, agentRunId);
    owner.statusPromise = request;
    void request.then(
      () => { if (owner.statusPromise === request) owner.statusPromise = undefined; },
      () => { if (owner.statusPromise === request) owner.statusPromise = undefined; },
    );
  }
  const request = owner.statusPromise;
  if (!request) throw new Error("AGENT_STATUS_UNAVAILABLE");
  return waitForBoundedCleanup(request);
}

function syntheticSuperseded(status: Exclude<ResearchStatus, { phase: "idle" }>): ResearchStatus {
  return {
    phase: "superseded",
    researchTaskId: status.researchTaskId,
    agentRunId: status.agentRunId,
    operationId: status.operationId,
    reconciliationState: "active",
    startedAt: status.startedAt,
    updatedAt: new Date().toISOString(),
    errorCode: "DISCLOSURE_CONTEXT_CHANGED",
  };
}

function isUncertainBridgeError(error: unknown): error is LocalAgentBridgeError {
  return error instanceof LocalAgentBridgeError
    && (error.code === "BRIDGE_UNAVAILABLE" || error.code === "AGENT_TRANSPORT_UNAVAILABLE");
}

export function DecisionAgentPanel({ repository, bridge, trip, workspace, onResearchCompleted, newIdempotencyKey }: Props) {
  const tripProjectionKey = JSON.stringify(tripProjection(trip));
  const tripSafetyKey = JSON.stringify({ tripId: trip.id, projection: JSON.parse(tripProjectionKey) });
  const safeTripProjection = useMemo(
    () => JSON.parse(tripProjectionKey) as ReturnType<typeof tripProjection>,
    [tripProjectionKey],
  );
  const scopes = useMemo(() => buildResearchTargetScopes(safeTripProjection), [safeTripProjection]);
  const [targetScopeId, setTargetScopeId] = useState<string | undefined>(() => scopes.length === 1 ? scopes[0]?.targetScopeId : undefined);
  const [category, setCategory] = useState<CandidateCategory>();
  const [prepared, setPrepared] = useState<PreparedAgentRun>();
  const [disclosure, setDisclosure] = useState<ResearchDisclosure>();
  const [disclosureFingerprint, setDisclosureFingerprint] = useState<string>();
  const [confirmed, setConfirmed] = useState(false);
  const [operation, setOperation] = useState<Operation>(bridge ? "restoring" : "idle");
  const [operationError, setOperationError] = useState<string>();
  const [researchStatus, setResearchStatusState] = useState<ResearchStatus>({ phase: "idle" });
  const [bridgeStatusReady, setBridgeStatusReady] = useState(false);
  const [cloudCleanupRequired, setCloudCleanupRequired] = useState(false);
  const [blockedCleanupTaskId, setBlockedCleanupTaskId] = useState<string>();
  const [tripCleanupRequired, setTripCleanupRequired] = useState(false);
  const lifecycleRef = useRef(0);
  const operationGenerationRef = useRef(0);
  const operationAbortRef = useRef<AbortController | undefined>(undefined);
  const tripCleanupAbortRef = useRef<AbortController | undefined>(undefined);
  const inFlightRef = useRef(false);
  const statusRef = useRef<ResearchStatus>({ phase: "idle" });
  const lastBridgeObservedStatusRef = useRef<ResearchStatus | undefined>(undefined);
  const ownedResearchIdentityRef = useRef<ResearchOperationIdentity | undefined>(undefined);
  const taskFingerprintRef = useRef<string | undefined>(undefined);
  const confirmedFingerprintRef = useRef<string | undefined>(undefined);
  const disclosureRequestRef = useRef(0);
  const pendingAttemptRef = useRef<PendingCloudAttempt | undefined>(undefined);
  const attachedCloudRunRef = useRef<AttachedCloudRun | undefined>(undefined);
  const completedTaskRef = useRef<string | undefined>(undefined);
  const pendingCancellationRef = useRef<string | undefined>(undefined);
  const finalizingCancellationRef = useRef(false);
  const externallyInvalidatedTaskRef = useRef<{ agentRunId: string; researchTaskId: string } | undefined>(undefined);
  const lifecycleContextRef = useRef<LifecycleContext | undefined>(undefined);
  const tripCleanupTransitionRef = useRef<TripCleanupTransition | undefined>(undefined);
  const blockedCleanupAttemptRef = useRef<PendingCloudAttempt | undefined>(undefined);
  const retryRef = useRef<HTMLButtonElement>(null);
  const researchTaskId = researchStatus.phase === "idle" ? undefined : researchStatus.researchTaskId;

  function setResearchStatus(next: ResearchStatus) {
    statusRef.current = next;
    setResearchStatusState(next);
  }

  function observeBridgeStatus(next: ResearchStatus) {
    lastBridgeObservedStatusRef.current = { ...next } as ResearchStatus;
  }

  function applyBridgeStatus(next: ResearchStatus) {
    observeBridgeStatus(next);
    if (bridgeSelfRevokedPhases.has(next.phase)) {
      attachedCloudRunRef.current = undefined;
      externallyInvalidatedTaskRef.current = undefined;
      setCloudCleanupRequired(false);
    } else if (next.phase === "failed" && attachedCloudRunRef.current) {
      setCloudCleanupRequired(true);
    }
    setResearchStatus(next);
  }

  function beginOperation(next: Operation) {
    operationAbortRef.current?.abort();
    const controller = new AbortController();
    operationAbortRef.current = controller;
    operationGenerationRef.current += 1;
    setOperation(next);
    setOperationError(undefined);
    return { controller, generation: operationGenerationRef.current, lifecycle: lifecycleRef.current };
  }

  function isCurrent(generation: number, lifecycle: number) {
    return operationGenerationRef.current === generation && lifecycleRef.current === lifecycle;
  }

  const clearPendingAttempt = useCallback((attempt: PendingCloudAttempt) => {
    if (pendingAttemptRef.current === attempt) pendingAttemptRef.current = undefined;
  }, []);

  const attachCloudRun = useCallback((attempt: PendingCloudAttempt, status: ResearchStatus) => {
    const request = attempt.bridgeRequest;
    if (!attempt.agentRunId || !attempt.revokeIdempotencyKey || !request || status.phase === "idle"
      || status.agentRunId !== attempt.agentRunId || status.operationId !== request.input.operationId
      || (request.operation === "resume" && status.researchTaskId !== request.input.researchTaskId)) {
      throw new Error("AGENT_RUN_NOT_READY");
    }
    attachedCloudRunRef.current = {
      repository: attempt.repository,
      tripId: attempt.tripId,
      agentRunId: attempt.agentRunId,
      revokeIdempotencyKey: attempt.revokeIdempotencyKey,
      researchTaskId: status.researchTaskId,
      operationId: status.operationId,
    };
    ownedResearchIdentityRef.current = {
      researchTaskId: status.researchTaskId,
      agentRunId: status.agentRunId,
      operationId: status.operationId,
    };
    setCloudCleanupRequired(false);
    clearPendingAttempt(attempt);
  }, [clearPendingAttempt]);

  const ensureCloudRun = useCallback(async (attempt: PendingCloudAttempt): Promise<string> => {
    if (attempt.agentRunId) return attempt.agentRunId;
    if (!attempt.createPromise) {
      attempt.createPromise = (async () => {
        const input: CreateAgentRunCommand = {
          action: "createAgentRun",
          tripId: attempt.tripId,
          publicKeyJwk: attempt.material.publicKeyJwk,
          pairingCodeHash: attempt.material.pairingCodeHash,
          scope: ["submitProposalBatch"],
          idempotencyKey: attempt.createIdempotencyKey,
        };
        const result = await attempt.repository.command(input);
        if (!result.ok) {
          attempt.createDefinitivelyFailed = true;
          throw new Error(result.error);
        }
        if (result.action !== "createAgentRun") throw new Error("INVALID_RESPONSE");
        attempt.agentRunId = result.data.agentRunId;
        attempt.revokeIdempotencyKey ??= attempt.newIdempotencyKey();
        return result.data.agentRunId;
      })();
    }
    try {
      return await attempt.createPromise;
    } finally {
      attempt.createPromise = undefined;
    }
  }, []);

  const claimPendingAttempt = useCallback(async (attempt: PendingCloudAttempt, signal: AbortSignal) => {
    if (!attempt.agentRunId) throw new Error("AGENT_RUN_NOT_READY");
    if (attempt.claimState === "confirmed") return;
    for (let replay = 0; replay < 2; replay += 1) {
      try {
        await attempt.bridge.claim(attempt.agentRunId, { signal });
        attempt.claimState = "confirmed";
        return;
      } catch (error) {
        if (isUncertainBridgeError(error)) {
          attempt.claimState = "uncertain";
          if (replay === 0 && !signal.aborted) continue;
        } else {
          attempt.claimState = "notStarted";
        }
        throw error;
      }
    }
  }, []);

  const reconcileCloudAttempt = useCallback(async (attempt: PendingCloudAttempt): Promise<boolean> => {
    if (!attempt.reconcilePromise) {
      const reconciliation = (async () => {
        let agentRunId = attempt.agentRunId;
        if (!agentRunId && attempt.createPromise) agentRunId = await attempt.createPromise;
        if (!agentRunId && attempt.createDefinitivelyFailed) {
          clearPendingAttempt(attempt);
          return true;
        }
        if (!agentRunId) agentRunId = await ensureCloudRun(attempt);
        const latest = await loadAgentRunStatus(attempt.repository, attempt.tripId, agentRunId);
        if (latest.status === "revoked" || latest.status === "expired") {
          clearPendingAttempt(attempt);
          return true;
        }
        attempt.revokeIdempotencyKey ??= attempt.newIdempotencyKey();
        const result = await attempt.repository.command({
          action: "revokeAgentRun",
          tripId: attempt.tripId,
          agentRunId,
          expectedRevision: latest.revision,
          idempotencyKey: attempt.revokeIdempotencyKey,
        });
        if (!result.ok || result.action !== "revokeAgentRun") throw new Error(result.ok ? "INVALID_RESPONSE" : result.error);
        clearPendingAttempt(attempt);
        return true;
      })();
      attempt.reconcilePromise = reconciliation;
      void reconciliation.then(
        () => { if (attempt.reconcilePromise === reconciliation) attempt.reconcilePromise = undefined; },
        () => { if (attempt.reconcilePromise === reconciliation) attempt.reconcilePromise = undefined; },
      );
    }
    return waitForBoundedCleanup(attempt.reconcilePromise);
  }, [clearPendingAttempt, ensureCloudRun]);

  const replayPendingBridgeOperation = useCallback(async (
    attempt: PendingCloudAttempt,
    signal: AbortSignal,
  ): Promise<PendingBridgeReplay> => {
    const request = attempt.bridgeRequest;
    if (!request) return { kind: "definitive" };
    try {
      const next = request.operation === "execute"
        ? await attempt.bridge.executeTravelResearch(request.input, { signal })
        : await attempt.bridge.resumeTravelResearch(request.input, { signal });
      if (next.phase === "idle"
        || next.agentRunId !== request.input.agentRunId
        || next.operationId !== request.input.operationId
        || (request.operation === "resume" && next.researchTaskId !== request.input.researchTaskId)) {
        return { kind: "uncertain" };
      }
      return { kind: "attached", status: next };
    } catch (error) {
      return error instanceof LocalAgentBridgeError && !isUncertainBridgeError(error)
        ? { kind: "definitive" }
        : { kind: "uncertain" };
    }
  }, []);

  const settlePendingAttempt = useCallback(async (attempt: PendingCloudAttempt): Promise<PendingAttemptSettlement> => {
    if (attempt.settlementPromise) return attempt.settlementPromise;
    attempt.settlementPromise = (async () => {
      if (attempt.stage === "bridgeOperationStarted") {
        const request = attempt.bridgeRequest;
        if (!request) return { kind: "uncertain" };
        try {
          const observed = await readResearchStatusForCleanup(attempt.bridge);
          if (observed.phase !== "idle"
            && observed.agentRunId === request.input.agentRunId
            && observed.operationId === request.input.operationId
            && (request.operation !== "resume" || observed.researchTaskId === request.input.researchTaskId)) {
            clearPendingAttempt(attempt);
            return { kind: "attached", status: observed };
          }
        } catch { /* A replay below distinguishes a rejected operation from a still-uncertain one. */ }
        let replay: PendingBridgeReplay;
        try {
          replay = await runBoundedCleanupCall((signal) => replayPendingBridgeOperation(attempt, signal));
        } catch {
          return { kind: "uncertain" };
        }
        if (replay.kind === "attached") {
          clearPendingAttempt(attempt);
          return replay;
        }
        if (replay.kind === "uncertain") return replay;
      }
      try {
        return await reconcileCloudAttempt(attempt)
          ? { kind: "cleaned" }
          : { kind: "uncertain" };
      } catch {
        return { kind: "uncertain" };
      }
    })();
    try {
      return await attempt.settlementPromise;
    } finally {
      attempt.settlementPromise = undefined;
    }
  }, [clearPendingAttempt, reconcileCloudAttempt, replayPendingBridgeOperation]);

  const settlePendingAfterLifecycle = useCallback((attempt: PendingCloudAttempt) => {
    globalThis.queueMicrotask(() => {
      if (tripCleanupTransitionRef.current?.pending === attempt || blockedCleanupAttemptRef.current === attempt) return;
      void settlePendingAttempt(attempt).catch(() => undefined);
    });
  }, [settlePendingAttempt]);

  const reconcileAttachedCloudRun = useCallback(async (run: CloudRunHandle): Promise<boolean> => {
    if (!run.reconcilePromise) {
      const reconciliation = (async () => {
        const latest = await loadAgentRunStatus(run.repository, run.tripId, run.agentRunId);
        if (latest.status !== "revoked" && latest.status !== "expired") {
          const result = await run.repository.command({
            action: "revokeAgentRun",
            tripId: run.tripId,
            agentRunId: run.agentRunId,
            expectedRevision: latest.revision,
            idempotencyKey: run.revokeIdempotencyKey,
          });
          if (!result.ok || result.action !== "revokeAgentRun") throw new Error(result.ok ? "INVALID_RESPONSE" : result.error);
        }
        if (attachedCloudRunRef.current === run) {
          attachedCloudRunRef.current = undefined;
          setCloudCleanupRequired(false);
        }
        return true;
      })();
      run.reconcilePromise = reconciliation;
      void reconciliation.then(
        () => { if (run.reconcilePromise === reconciliation) run.reconcilePromise = undefined; },
        () => { if (run.reconcilePromise === reconciliation) run.reconcilePromise = undefined; },
      );
    }
    return waitForBoundedCleanup(run.reconcilePromise);
  }, []);

  function attachedRunForAttempt(attempt: PendingCloudAttempt | undefined): CloudRunHandle | undefined {
    if (!attempt?.agentRunId || !attempt.revokeIdempotencyKey) return undefined;
    return {
      repository: attempt.repository,
      tripId: attempt.tripId,
      agentRunId: attempt.agentRunId,
      revokeIdempotencyKey: attempt.revokeIdempotencyKey,
    };
  }

  async function reconcileTripTransition(transition: TripCleanupTransition): Promise<ResearchStatus | undefined> {
    if (transition.cleanupPromise) return transition.cleanupPromise;
    transition.cleanupPromise = (async () => {
      let observed = transition.status;
      let attached = transition.attached ?? attachedRunForAttempt(transition.pending);
      let cloudAlreadyCleaned = false;
      const cancelAndReadTerminal = async (current: Exclude<ResearchStatus, { phase: "idle" }>) => {
        try {
          await runBoundedCleanupCall((signal) => transition.bridge.cancelResearch({
            researchTaskId: current.researchTaskId,
            agentRunId: current.agentRunId,
            operationId: current.operationId,
          }, { signal }));
        } catch {
          // The independent status read below is authoritative when the cancellation response is lost.
        }
        const reconciled = await readResearchStatusForCleanup(transition.bridge);
        if (reconciled.phase === "idle" || reconciled.researchTaskId !== current.researchTaskId
          || reconciled.agentRunId !== current.agentRunId || reconciled.operationId !== current.operationId
          || !["cancelled", "superseded", "completed", "failed"].includes(reconciled.phase)) {
          throw new Error("OLD_TRIP_CLEANUP_UNCERTAIN");
        }
        return reconciled;
      };

      if (transition.pending?.stage === "bridgeOperationStarted") {
        const settlement = await settlePendingAttempt(transition.pending);
        if (settlement.status) observed = settlement.status;
        if (settlement.kind === "uncertain") throw new Error("PENDING_RUN_UNCERTAIN");
        if (settlement.kind === "attached") {
          attached = attachedRunForAttempt(transition.pending);
        } else {
          cloudAlreadyCleaned = true;
          attached = undefined;
        }
      }

      if (observed.phase !== "idle") {
        observed = await cancelAndReadTerminal(observed);
        if (transition.pending && !cloudAlreadyCleaned) {
          if (!await reconcileCloudAttempt(transition.pending)) throw new Error("RUN_RECONCILIATION_UNCERTAIN");
          cloudAlreadyCleaned = true;
          attached = undefined;
        }
      } else if (transition.pending && transition.pending.stage !== "bridgeOperationStarted") {
        const settlement = await settlePendingAttempt(transition.pending);
        if (settlement.status) observed = settlement.status;
        if (settlement.kind === "uncertain") throw new Error("PENDING_RUN_UNCERTAIN");
        if (settlement.kind === "attached") {
          if (settlement.status.phase === "idle") throw new Error("INVALID_RESEARCH_STATUS");
          attached ??= attachedRunForAttempt(transition.pending);
          observed = await cancelAndReadTerminal(settlement.status);
        } else {
          cloudAlreadyCleaned = true;
          attached = undefined;
        }
      }

      if (observed.phase === "idle") {
        if (attached && !await reconcileAttachedCloudRun(attached)) throw new Error("RUN_RECONCILIATION_UNCERTAIN");
        return observed;
      }
      if (observed.phase === "cancelled" || observed.phase === "superseded" || observed.phase === "completed") {
        return observed;
      }
      if (observed.phase === "failed") {
        if (attached) {
          if (!await reconcileAttachedCloudRun(attached)) throw new Error("RUN_RECONCILIATION_UNCERTAIN");
        } else if (!cloudAlreadyCleaned) {
          throw new Error("RUN_RECONCILIATION_UNCERTAIN");
        }
        return observed;
      }
      throw new Error("OLD_TRIP_CLEANUP_UNCERTAIN");
    })();
    try {
      return await transition.cleanupPromise;
    } finally {
      transition.cleanupPromise = undefined;
    }
  }

  const reconcileAfterBridgeFailure = useCallback(async (
    attempt: PendingCloudAttempt,
    signal: AbortSignal,
  ): Promise<BridgeFailureReconciliation> => {
    if (attempt.stage === "bridgeOperationStarted") {
      const replay = await replayPendingBridgeOperation(attempt, signal);
      if (replay.kind === "attached") return { kind: "restored", status: replay.status };
      if (replay.kind === "uncertain") return replay;
      try {
        return await reconcileCloudAttempt(attempt) ? { kind: "cleaned" } : { kind: "uncertain" };
      } catch {
        return { kind: "uncertain" };
      }
    }
    let status: ResearchStatus | undefined;
    try {
      status = await attempt.bridge.getResearchStatus({ signal });
    } catch { /* Claim reconciliation still proceeds through the public run. */ }
    try {
      return await reconcileCloudAttempt(attempt) ? { kind: "cleaned", status } : { kind: "uncertain", status };
    } catch {
      return { kind: "uncertain", status };
    }
  }, [reconcileCloudAttempt, replayPendingBridgeOperation]);

  const cleanupAfterDefinitiveBridgeFailure = useCallback(async (
    attempt: PendingCloudAttempt,
  ): Promise<BridgeFailureReconciliation> => {
    try {
      return await reconcileCloudAttempt(attempt) ? { kind: "cleaned" } : { kind: "uncertain" };
    } catch {
      return { kind: "uncertain" };
    }
  }, [reconcileCloudAttempt]);

  async function initializeLifecycle(
    lifecycle: number,
    controller: AbortController,
    targetBridge: LocalAgentBridge | undefined,
    initialTargetScopeId: string | undefined,
    clearOldResources: boolean,
    clearedResearchTaskId?: string,
  ) {
    if (controller.signal.aborted || lifecycleRef.current !== lifecycle) return;
    if (clearOldResources) {
      pendingAttemptRef.current = undefined;
      attachedCloudRunRef.current = undefined;
      blockedCleanupAttemptRef.current = undefined;
      ownedResearchIdentityRef.current = undefined;
    }
    taskFingerprintRef.current = undefined;
    confirmedFingerprintRef.current = undefined;
    pendingCancellationRef.current = undefined;
    finalizingCancellationRef.current = false;
    lastBridgeObservedStatusRef.current = undefined;
    setBlockedCleanupTaskId(undefined);
    externallyInvalidatedTaskRef.current = undefined;
    setCloudCleanupRequired(false);
    setTripCleanupRequired(false);
    setTargetScopeId(initialTargetScopeId);
    setCategory(undefined);
    setPrepared(undefined);
    setConfirmed(false);
    setResearchStatus({ phase: "idle" });
    setOperation(targetBridge ? "restoring" : "idle");
    setOperationError(undefined);
    if (!targetBridge) return;
    try {
      const next = await targetBridge.getResearchStatus({ signal: controller.signal });
      if (controller.signal.aborted || lifecycleRef.current !== lifecycle) return;
      if (clearOldResources && next.phase !== "idle" && next.researchTaskId === clearedResearchTaskId) {
        setBridgeStatusReady(true);
        setOperation("idle");
        return;
      }
      applyBridgeStatus(next);
      setBridgeStatusReady(true);
      setOperation("idle");
    } catch {
      if (controller.signal.aborted || lifecycleRef.current !== lifecycle) return;
      setBridgeStatusReady(false);
      setOperation("error");
      setOperationError("本机 Bridge 状态暂时无法读取，共同决定仍可正常使用。");
    }
  }

  async function finishTripTransition(transition: TripCleanupTransition, controller: AbortController) {
    const terminal = await reconcileTripTransition(transition);
    if (controller.signal.aborted || lifecycleRef.current !== transition.lifecycle
      || tripCleanupTransitionRef.current !== transition) return;
    if (terminal && terminal.phase !== "idle") {
      if (terminal.phase === "completed") {
        completedTaskRef.current = terminal.researchTaskId;
        applyBridgeStatus(terminal);
        void onResearchCompleted();
      } else {
        applyBridgeStatus(terminal);
      }
    }
    tripCleanupTransitionRef.current = undefined;
    await initializeLifecycle(
      transition.lifecycle,
      controller,
      transition.targetBridge,
      transition.targetScopeId,
      true,
      terminal?.phase === "idle" ? undefined : terminal?.researchTaskId,
    );
    if (tripCleanupAbortRef.current === controller) tripCleanupAbortRef.current = undefined;
  }

  const finishTripTransitionRef = useRef(finishTripTransition);
  useEffect(() => {
    finishTripTransitionRef.current = finishTripTransition;
  });

  useEffect(() => {
    let active = true;
    const request = disclosureRequestRef.current + 1;
    disclosureRequestRef.current = request;
    setDisclosure(undefined);
    setDisclosureFingerprint(undefined);
    if (!category || !targetScopeId) return () => { active = false; };
    void buildResearchDisclosure({ workspace, trip: safeTripProjection }, { category, targetScopeId })
      .then(async (next) => ({ next, fingerprint: await computeDisclosureFingerprint(next) }))
      .then(({ next, fingerprint }) => {
        if (!active || disclosureRequestRef.current !== request) return;
        setDisclosure(next);
        setDisclosureFingerprint(fingerprint);
        if (confirmedFingerprintRef.current && confirmedFingerprintRef.current !== fingerprint) {
          confirmedFingerprintRef.current = undefined;
          setConfirmed(false);
          setPrepared(undefined);
        }
        if (tripCleanupTransitionRef.current) return;
        if (statusRef.current.phase === "needs_owner_action" && taskFingerprintRef.current
          && taskFingerprintRef.current !== fingerprint) {
          blockedCleanupAttemptRef.current = pendingAttemptRef.current;
          operationAbortRef.current?.abort();
          operationGenerationRef.current += 1;
          inFlightRef.current = false;
          setBlockedCleanupTaskId(statusRef.current.researchTaskId);
          setResearchStatus(syntheticSuperseded(statusRef.current));
          setOperation("idle");
          setOperationError(undefined);
        }
      })
      .catch(() => {
        if (!active || disclosureRequestRef.current !== request) return;
        setOperation("error");
        setOperationError("当前行程段无法生成安全披露，请刷新行程后重试。");
      });
    return () => { active = false; };
  }, [category, safeTripProjection, targetScopeId, workspace]);

  useEffect(() => {
    const activeTransition = tripCleanupTransitionRef.current;
    if (activeTransition) {
      lifecycleContextRef.current = { tripSafetyKey, bridge, repository };
      activeTransition.targetTripSafetyKey = tripSafetyKey;
      activeTransition.targetBridge = bridge;
      activeTransition.targetRepository = repository;
      activeTransition.targetScopeId = scopes.length === 1 ? scopes[0]?.targetScopeId : undefined;
      setBridgeStatusReady(false);
      setTripCleanupRequired(true);
      return;
    }
    const previousContext = lifecycleContextRef.current;
    const previousStatus = lastBridgeObservedStatusRef.current ?? statusRef.current;
    const previousPending = pendingAttemptRef.current;
    const previousAttached = attachedCloudRunRef.current;
    const previousOwned = ownedResearchIdentityRef.current;
    const sourceContextChanged = Boolean(previousContext && (
      previousContext.tripSafetyKey !== tripSafetyKey
      || previousContext.bridge !== bridge
      || previousContext.repository !== repository
    ));
    lifecycleContextRef.current = { tripSafetyKey, bridge, repository };
    lifecycleRef.current += 1;
    const lifecycle = lifecycleRef.current;
    operationAbortRef.current?.abort();
    tripCleanupAbortRef.current?.abort();
    operationGenerationRef.current += 1;
    inFlightRef.current = false;
    setBridgeStatusReady(false);
    setOperationError(undefined);
    const controller = new AbortController();
    const tripChanged = previousContext?.tripSafetyKey !== tripSafetyKey;
    const ownsPreviousStatus = previousStatus.phase !== "idle"
      && previousOwned?.researchTaskId === previousStatus.researchTaskId
      && previousOwned.agentRunId === previousStatus.agentRunId
      && previousOwned.operationId === previousStatus.operationId;
    const previousContextNeedsCleanup = Boolean(previousPending || previousAttached)
      || Boolean(tripChanged && ownsPreviousStatus
        && (activePhases.has(previousStatus.phase) || previousStatus.phase === "needs_owner_action"));
    if (sourceContextChanged && previousContext?.bridge && previousContextNeedsCleanup) {
      tripCleanupAbortRef.current = controller;
      const transition: TripCleanupTransition = {
        lifecycle,
        controller,
        sourceTripSafetyKey: previousContext.tripSafetyKey,
        bridge: previousContext.bridge,
        repository: previousContext.repository,
        status: previousStatus,
        pending: previousPending,
        attached: previousAttached,
        targetTripSafetyKey: tripSafetyKey,
        targetBridge: bridge,
        targetRepository: repository,
        targetScopeId: scopes.length === 1 ? scopes[0]?.targetScopeId : undefined,
      };
      tripCleanupTransitionRef.current = transition;
      setTripCleanupRequired(true);
      setOperation("cancelling");
      inFlightRef.current = true;
      void finishTripTransitionRef.current(transition, controller).catch(() => {
        if (controller.signal.aborted || lifecycleRef.current !== lifecycle
          || tripCleanupTransitionRef.current !== transition) return;
        setOperation("error");
        setOperationError("旧行程的本机研究清理尚未确认；完成对账前不会创建新任务。");
      }).finally(() => {
        if (!controller.signal.aborted && lifecycleRef.current === lifecycle) inFlightRef.current = false;
      });
    } else {
      operationAbortRef.current = controller;
      tripCleanupTransitionRef.current = undefined;
      setTripCleanupRequired(false);
      void initializeLifecycle(
        lifecycle,
        controller,
        bridge,
        scopes.length === 1 ? scopes[0]?.targetScopeId : undefined,
        false,
      );
    }
    return () => {
      if (tripCleanupTransitionRef.current) return;
      controller.abort();
      operationAbortRef.current?.abort();
      tripCleanupAbortRef.current?.abort();
      lifecycleRef.current += 1;
      operationGenerationRef.current += 1;
      inFlightRef.current = false;
      const pending = pendingAttemptRef.current;
      if (pending) settlePendingAfterLifecycle(pending);
    };
  }, [bridge, repository, scopes, settlePendingAfterLifecycle, tripSafetyKey]);

  useEffect(() => () => {
    tripCleanupTransitionRef.current?.controller.abort();
    operationAbortRef.current?.abort();
    tripCleanupAbortRef.current?.abort();
    lifecycleRef.current += 1;
    operationGenerationRef.current += 1;
    inFlightRef.current = false;
  }, []);

  useEffect(() => {
    if (!bridge || !bridgeStatusReady || !activePhases.has(researchStatus.phase)) return;
    const controller = new AbortController();
    const lifecycle = lifecycleRef.current;
    let timer: number | undefined;
    const schedule = () => {
      timer = globalThis.setTimeout(() => { void poll(); }, pollDelayMs);
    };
    const poll = async () => {
      try {
        const attached = attachedCloudRunRef.current;
        if (attached) {
          const latest = await readAgentRunStatus(attached, attached.repository, attached.tripId, attached.agentRunId);
          if (controller.signal.aborted || lifecycleRef.current !== lifecycle) return;
          if (latest.status === "revoked" || latest.status === "expired") {
            let localAfterCloudRevocation: ResearchStatus | undefined;
            try {
              localAfterCloudRevocation = await bridge.getResearchStatus({ signal: controller.signal });
              if (controller.signal.aborted || lifecycleRef.current !== lifecycle) return;
            } catch {
              if (controller.signal.aborted || lifecycleRef.current !== lifecycle) return;
              throw new Error("LOCAL_RESEARCH_STATUS_UNCERTAIN");
            }
            const localTaskId = localAfterCloudRevocation?.phase === "idle"
              ? undefined
              : localAfterCloudRevocation?.researchTaskId;
            const localMatchesAttached = localAfterCloudRevocation?.phase !== "idle"
              && localTaskId === attached.researchTaskId
              && localAfterCloudRevocation.agentRunId === attached.agentRunId
              && localAfterCloudRevocation.operationId === attached.operationId;
            if (!localMatchesAttached) {
              if (attachedCloudRunRef.current === attached) attachedCloudRunRef.current = undefined;
              setCloudCleanupRequired(false);
              if (localAfterCloudRevocation) applyBridgeStatus(localAfterCloudRevocation);
              if (localAfterCloudRevocation && activePhases.has(localAfterCloudRevocation.phase)) {
                setOperation("error");
                setOperationError("旧云端授权已与当前本机任务隔离；正在继续安全对账。");
                schedule();
              } else {
                setOperation("idle");
                setOperationError(undefined);
              }
              return;
            }
            if (localAfterCloudRevocation && cloudRevokedSafePhases.has(localAfterCloudRevocation.phase)) {
              if (attachedCloudRunRef.current === attached) attachedCloudRunRef.current = undefined;
              applyBridgeStatus(localAfterCloudRevocation);
              setOperation("idle");
              setOperationError(undefined);
              return;
            }
            if (!localAfterCloudRevocation || !activePhases.has(localAfterCloudRevocation.phase)
              || !("researchTaskId" in localAfterCloudRevocation)) {
              throw new Error("LOCAL_RESEARCH_STATUS_UNCERTAIN");
            }
            const current = localAfterCloudRevocation;
            if (current.reconciliationState === "self_revoke_reconciling") {
              applyBridgeStatus(current);
              setOperation("error");
              setOperationError("云端授权已撤销，本机正在完成安全暂停；正在继续对账。");
              schedule();
              return;
            }
            if (attachedCloudRunRef.current === attached) attachedCloudRunRef.current = undefined;
            setCloudCleanupRequired(false);
            const existingInvalidation = externallyInvalidatedTaskRef.current;
            if (!existingInvalidation || existingInvalidation.agentRunId !== attached.agentRunId) {
              externallyInvalidatedTaskRef.current = { agentRunId: attached.agentRunId, researchTaskId: current.researchTaskId };
              try {
                const cancellation = await bridge.cancelResearch({
                  researchTaskId: current.researchTaskId,
                  agentRunId: current.agentRunId,
                  operationId: current.operationId,
                }, { signal: controller.signal });
                if (controller.signal.aborted || lifecycleRef.current !== lifecycle) return;
                observeBridgeStatus(cancellation);
              } catch {
                if (controller.signal.aborted || lifecycleRef.current !== lifecycle) return;
              }
            }
          }
        }
        const next = await bridge.getResearchStatus({ signal: controller.signal });
        if (controller.signal.aborted || lifecycleRef.current !== lifecycle) return;
        const externalInvalidation = externallyInvalidatedTaskRef.current;
        applyBridgeStatus(next);
        if (externalInvalidation && next.phase !== "idle" && next.researchTaskId === externalInvalidation.researchTaskId
          && activePhases.has(next.phase)) {
          setOperation("error");
          setOperationError(next.phase === "writing"
            ? "云端授权已失效，但写入结果尚未确认；当前不宣称已停止。"
            : "云端授权已失效，本机停止结果尚未确认，正在继续对账。");
        } else if (externalInvalidation) {
          externallyInvalidatedTaskRef.current = undefined;
          setOperation("idle");
          setOperationError(undefined);
        } else {
          setOperation("idle");
          setOperationError(undefined);
        }
        if (activePhases.has(next.phase)) schedule();
      } catch {
        if (controller.signal.aborted || lifecycleRef.current !== lifecycle) return;
        setOperation("error");
        setOperationError("本机或云端研究状态暂时无法确认，正在继续轮询；不会贸然停止任务。");
        schedule();
      }
    };
    schedule();
    return () => {
      if (timer !== undefined) globalThis.clearTimeout(timer);
      controller.abort();
    };
  }, [bridge, bridgeStatusReady, researchStatus.phase, researchTaskId, tripSafetyKey]);

  useEffect(() => {
    if (researchStatus.phase !== "completed" || completedTaskRef.current === researchStatus.researchTaskId) return;
    completedTaskRef.current = researchStatus.researchTaskId;
    void onResearchCompleted();
  }, [onResearchCompleted, researchStatus]);

  useEffect(() => {
    const pendingTaskId = pendingCancellationRef.current;
    if (!pendingTaskId || researchStatus.phase === "idle" || researchStatus.researchTaskId !== pendingTaskId
      || !["cancelled", "completed", "failed", "superseded"].includes(researchStatus.phase)
      || finalizingCancellationRef.current) return;
    finalizingCancellationRef.current = true;
    const terminalStatus = researchStatus;
    const attempt = pendingAttemptRef.current;
    const attached = attachedCloudRunRef.current;
    const { generation, lifecycle } = beginOperation("cancelling");
    void (async () => {
      try {
        if (attempt && !await reconcileCloudAttempt(attempt)) throw new Error("RUN_RECONCILIATION_UNCERTAIN");
        if (!attempt && attached && !await reconcileAttachedCloudRun(attached)) throw new Error("RUN_RECONCILIATION_UNCERTAIN");
        if (!isCurrent(generation, lifecycle)) return;
        pendingCancellationRef.current = undefined;
        setResearchStatus(terminalStatus);
        setOperation("idle");
      } catch {
        if (!isCurrent(generation, lifecycle)) return;
        setOperation("error");
        setOperationError("本机状态已确认，但云端授权撤销尚未确认。");
      } finally {
        finalizingCancellationRef.current = false;
      }
    })();
  }, [reconcileAttachedCloudRun, reconcileCloudAttempt, researchStatus]);

  useEffect(() => {
    if (operation !== "error" && researchStatus.phase !== "failed" && researchStatus.phase !== "superseded") return;
    const frame = requestAnimationFrame(() => retryRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [operation, researchStatus.phase]);

  useEffect(() => {
    if (researchStatus.phase !== "failed" || !cloudCleanupRequired || operation !== "idle" || inFlightRef.current) return;
    const run = attachedCloudRunRef.current;
    if (!run) {
      setCloudCleanupRequired(false);
      return;
    }
    inFlightRef.current = true;
    const { generation, lifecycle } = beginOperation("cancelling");
    void reconcileAttachedCloudRun(run).then(() => {
      if (!isCurrent(generation, lifecycle)) return;
      setCloudCleanupRequired(false);
      setOperation("idle");
    }).catch(() => {
      if (!isCurrent(generation, lifecycle)) return;
      setOperation("error");
      setOperationError("云端授权撤销尚未确认；再次操作会先继续对账，不会创建新任务。");
    }).finally(() => {
      if (isCurrent(generation, lifecycle)) inFlightRef.current = false;
    });
  }, [cloudCleanupRequired, operation, reconcileAttachedCloudRun, researchStatus.phase]);

  async function restoreBridgeStatus() {
    if (!bridge || tripCleanupRequired || inFlightRef.current) return;
    inFlightRef.current = true;
    const { controller, generation, lifecycle } = beginOperation("restoring");
    try {
      const next = await bridge.getResearchStatus({ signal: controller.signal });
      if (!isCurrent(generation, lifecycle)) return;
      applyBridgeStatus(next);
      setBridgeStatusReady(true);
      setOperation("idle");
    } catch {
      if (!isCurrent(generation, lifecycle) || controller.signal.aborted) return;
      setBridgeStatusReady(false);
      setOperation("error");
      setOperationError("本机 Bridge 状态暂时无法读取，共同决定仍可正常使用。");
    } finally {
      if (isCurrent(generation, lifecycle)) inFlightRef.current = false;
    }
  }

  async function retryTripCleanup() {
    const transition = tripCleanupTransitionRef.current;
    if (!transition || inFlightRef.current) return;
    inFlightRef.current = true;
    setBridgeStatusReady(false);
    operationAbortRef.current?.abort();
    tripCleanupAbortRef.current?.abort();
    const controller = new AbortController();
    transition.controller = controller;
    tripCleanupAbortRef.current = controller;
    operationGenerationRef.current += 1;
    const generation = operationGenerationRef.current;
    const lifecycle = lifecycleRef.current;
    setOperation("cancelling");
    setOperationError(undefined);
    try {
      await finishTripTransition(transition, controller);
    } catch {
      if (!isCurrent(generation, lifecycle) || controller.signal.aborted) return;
      setOperation("error");
      setOperationError("旧行程的本机研究清理尚未确认；完成对账前不会创建新任务。");
    } finally {
      if (isCurrent(generation, lifecycle)) inFlightRef.current = false;
    }
  }

  async function retryCloudCleanup() {
    if (inFlightRef.current) return;
    const attempt = pendingAttemptRef.current;
    const attached = attachedCloudRunRef.current;
    if (!attempt && !attached) {
      setCloudCleanupRequired(false);
      setOperation("idle");
      setOperationError(undefined);
      return;
    }
    inFlightRef.current = true;
    const { controller, generation, lifecycle } = beginOperation("cancelling");
    try {
      const cleaned = attempt
        ? await reconcileCloudAttempt(attempt)
        : await reconcileAttachedCloudRun(attached!);
      if (!cleaned) throw new Error("RUN_RECONCILIATION_UNCERTAIN");
      if (!isCurrent(generation, lifecycle) || controller.signal.aborted) return;
      const cancelledTaskId = pendingCancellationRef.current;
      const observed = lastBridgeObservedStatusRef.current;
      if (cancelledTaskId && observed?.phase === "cancelled" && observed.researchTaskId === cancelledTaskId) {
        applyBridgeStatus(observed);
      }
      pendingCancellationRef.current = undefined;
      setCloudCleanupRequired(false);
      setOperation("idle");
    } catch {
      if (!isCurrent(generation, lifecycle) || controller.signal.aborted) return;
      setCloudCleanupRequired(true);
      setOperation("error");
      setOperationError("云端授权撤销尚未确认；再次操作会复用同一对账与撤销请求。");
    } finally {
      if (isCurrent(generation, lifecycle)) inFlightRef.current = false;
    }
  }

  function resetResearchUi() {
    blockedCleanupAttemptRef.current = undefined;
    taskFingerprintRef.current = undefined;
    confirmedFingerprintRef.current = undefined;
    setPrepared(undefined);
    setConfirmed(false);
    setResearchStatus({ phase: "idle" });
    setOperation("idle");
    setOperationError(undefined);
  }

  async function clearBlockedResearchBeforeReset() {
    if (!bridge || !bridgeStatusReady || inFlightRef.current) return;
    const taskId = blockedCleanupTaskId;
    if (!taskId) {
      resetResearchUi();
      return;
    }
    if (researchStatus.phase === "idle") {
      resetResearchUi();
      return;
    }
    const { agentRunId, operationId } = researchStatus;
    inFlightRef.current = true;
    const { controller, generation, lifecycle } = beginOperation("cancelling");
    try {
      const pending = blockedCleanupAttemptRef.current ?? pendingAttemptRef.current;
      let cloudAlreadyCleaned = false;
      let attached = attachedCloudRunRef.current ?? attachedRunForAttempt(pending);
      try {
        const cancellation = await bridge.cancelResearch({
          researchTaskId: taskId,
          agentRunId,
          operationId,
        }, { signal: controller.signal });
        if (isCurrent(generation, lifecycle)) observeBridgeStatus(cancellation);
      } catch {
        // The authoritative status read below decides whether the persisted blocker was cleared.
      }
      if (!isCurrent(generation, lifecycle)) return;
      const reconciled = await bridge.getResearchStatus({ signal: controller.signal });
      if (!isCurrent(generation, lifecycle)) return;
      observeBridgeStatus(reconciled);
      if (reconciled.phase === "idle" || reconciled.researchTaskId !== taskId
        || reconciled.agentRunId !== agentRunId
        || reconciled.operationId !== operationId) {
        throw new Error("BLOCKED_TASK_CLEANUP_UNCERTAIN");
      }
      if (!["cancelled", "superseded", "completed", "failed"].includes(reconciled.phase)) {
        throw new Error("BLOCKED_TASK_CLEANUP_UNCERTAIN");
      }
      if (pending) {
        if (!await reconcileCloudAttempt(pending)) throw new Error("RUN_RECONCILIATION_UNCERTAIN");
        if (!isCurrent(generation, lifecycle)) return;
        cloudAlreadyCleaned = true;
        attached = undefined;
      }
      if (reconciled.phase === "failed") {
        if (attached) {
          if (!await reconcileAttachedCloudRun(attached)) throw new Error("RUN_RECONCILIATION_UNCERTAIN");
        } else if (!cloudAlreadyCleaned) {
          throw new Error("RUN_RECONCILIATION_UNCERTAIN");
        }
      } else if (reconciled.phase === "completed") {
        completedTaskRef.current = reconciled.researchTaskId;
        applyBridgeStatus(reconciled);
        void onResearchCompleted();
      }
      if (!isCurrent(generation, lifecycle)) return;
      setBlockedCleanupTaskId(undefined);
      resetResearchUi();
    } catch {
      if (!isCurrent(generation, lifecycle) || controller.signal.aborted) return;
      setOperation("error");
      setOperationError("旧任务清理结果尚未确认；请继续对账，确认后才能创建新任务。");
    } finally {
      if (isCurrent(generation, lifecycle)) inFlightRef.current = false;
    }
  }

  async function prepareLocal() {
    if (!bridge || !bridgeStatusReady || cloudCleanupRequired || blockedCleanupTaskId
      || !category || !targetScopeId || !disclosure || !disclosureFingerprint || inFlightRef.current) return;
    inFlightRef.current = true;
    const { controller, generation, lifecycle } = beginOperation("preparing");
    try {
      const next = await bridge.prepare({ signal: controller.signal });
      if (!isCurrent(generation, lifecycle)) return;
      setPrepared(next);
      confirmedFingerprintRef.current = undefined;
      setConfirmed(false);
      setOperation("idle");
    } catch (error) {
      if (!isCurrent(generation, lifecycle) || controller.signal.aborted) return;
      setOperation("error");
      setOperationError(error instanceof LocalAgentBridgeError && error.code === "CODEX_NOT_AUTHENTICATED"
        ? "请在 ChatGPT/Codex 中恢复登录，然后重试准备。"
        : "本机 Codex 暂未就绪，已保存的共同决定不受影响。");
    } finally {
      if (isCurrent(generation, lifecycle)) inFlightRef.current = false;
    }
  }

  async function startResearch() {
    if (!bridge || !bridgeStatusReady || cloudCleanupRequired || blockedCleanupTaskId
      || !prepared || !confirmed || confirmedFingerprintRef.current !== disclosureFingerprint
      || !category || !targetScopeId || !disclosureFingerprint || inFlightRef.current) return;
    inFlightRef.current = true;
    const { controller, generation, lifecycle } = beginOperation("starting");
    let attempt = pendingAttemptRef.current;
    let stage: AttemptStage = "create";
    try {
      if (attempt && (attempt.kind !== "start" || (attempt.agentRunId && attempt.claimState !== "uncertain")
        || attempt.repository !== repository || attempt.bridge !== bridge || attempt.tripId !== trip.id
        || attempt.disclosureFingerprint !== disclosureFingerprint
        || attempt.targetCategory !== category || attempt.targetScopeId !== targetScopeId)) {
        const settlement = await settlePendingAttempt(attempt);
        if (!isCurrent(generation, lifecycle)) return;
        if (settlement.kind === "attached") {
          taskFingerprintRef.current = attempt.disclosureFingerprint;
          confirmedFingerprintRef.current = undefined;
          setPrepared(undefined);
          setConfirmed(false);
          attachCloudRun(attempt, settlement.status);
          applyBridgeStatus(settlement.status);
          setOperation("idle");
          return;
        }
        if (settlement.status) observeBridgeStatus(settlement.status);
        if (settlement.kind === "uncertain") throw new Error("PENDING_RUN_UNCERTAIN");
        confirmedFingerprintRef.current = undefined;
        setPrepared(undefined);
        setConfirmed(false);
        setOperation("idle");
        return;
      }
      if (!attempt) {
        attempt = {
          kind: "start",
          stage: "create",
          claimState: "notStarted",
          repository,
          bridge,
          tripId: trip.id,
          material: prepared,
          createIdempotencyKey: newIdempotencyKey(),
          newIdempotencyKey,
          targetCategory: category,
          targetScopeId,
          disclosureFingerprint,
        };
        pendingAttemptRef.current = attempt;
      }
      const agentRunId = await ensureCloudRun(attempt);
      if (!isCurrent(generation, lifecycle)) {
        settlePendingAfterLifecycle(attempt);
        return;
      }
      stage = "claim";
      attempt = { ...attempt, stage: "claimed" };
      pendingAttemptRef.current = attempt;
      await claimPendingAttempt(attempt, controller.signal);
      if (!isCurrent(generation, lifecycle)) {
        settlePendingAfterLifecycle(attempt);
        return;
      }
      stage = "execute";
      const executeInput: ExecuteTravelResearchInput = {
        agentRunId,
        operationId: attempt.createIdempotencyKey,
        targetCategory: category,
        targetScopeId,
        disclosureFingerprint,
      };
      attempt = {
        ...attempt,
        stage: "bridgeOperationStarted",
        bridgeRequest: { operation: "execute", input: executeInput },
      };
      pendingAttemptRef.current = attempt;
      taskFingerprintRef.current = disclosureFingerprint;
      const next = await attempt.bridge.executeTravelResearch(executeInput, { signal: controller.signal });
      if (!isCurrent(generation, lifecycle)) {
        clearPendingAttempt(attempt);
        return;
      }
      if (next.phase === "idle") throw new LocalAgentBridgeError("INVALID_BRIDGE_RESPONSE");
      confirmedFingerprintRef.current = undefined;
      setPrepared(undefined);
      setConfirmed(false);
      attachCloudRun(attempt, next);
      applyBridgeStatus(next);
      setOperation("idle");
    } catch (error) {
      if (!attempt) {
        if (isCurrent(generation, lifecycle) && !controller.signal.aborted) {
          setOperation("error");
          setOperationError(error instanceof LocalAgentBridgeError && error.code === "CODEX_NOT_AUTHENTICATED"
            ? "请在 ChatGPT/Codex 中恢复登录，然后重试继续研究。"
            : "本机 Codex 暂未就绪，请处理后重试继续研究。");
        }
        return;
      }
      if (!isCurrent(generation, lifecycle) || controller.signal.aborted) {
        settlePendingAfterLifecycle(attempt);
        return;
      }
      if (error instanceof LocalAgentBridgeError && error.code === "DISCLOSURE_CONTEXT_CHANGED") {
        clearPendingAttempt(attempt);
        const current = statusRef.current;
        if (current.phase !== "idle") setResearchStatus(syntheticSuperseded(current));
        confirmedFingerprintRef.current = undefined;
        setConfirmed(false);
        setPrepared(undefined);
        setOperation("idle");
      } else if (stage === "claim" && attempt.claimState === "uncertain" && isUncertainBridgeError(error)) {
        setOperation("error");
        setOperationError("本机 claim 响应尚未确认；重试会继续同一云端授权，不会新建任务。");
      } else if (stage === "create") {
        if (attempt.createDefinitivelyFailed) clearPendingAttempt(attempt);
        setOperation("error");
        setOperationError("云端授权创建响应尚未确认；重试会使用同一幂等请求。");
      } else {
        const responseUncertain = isUncertainBridgeError(error);
        const outcome = responseUncertain
          ? await reconcileAfterBridgeFailure(attempt, controller.signal)
          : await cleanupAfterDefinitiveBridgeFailure(attempt);
        if (!isCurrent(generation, lifecycle)) return;
        if (outcome.kind === "restored") {
          confirmedFingerprintRef.current = undefined;
          setPrepared(undefined);
          setConfirmed(false);
          attachCloudRun(attempt, outcome.status);
          applyBridgeStatus(outcome.status);
          setOperation("idle");
        } else {
          if (outcome.status) observeBridgeStatus(outcome.status);
          if (outcome.kind === "cleaned") {
            confirmedFingerprintRef.current = undefined;
            setPrepared(undefined);
            setConfirmed(false);
          }
          setOperation("error");
          setOperationError(outcome.kind === "cleaned"
            ? responseUncertain
              ? "启动响应未确认，旧云端授权已安全清理；请重新准备。"
              : "本机拒绝了本次启动，新云端授权已安全清理；请重新准备。"
            : "启动与撤销结果尚未确认，重试前会先继续对账。");
        }
      }
    } finally {
      if (isCurrent(generation, lifecycle)) inFlightRef.current = false;
    }
  }

  async function resumeResearch(resumeAction: ResearchResumeAction) {
    if (!bridge || !bridgeStatusReady || cloudCleanupRequired
      || researchStatus.phase !== "needs_owner_action" || inFlightRef.current) return;
    if (taskFingerprintRef.current && disclosureFingerprint && taskFingerprintRef.current !== disclosureFingerprint) {
      blockedCleanupAttemptRef.current = pendingAttemptRef.current;
      setBlockedCleanupTaskId(researchStatus.researchTaskId);
      setResearchStatus(syntheticSuperseded(researchStatus));
      setConfirmed(false);
      setPrepared(undefined);
      return;
    }
    inFlightRef.current = true;
    const blocked = researchStatus;
    const { controller, generation, lifecycle } = beginOperation("resuming");
    let attempt = pendingAttemptRef.current;
    let stage: AttemptStage = "create";
    try {
      if (attempt && (attempt.kind !== "resume" || (attempt.agentRunId && attempt.claimState !== "uncertain")
        || attempt.repository !== repository || attempt.bridge !== bridge || attempt.tripId !== trip.id
        || attempt.researchTaskId !== blocked.researchTaskId || attempt.resumeAction !== resumeAction)) {
        const settlement = await settlePendingAttempt(attempt);
        if (!isCurrent(generation, lifecycle)) return;
        if (settlement.kind === "attached") {
          attachCloudRun(attempt, settlement.status);
          applyBridgeStatus(settlement.status);
          setOperation("idle");
          return;
        }
        if (settlement.status) observeBridgeStatus(settlement.status);
        if (settlement.kind === "uncertain") throw new Error("PENDING_RUN_UNCERTAIN");
        setOperation("error");
        setOperationError("上一个云端授权已安全清理，请再次继续原任务。");
        return;
      }
      if (!attempt) {
        const material = await bridge.prepare({ signal: controller.signal });
        if (!isCurrent(generation, lifecycle)) return;
        attempt = {
          kind: "resume",
          stage: "create",
          claimState: "notStarted",
          repository,
          bridge,
          tripId: trip.id,
          material,
          createIdempotencyKey: newIdempotencyKey(),
          newIdempotencyKey,
          researchTaskId: blocked.researchTaskId,
          resumeAction,
        };
        pendingAttemptRef.current = attempt;
      }
      const agentRunId = await ensureCloudRun(attempt);
      if (!isCurrent(generation, lifecycle)) {
        settlePendingAfterLifecycle(attempt);
        return;
      }
      stage = "claim";
      attempt = { ...attempt, stage: "claimed" };
      pendingAttemptRef.current = attempt;
      await claimPendingAttempt(attempt, controller.signal);
      if (!isCurrent(generation, lifecycle)) {
        settlePendingAfterLifecycle(attempt);
        return;
      }
      stage = "resume";
      const resumeInput: ResumeTravelResearchInput = {
        agentRunId,
        operationId: attempt.createIdempotencyKey,
        researchTaskId: blocked.researchTaskId,
        resumeAction,
      };
      attempt = {
        ...attempt,
        stage: "bridgeOperationStarted",
        bridgeRequest: { operation: "resume", input: resumeInput },
      };
      pendingAttemptRef.current = attempt;
      const next = await attempt.bridge.resumeTravelResearch(resumeInput, { signal: controller.signal });
      if (!isCurrent(generation, lifecycle)) {
        clearPendingAttempt(attempt);
        return;
      }
      if (next.phase === "idle" || next.researchTaskId !== blocked.researchTaskId) {
        throw new Error("INVALID_RESEARCH_STATUS");
      }
      attachCloudRun(attempt, next);
      applyBridgeStatus(next);
      setOperation("idle");
    } catch (error) {
      if (!attempt) {
        if (isCurrent(generation, lifecycle) && !controller.signal.aborted) {
          setOperation("error");
          setOperationError(error instanceof LocalAgentBridgeError && error.code === "CODEX_NOT_AUTHENTICATED"
            ? "请在 ChatGPT/Codex 中恢复登录，然后重试继续研究。"
            : "本机 Codex 暂未就绪，请处理后重试继续研究。");
        }
        return;
      }
      if (!isCurrent(generation, lifecycle) || controller.signal.aborted) {
        settlePendingAfterLifecycle(attempt);
        return;
      }
      if (error instanceof LocalAgentBridgeError && error.code === "DISCLOSURE_CONTEXT_CHANGED") {
        clearPendingAttempt(attempt);
        setResearchStatus(syntheticSuperseded(blocked));
        confirmedFingerprintRef.current = undefined;
        setConfirmed(false);
        setPrepared(undefined);
        setOperation("idle");
      } else if (stage === "claim" && attempt.claimState === "uncertain" && isUncertainBridgeError(error)) {
        setOperation("error");
        setOperationError("本机 claim 响应尚未确认；再次继续会重放同一授权，不会新建任务。");
      } else if (stage === "create") {
        if (attempt.createDefinitivelyFailed) clearPendingAttempt(attempt);
        setOperation("error");
        setOperationError("恢复授权创建响应尚未确认；重试会使用同一幂等请求。");
      } else {
        const responseUncertain = isUncertainBridgeError(error);
        const outcome = responseUncertain
          ? await reconcileAfterBridgeFailure(attempt, controller.signal)
          : await cleanupAfterDefinitiveBridgeFailure(attempt);
        if (!isCurrent(generation, lifecycle)) return;
        if (outcome.kind === "restored") {
          attachCloudRun(attempt, outcome.status);
          applyBridgeStatus(outcome.status);
          setOperation("idle");
        } else {
          if (outcome.status) observeBridgeStatus(outcome.status);
          setOperation("error");
          setOperationError(outcome.kind === "cleaned"
            ? responseUncertain
              ? "恢复响应未确认，新授权已安全清理；可再次继续原任务。"
              : "本机拒绝了本次恢复，新云端授权已安全清理；可再次继续原任务。"
            : "恢复与撤销结果尚未确认，再次继续前会先对账。");
        }
      }
    } finally {
      if (isCurrent(generation, lifecycle)) inFlightRef.current = false;
    }
  }

  async function stopResearch() {
    if (!bridge || researchStatus.phase === "idle" || inFlightRef.current) return;
    const taskId = researchStatus.researchTaskId;
    const attempt = pendingAttemptRef.current;
    const attached = attachedCloudRunRef.current;
    pendingCancellationRef.current = taskId;
    inFlightRef.current = true;
    const { controller, generation, lifecycle } = beginOperation("cancelling");
    try {
      try {
        const cancellation = await bridge.cancelResearch({
          researchTaskId: taskId,
          agentRunId: researchStatus.agentRunId,
          operationId: researchStatus.operationId,
        }, { signal: controller.signal });
        if (isCurrent(generation, lifecycle)) observeBridgeStatus(cancellation);
      } catch {
        // A lost cancellation response is reconciled by the required status read below.
      }
      if (!isCurrent(generation, lifecycle)) {
        if (attempt) await settlePendingAttempt(attempt).catch(() => undefined);
        else if (attached) await reconcileAttachedCloudRun(attached).catch(() => undefined);
        return;
      }
      const reconciled = await bridge.getResearchStatus({ signal: controller.signal });
      if (!isCurrent(generation, lifecycle)) {
        if (attempt) await settlePendingAttempt(attempt).catch(() => undefined);
        else if (attached) await reconcileAttachedCloudRun(attached).catch(() => undefined);
        return;
      }
      observeBridgeStatus(reconciled);
      if (reconciled.phase === "idle" || reconciled.researchTaskId !== taskId) throw new Error("INVALID_RESEARCH_STATUS");
      if (reconciled.agentRunId !== researchStatus.agentRunId || reconciled.operationId !== researchStatus.operationId) {
        throw new Error("INVALID_RESEARCH_STATUS");
      }
      if (reconciled.phase !== "cancelled") {
        setResearchStatus(reconciled);
        setOperation("error");
        setOperationError(reconciled.phase === "writing"
          ? "写入结果尚未确认，正在继续对账；当前不宣称已停止。"
          : "本机停止结果尚未确认，请继续对账。");
        return;
      }
      if (attempt && !await reconcileCloudAttempt(attempt)) throw new Error("RUN_RECONCILIATION_UNCERTAIN");
      if (!attempt && attached && !await reconcileAttachedCloudRun(attached)) throw new Error("RUN_RECONCILIATION_UNCERTAIN");
      if (!isCurrent(generation, lifecycle)) return;
      pendingCancellationRef.current = undefined;
      setResearchStatus(reconciled);
      setOperation("idle");
    } catch {
      if (!isCurrent(generation, lifecycle) || controller.signal.aborted) {
        if (attempt) await settlePendingAttempt(attempt).catch(() => undefined);
        else if (attached) await reconcileAttachedCloudRun(attached).catch(() => undefined);
        return;
      }
      if (attempt || attached) setCloudCleanupRequired(true);
      setOperation("error");
      setOperationError("停止结果尚未确认，不会将本次操作标记为成功。");
    } finally {
      if (isCurrent(generation, lifecycle)) inFlightRef.current = false;
    }
  }

  const operationAllowsRetry = operation === "idle" || operation === "error";
  const locked = !bridgeStatusReady || tripCleanupRequired || cloudCleanupRequired || Boolean(blockedCleanupTaskId)
    || !operationAllowsRetry || activePhases.has(researchStatus.phase) || researchStatus.phase === "needs_owner_action";
  const busy = (operation !== "idle" && operation !== "error") || activePhases.has(researchStatus.phase);
  const presentation = statusPresentation(researchStatus);
  const message = operationError
    ? { text: operationError, role: "alert" as const }
    : operation === "restoring" ? { text: "正在恢复本机 Codex 研究状态…", role: "status" as const }
      : operation === "preparing" ? { text: "正在检查本机 Codex 与隔离环境…", role: "status" as const }
        : operation === "starting" ? { text: "正在请 Codex 搜索候选与可核验来源。", role: "status" as const }
          : operation === "resuming" ? { text: "Codex 正在继续研究。", role: "status" as const }
            : operation === "cancelling" ? { text: "正在停止本机研究、对账并撤销云端授权…", role: "status" as const }
              : presentation;

  return <section className={`decision-agent-panel decision-agent-panel--${researchStatus.phase}`} aria-labelledby="decision-agent-title" aria-busy={busy}>
    <div className="decision-agent-panel__route" aria-hidden="true"><span>TRIP DESK</span><i /><span>LOCAL CODEX</span></div>
    <header className="decision-agent-panel__heading">
      <p>DEVICE OWNER RESEARCH PASS</p>
      <h2 id="decision-agent-title">Codex 旅行研究</h2>
      <span>只使用这台设备已登录的 Codex；项目不提供登录、换号或凭据输入。</span>
    </header>

    <div className="decision-agent-panel__targets">
      <fieldset disabled={locked}>
        <legend>选择行程段</legend>
        {scopes.map((scope) => <label key={scope.targetScopeId}>
          <input type="radio" name="research-segment" value={scope.targetScopeId} checked={targetScopeId === scope.targetScopeId} onChange={() => setTargetScopeId(scope.targetScopeId)} />
          <span><strong>{scope.city}</strong><small>{scope.startDate} 至 {scope.endDate} · {scope.travelerCount} 人</small></span>
        </label>)}
      </fieldset>
      <fieldset disabled={locked}>
        <legend>选择研究类别</legend>
        {categoryOptions.map((option) => <label key={option.value}>
          <input type="radio" name="research-category" value={option.value} checked={category === option.value} onChange={() => setCategory(option.value)} />
          <span><strong>{option.label}</strong><small>{option.description}</small></span>
        </label>)}
      </fieldset>
    </div>

    {disclosure ? <DecisionResearchDisclosure
      disclosure={disclosure}
      confirmed={confirmed}
      disabled={!prepared || locked}
      onConfirmedChange={(next) => {
        confirmedFingerprintRef.current = next ? disclosureFingerprint : undefined;
        setConfirmed(next);
      }}
    /> : null}

    {researchStatus.phase !== "idle" ? <dl className="decision-agent-panel__status-card">
      <div><dt>本机任务</dt><dd>{researchStatus.researchTaskId}</dd></div>
      <div><dt>当前阶段</dt><dd>{statusPhaseLabel(researchStatus)}</dd></div>
    </dl> : null}

    {message.text ? <p className="decision-agent-panel__message" role={message.role}>{message.text}</p> : null}

    <div className="decision-agent-panel__actions">
      {!bridge ? <p>本机 Bridge 未连接，已有共同决定仍可正常使用。</p> : null}
      {bridge && !bridgeStatusReady && !tripCleanupRequired ? <button ref={retryRef} className="control-button control-button--secondary" type="button" disabled={operation === "restoring"} onClick={() => { void restoreBridgeStatus(); }}>重新读取本机状态</button> : null}
      {bridge && researchStatus.phase === "needs_owner_action" ? <>
        <button ref={retryRef} className="control-button control-button--primary" type="button" disabled={!bridgeStatusReady || !operationAllowsRetry} onClick={() => { void resumeResearch(researchStatus.blockedReason === "codex_auth_required" ? "retry_codex_auth" : "skip_blocked_source"); }}>
          {researchStatus.blockedReason === "codex_auth_required" ? "已恢复登录，继续研究" : "跳过该来源并继续"}
        </button>
        <button className="control-button control-button--danger" type="button" disabled={!operationAllowsRetry} onClick={() => { void stopResearch(); }}>停止任务</button>
      </> : null}
      {bridge && activePhases.has(researchStatus.phase) && researchStatus.phase !== "cancelling" ? <button className="control-button control-button--danger" type="button" disabled={!operationAllowsRetry} onClick={() => { void stopResearch(); }}>停止搜索</button> : null}
      {bridge && researchStatus.phase !== "needs_owner_action" && !activePhases.has(researchStatus.phase) ? <>
        {!prepared ? <button className="control-button control-button--secondary" type="button" disabled={locked || !category || !targetScopeId || !disclosure} onClick={() => { void prepareLocal(); }}>准备本机 Codex</button> : null}
        {prepared && category ? <button className="control-button control-button--primary" type="button" disabled={locked || !confirmed || !disclosureFingerprint} onClick={() => { void startResearch(); }}>开始研究{categoryCopy[category]}候选</button> : null}
      </> : null}
      {operation === "error" && tripCleanupRequired ? <button ref={retryRef} className="control-button control-button--secondary" type="button" onClick={() => { void retryTripCleanup(); }}>继续清理旧行程研究</button> : null}
      {operation === "error" && bridgeStatusReady && !tripCleanupRequired && blockedCleanupTaskId ? <button ref={retryRef} className="control-button control-button--secondary" type="button" onClick={() => { void clearBlockedResearchBeforeReset(); }}>继续清理旧任务</button> : null}
      {operation === "error" && bridgeStatusReady && !tripCleanupRequired && cloudCleanupRequired ? <button ref={retryRef} className="control-button control-button--secondary" type="button" onClick={() => {
        void retryCloudCleanup();
      }}>继续撤销云端授权</button> : null}
      {operation === "error" && bridgeStatusReady && !tripCleanupRequired && !blockedCleanupTaskId && !cloudCleanupRequired && researchStatus.phase !== "needs_owner_action" ? <button ref={retryRef} className="control-button control-button--secondary" type="button" onClick={() => {
        setOperation("idle");
        setOperationError(undefined);
      }}>{activePhases.has(researchStatus.phase) ? "继续查看状态" : "返回研究设置"}</button> : null}
      {operation !== "error" && (researchStatus.phase === "failed" || researchStatus.phase === "superseded") ? <button ref={retryRef} className="control-button control-button--secondary" type="button" onClick={() => {
        void clearBlockedResearchBeforeReset();
      }}>重新选择研究范围</button> : null}
    </div>
  </section>;
}
