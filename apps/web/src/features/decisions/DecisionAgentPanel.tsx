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
  type LocalAgentBridge,
  type PreparedAgentRun,
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
type PendingBridgeOperation = "execute" | "resume";
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
  bridgeOperation?: PendingBridgeOperation;
  operationBaseline?: ResearchStatusBaseline;
  createDefinitivelyFailed?: boolean;
};
type AttachedCloudRun = {
  repository: DecisionWorkspaceRepository;
  tripId: string;
  agentRunId: string;
  revokeIdempotencyKey: string;
  reconcilePromise?: Promise<boolean>;
};
type ResearchStatusBaseline = { status: ResearchStatus; snapshot: string };
type LifecycleContext = { tripSafetyKey: string; bridge?: LocalAgentBridge };
type TripCleanupTransition = {
  lifecycle: number;
  bridge: LocalAgentBridge;
  status: ResearchStatus;
  pending?: PendingCloudAttempt;
  attached?: AttachedCloudRun;
  targetBridge?: LocalAgentBridge;
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

function researchStatusSnapshot(status: ResearchStatus): string {
  return JSON.stringify(Object.entries(status).sort(([left], [right]) => left === right ? 0 : left < right ? -1 : 1));
}

function captureResearchStatus(status: ResearchStatus): ResearchStatusBaseline {
  return { status: { ...status } as ResearchStatus, snapshot: researchStatusSnapshot(status) };
}

function hasVerifiedResearchProgress(
  baseline: ResearchStatusBaseline | undefined,
  next: ResearchStatus,
  stage: AttemptStage,
  expectedResearchTaskId?: string,
): boolean {
  if (!baseline || next.phase === "idle" || researchStatusSnapshot(next) === baseline.snapshot) return false;
  if (stage === "resume" && next.researchTaskId !== expectedResearchTaskId) return false;
  if (baseline.status.phase === "idle") return stage === "execute";
  if (stage === "execute" && next.researchTaskId !== baseline.status.researchTaskId) return true;
  if (next.researchTaskId !== baseline.status.researchTaskId) return false;
  if (next.phase !== baseline.status.phase) return true;
  if (next.phase === "needs_owner_action" && baseline.status.phase === "needs_owner_action") {
    return next.blockedReason !== baseline.status.blockedReason
      || ("blockedHostname" in next ? next.blockedHostname : undefined)
        !== ("blockedHostname" in baseline.status ? baseline.status.blockedHostname : undefined);
  }
  if (next.phase === "failed" && baseline.status.phase === "failed") return next.errorCode !== baseline.status.errorCode;
  return false;
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

function syntheticSuperseded(status: Exclude<ResearchStatus, { phase: "idle" }>): ResearchStatus {
  return {
    phase: "superseded",
    researchTaskId: status.researchTaskId,
    startedAt: status.startedAt,
    updatedAt: new Date().toISOString(),
    errorCode: "DISCLOSURE_CONTEXT_CHANGED",
  };
}

export function DecisionAgentPanel({ repository, bridge, trip, workspace, onResearchCompleted, newIdempotencyKey }: Props) {
  const tripSafetyKey = JSON.stringify(tripProjection(trip));
  const safeTripProjection = useMemo(
    () => JSON.parse(tripSafetyKey) as ReturnType<typeof tripProjection>,
    [tripSafetyKey],
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
  const inFlightRef = useRef(false);
  const statusRef = useRef<ResearchStatus>({ phase: "idle" });
  const lastBridgeObservedStatusRef = useRef<ResearchStatus | undefined>(undefined);
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

  const attachCloudRun = useCallback((attempt: PendingCloudAttempt) => {
    if (!attempt.agentRunId || !attempt.revokeIdempotencyKey) throw new Error("AGENT_RUN_NOT_READY");
    attachedCloudRunRef.current = {
      repository: attempt.repository,
      tripId: attempt.tripId,
      agentRunId: attempt.agentRunId,
      revokeIdempotencyKey: attempt.revokeIdempotencyKey,
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

  const reconcileCloudAttempt = useCallback(async (attempt: PendingCloudAttempt): Promise<boolean> => {
    if (attempt.reconcilePromise) return attempt.reconcilePromise;
    attempt.reconcilePromise = (async () => {
      let agentRunId = attempt.agentRunId;
      if (!agentRunId && attempt.createPromise) agentRunId = await attempt.createPromise;
      if (!agentRunId && attempt.createDefinitivelyFailed) {
        clearPendingAttempt(attempt);
        return true;
      }
      if (!agentRunId) agentRunId = await ensureCloudRun(attempt);
      if (!attempt.repository.getAgentRunStatus) throw new Error("AGENT_STATUS_UNAVAILABLE");
      const parsed = AgentRunSchema.safeParse(await attempt.repository.getAgentRunStatus(attempt.tripId, agentRunId));
      if (!parsed.success || parsed.data.tripId !== attempt.tripId || parsed.data.agentRunId !== agentRunId) throw new Error("INVALID_AGENT_RUN_STATUS");
      const latest: AgentRun = parsed.data;
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
    try {
      return await attempt.reconcilePromise;
    } finally {
      attempt.reconcilePromise = undefined;
    }
  }, [clearPendingAttempt, ensureCloudRun]);

  const settlePendingAttempt = useCallback(async (attempt: PendingCloudAttempt): Promise<PendingAttemptSettlement> => {
    if (attempt.settlementPromise) return attempt.settlementPromise;
    attempt.settlementPromise = (async () => {
      let observedStatus: ResearchStatus | undefined;
      if (attempt.stage === "bridgeOperationStarted") {
        try {
          observedStatus = await readResearchStatusForCleanup(attempt.bridge);
        } catch {
          return { kind: "uncertain" };
        }
        const bridgeStage = attempt.bridgeOperation;
        if (bridgeStage && hasVerifiedResearchProgress(
          attempt.operationBaseline,
          observedStatus,
          bridgeStage,
          bridgeStage === "resume" ? attempt.researchTaskId : undefined,
        )) {
          clearPendingAttempt(attempt);
          return { kind: "attached", status: observedStatus };
        }
      }
      try {
        return await reconcileCloudAttempt(attempt)
          ? { kind: "cleaned", status: observedStatus }
          : { kind: "uncertain", status: observedStatus };
      } catch {
        return { kind: "uncertain", status: observedStatus };
      }
    })();
    try {
      return await attempt.settlementPromise;
    } finally {
      attempt.settlementPromise = undefined;
    }
  }, [clearPendingAttempt, reconcileCloudAttempt]);

  const reconcileAttachedCloudRun = useCallback(async (run: AttachedCloudRun): Promise<boolean> => {
    if (run.reconcilePromise) return run.reconcilePromise;
    run.reconcilePromise = (async () => {
      if (!run.repository.getAgentRunStatus) throw new Error("AGENT_STATUS_UNAVAILABLE");
      const parsed = AgentRunSchema.safeParse(await run.repository.getAgentRunStatus(run.tripId, run.agentRunId));
      if (!parsed.success || parsed.data.tripId !== run.tripId || parsed.data.agentRunId !== run.agentRunId) throw new Error("INVALID_AGENT_RUN_STATUS");
      const latest: AgentRun = parsed.data;
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
    try {
      return await run.reconcilePromise;
    } finally {
      run.reconcilePromise = undefined;
    }
  }, []);

  function attachedRunForAttempt(attempt: PendingCloudAttempt | undefined): AttachedCloudRun | undefined {
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
      if (transition.pending) {
        const settlement = await settlePendingAttempt(transition.pending);
        if (settlement.status) observed = settlement.status;
        if (settlement.kind === "uncertain") throw new Error("PENDING_RUN_UNCERTAIN");
        if (settlement.kind === "attached") attached ??= attachedRunForAttempt(transition.pending);
        if (settlement.kind === "cleaned") {
          cloudAlreadyCleaned = true;
          attached = undefined;
        }
      }

      if (observed.phase === "idle") {
        if (attached && !await reconcileAttachedCloudRun(attached)) throw new Error("RUN_RECONCILIATION_UNCERTAIN");
        return observed;
      }

      const taskId = observed.researchTaskId;
      try {
        await runBoundedCleanupCall((signal) => transition.bridge.cancelResearch({ researchTaskId: taskId }, { signal }));
      } catch {
        // The independent status read below is authoritative when the cancellation response is lost.
      }
      const reconciled = await readResearchStatusForCleanup(transition.bridge);
      if (reconciled.phase === "idle" || reconciled.researchTaskId !== taskId) {
        throw new Error("OLD_TRIP_CLEANUP_UNCERTAIN");
      }
      if (reconciled.phase === "cancelled" || reconciled.phase === "superseded" || reconciled.phase === "completed") {
        return reconciled;
      }
      if (reconciled.phase === "failed") {
        if (attached) {
          if (!await reconcileAttachedCloudRun(attached)) throw new Error("RUN_RECONCILIATION_UNCERTAIN");
        } else if (!cloudAlreadyCleaned) {
          throw new Error("RUN_RECONCILIATION_UNCERTAIN");
        }
        return reconciled;
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
    stage: AttemptStage,
    signal: AbortSignal,
    expectedResearchTaskId?: string,
  ): Promise<BridgeFailureReconciliation> => {
    let status: ResearchStatus | undefined;
    try {
      status = await attempt.bridge.getResearchStatus({ signal });
    } catch {
      if (attempt.stage === "bridgeOperationStarted") return { kind: "uncertain" };
    }
    if (status && hasVerifiedResearchProgress(attempt.operationBaseline, status, stage, expectedResearchTaskId)) {
      return { kind: "restored", status };
    }
    try {
      return await reconcileCloudAttempt(attempt) ? { kind: "cleaned", status } : { kind: "uncertain", status };
    } catch {
      return { kind: "uncertain", status };
    }
  }, [reconcileCloudAttempt]);

  async function initializeLifecycle(
    lifecycle: number,
    controller: AbortController,
    targetBridge: LocalAgentBridge | undefined,
    initialTargetScopeId: string | undefined,
    clearOldResources: boolean,
  ) {
    if (controller.signal.aborted || lifecycleRef.current !== lifecycle) return;
    if (clearOldResources) {
      pendingAttemptRef.current = undefined;
      attachedCloudRunRef.current = undefined;
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
    );
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
        if (statusRef.current.phase === "needs_owner_action" && taskFingerprintRef.current
          && taskFingerprintRef.current !== fingerprint) {
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
    const previousContext = lifecycleContextRef.current;
    const previousStatus = lastBridgeObservedStatusRef.current ?? statusRef.current;
    const previousPending = pendingAttemptRef.current;
    const previousAttached = attachedCloudRunRef.current;
    const tripChanged = Boolean(previousContext && previousContext.tripSafetyKey !== tripSafetyKey);
    lifecycleContextRef.current = { tripSafetyKey, bridge };
    lifecycleRef.current += 1;
    const lifecycle = lifecycleRef.current;
    operationAbortRef.current?.abort();
    operationGenerationRef.current += 1;
    inFlightRef.current = false;
    setBridgeStatusReady(false);
    setOperationError(undefined);
    const controller = new AbortController();
    operationAbortRef.current = controller;
    if (tripChanged && previousContext?.bridge
      && (previousStatus.phase !== "idle" || previousPending || previousAttached)) {
      const transition: TripCleanupTransition = {
        lifecycle,
        bridge: previousContext.bridge,
        status: previousStatus,
        pending: previousPending,
        attached: previousAttached,
        targetBridge: bridge,
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
      controller.abort();
      operationAbortRef.current?.abort();
      lifecycleRef.current += 1;
      operationGenerationRef.current += 1;
      inFlightRef.current = false;
      const pending = pendingAttemptRef.current;
      if (pending) void settlePendingAttempt(pending).catch(() => undefined);
    };
  }, [bridge, repository, scopes, settlePendingAttempt, tripSafetyKey]);

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
          if (!attached.repository.getAgentRunStatus) throw new Error("AGENT_STATUS_UNAVAILABLE");
          const parsed = AgentRunSchema.safeParse(await attached.repository.getAgentRunStatus(attached.tripId, attached.agentRunId));
          if (!parsed.success || parsed.data.tripId !== attached.tripId || parsed.data.agentRunId !== attached.agentRunId) {
            throw new Error("INVALID_AGENT_RUN_STATUS");
          }
          if (controller.signal.aborted || lifecycleRef.current !== lifecycle) return;
          if (parsed.data.status === "revoked" || parsed.data.status === "expired") {
            const current = statusRef.current;
            if (current.phase === "idle") return;
            if (attachedCloudRunRef.current === attached) attachedCloudRunRef.current = undefined;
            setCloudCleanupRequired(false);
            const existingInvalidation = externallyInvalidatedTaskRef.current;
            if (!existingInvalidation || existingInvalidation.agentRunId !== attached.agentRunId) {
              externallyInvalidatedTaskRef.current = { agentRunId: attached.agentRunId, researchTaskId: current.researchTaskId };
              try {
                const cancellation = await bridge.cancelResearch({ researchTaskId: current.researchTaskId }, { signal: controller.signal });
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
    const { controller, generation, lifecycle } = beginOperation("cancelling");
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

  function resetResearchUi() {
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
    inFlightRef.current = true;
    const { controller, generation, lifecycle } = beginOperation("cancelling");
    try {
      const pending = pendingAttemptRef.current;
      let cloudAlreadyCleaned = false;
      let attached = attachedCloudRunRef.current ?? attachedRunForAttempt(pending);
      if (pending) {
        const settlement = await settlePendingAttempt(pending);
        if (!isCurrent(generation, lifecycle)) return;
        if (settlement.kind === "uncertain") throw new Error("PENDING_RUN_UNCERTAIN");
        if (settlement.kind === "attached") attached ??= attachedRunForAttempt(pending);
        if (settlement.kind === "cleaned") {
          cloudAlreadyCleaned = true;
          attached = undefined;
        }
      }
      try {
        const cancellation = await bridge.cancelResearch({ researchTaskId: taskId }, { signal: controller.signal });
        if (isCurrent(generation, lifecycle)) observeBridgeStatus(cancellation);
      } catch {
        // The authoritative status read below decides whether the persisted blocker was cleared.
      }
      if (!isCurrent(generation, lifecycle)) return;
      const reconciled = await bridge.getResearchStatus({ signal: controller.signal });
      if (!isCurrent(generation, lifecycle)) return;
      observeBridgeStatus(reconciled);
      if (reconciled.phase === "idle" || reconciled.researchTaskId !== taskId) {
        throw new Error("BLOCKED_TASK_CLEANUP_UNCERTAIN");
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
      } else if (reconciled.phase !== "cancelled" && reconciled.phase !== "superseded") {
        throw new Error("BLOCKED_TASK_CLEANUP_UNCERTAIN");
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
      if (attempt && (attempt.kind !== "start" || attempt.agentRunId
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
          attachCloudRun(attempt);
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
        await settlePendingAttempt(attempt).catch(() => undefined);
        return;
      }
      stage = "claim";
      attempt = { ...attempt, stage: "claimed" };
      pendingAttemptRef.current = attempt;
      await attempt.bridge.claim(agentRunId, { signal: controller.signal });
      if (!isCurrent(generation, lifecycle)) {
        await settlePendingAttempt(attempt).catch(() => undefined);
        return;
      }
      stage = "execute";
      attempt = {
        ...attempt,
        stage: "bridgeOperationStarted",
        bridgeOperation: "execute",
        operationBaseline: lastBridgeObservedStatusRef.current
          ? captureResearchStatus(lastBridgeObservedStatusRef.current)
          : undefined,
      };
      pendingAttemptRef.current = attempt;
      taskFingerprintRef.current = disclosureFingerprint;
      const next = await attempt.bridge.executeTravelResearch({
        agentRunId,
        targetCategory: category,
        targetScopeId,
        disclosureFingerprint,
      }, { signal: controller.signal });
      if (!isCurrent(generation, lifecycle)) {
        clearPendingAttempt(attempt);
        return;
      }
      confirmedFingerprintRef.current = undefined;
      setPrepared(undefined);
      setConfirmed(false);
      attachCloudRun(attempt);
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
        await settlePendingAttempt(attempt).catch(() => undefined);
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
      } else if (stage === "create") {
        if (attempt.createDefinitivelyFailed) clearPendingAttempt(attempt);
        setOperation("error");
        setOperationError("云端授权创建响应尚未确认；重试会使用同一幂等请求。");
      } else {
        const outcome = await reconcileAfterBridgeFailure(attempt, stage, controller.signal);
        if (!isCurrent(generation, lifecycle)) return;
        if (outcome.kind === "restored") {
          confirmedFingerprintRef.current = undefined;
          setPrepared(undefined);
          setConfirmed(false);
          attachCloudRun(attempt);
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
            ? "启动响应未确认，旧云端授权已安全清理；请重新准备。"
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
      if (attempt && (attempt.kind !== "resume" || attempt.agentRunId
        || attempt.repository !== repository || attempt.bridge !== bridge || attempt.tripId !== trip.id
        || attempt.researchTaskId !== blocked.researchTaskId || attempt.resumeAction !== resumeAction)) {
        const settlement = await settlePendingAttempt(attempt);
        if (!isCurrent(generation, lifecycle)) return;
        if (settlement.kind === "attached") {
          attachCloudRun(attempt);
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
        await settlePendingAttempt(attempt).catch(() => undefined);
        return;
      }
      stage = "claim";
      attempt = { ...attempt, stage: "claimed" };
      pendingAttemptRef.current = attempt;
      await attempt.bridge.claim(agentRunId, { signal: controller.signal });
      if (!isCurrent(generation, lifecycle)) {
        await settlePendingAttempt(attempt).catch(() => undefined);
        return;
      }
      stage = "resume";
      attempt = {
        ...attempt,
        stage: "bridgeOperationStarted",
        bridgeOperation: "resume",
        operationBaseline: lastBridgeObservedStatusRef.current
          ? captureResearchStatus(lastBridgeObservedStatusRef.current)
          : undefined,
      };
      pendingAttemptRef.current = attempt;
      const next = await attempt.bridge.resumeTravelResearch({ agentRunId, researchTaskId: blocked.researchTaskId, resumeAction }, { signal: controller.signal });
      if (!isCurrent(generation, lifecycle)) {
        clearPendingAttempt(attempt);
        return;
      }
      if (next.phase === "idle" || next.researchTaskId !== blocked.researchTaskId) {
        throw new Error("INVALID_RESEARCH_STATUS");
      }
      attachCloudRun(attempt);
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
        await settlePendingAttempt(attempt).catch(() => undefined);
        return;
      }
      if (error instanceof LocalAgentBridgeError && error.code === "DISCLOSURE_CONTEXT_CHANGED") {
        clearPendingAttempt(attempt);
        setResearchStatus(syntheticSuperseded(blocked));
        confirmedFingerprintRef.current = undefined;
        setConfirmed(false);
        setPrepared(undefined);
        setOperation("idle");
      } else if (stage === "create") {
        if (attempt.createDefinitivelyFailed) clearPendingAttempt(attempt);
        setOperation("error");
        setOperationError("恢复授权创建响应尚未确认；重试会使用同一幂等请求。");
      } else {
        const outcome = await reconcileAfterBridgeFailure(attempt, stage, controller.signal, blocked.researchTaskId);
        if (!isCurrent(generation, lifecycle)) return;
        if (outcome.kind === "restored") {
          attachCloudRun(attempt);
          applyBridgeStatus(outcome.status);
          setOperation("idle");
        } else {
          if (outcome.status) observeBridgeStatus(outcome.status);
          setOperation("error");
          setOperationError(outcome.kind === "cleaned"
            ? "恢复响应未确认，新授权已安全清理；可再次继续原任务。"
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
        const cancellation = await bridge.cancelResearch({ researchTaskId: taskId }, { signal: controller.signal });
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
      setOperation("error");
      setOperationError("停止结果尚未确认，不会将本次操作标记为成功。");
    } finally {
      if (isCurrent(generation, lifecycle)) inFlightRef.current = false;
    }
  }

  const operationAllowsRetry = operation === "idle" || operation === "error";
  const locked = !bridgeStatusReady || tripCleanupRequired || cloudCleanupRequired || Boolean(blockedCleanupTaskId)
    || !operationAllowsRetry || activePhases.has(researchStatus.phase) || researchStatus.phase === "needs_owner_action";
  const busy = operation !== "idle" || activePhases.has(researchStatus.phase);
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
        setOperation("idle");
        setOperationError(undefined);
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
