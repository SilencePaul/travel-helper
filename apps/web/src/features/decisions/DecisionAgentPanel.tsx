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
type PendingCloudAttempt = {
  kind: "start" | "resume";
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
  bridgeOperationStarted?: boolean;
  createDefinitivelyFailed?: boolean;
};

const categoryOptions: Array<{ value: CandidateCategory; label: string; description: string }> = [
  { value: "hotel", label: "酒店", description: "住宿与房型" },
  { value: "restaurant", label: "餐厅", description: "用餐与营业信息" },
  { value: "attraction", label: "景点", description: "参观与票务" },
];
const categoryCopy: Record<CandidateCategory, string> = { hotel: "酒店", restaurant: "餐厅", attraction: "景点" };
const activePhases = new Set<ResearchStatus["phase"]>(["researching", "resuming", "validating", "writing", "cancelling"]);
const bridgeRevokedPhases = new Set<ResearchStatus["phase"]>(["needs_owner_action", "completed", "failed", "superseded"]);
const pollDelayMs = 2_000;

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
  const scopes = useMemo(() => buildResearchTargetScopes(tripProjection(trip)), [trip]);
  const [targetScopeId, setTargetScopeId] = useState<string | undefined>(() => scopes.length === 1 ? scopes[0]?.targetScopeId : undefined);
  const [category, setCategory] = useState<CandidateCategory>();
  const [prepared, setPrepared] = useState<PreparedAgentRun>();
  const [disclosure, setDisclosure] = useState<ResearchDisclosure>();
  const [disclosureFingerprint, setDisclosureFingerprint] = useState<string>();
  const [confirmed, setConfirmed] = useState(false);
  const [operation, setOperation] = useState<Operation>(bridge ? "restoring" : "idle");
  const [operationError, setOperationError] = useState<string>();
  const [researchStatus, setResearchStatusState] = useState<ResearchStatus>({ phase: "idle" });
  const lifecycleRef = useRef(0);
  const operationGenerationRef = useRef(0);
  const operationAbortRef = useRef<AbortController | undefined>(undefined);
  const inFlightRef = useRef(false);
  const statusRef = useRef<ResearchStatus>({ phase: "idle" });
  const taskFingerprintRef = useRef<string | undefined>(undefined);
  const confirmedFingerprintRef = useRef<string | undefined>(undefined);
  const disclosureRequestRef = useRef(0);
  const pendingAttemptRef = useRef<PendingCloudAttempt | undefined>(undefined);
  const completedTaskRef = useRef<string | undefined>(undefined);
  const pendingCancellationRef = useRef<string | undefined>(undefined);
  const finalizingCancellationRef = useRef(false);
  const retryRef = useRef<HTMLButtonElement>(null);
  const researchTaskId = researchStatus.phase === "idle" ? undefined : researchStatus.researchTaskId;

  function setResearchStatus(next: ResearchStatus) {
    statusRef.current = next;
    const attempt = pendingAttemptRef.current;
    if (bridgeRevokedPhases.has(next.phase) && attempt?.bridgeOperationStarted) pendingAttemptRef.current = undefined;
    setResearchStatusState(next);
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

  const reconcileAfterBridgeFailure = useCallback(async (
    attempt: PendingCloudAttempt,
    stage: AttemptStage,
    expectedResearchTaskId?: string,
  ): Promise<{ kind: "restored"; status: ResearchStatus } | { kind: "cleaned" } | { kind: "uncertain" }> => {
    let status: ResearchStatus | undefined;
    try {
      status = await attempt.bridge.getResearchStatus();
    } catch {
      // Cloud cleanup below is still required when local status cannot be read.
    }
    if (status && status.phase !== "idle" && (
      stage === "execute"
      || (stage === "resume" && status.researchTaskId === expectedResearchTaskId)
    )) return { kind: "restored", status };
    try {
      return await reconcileCloudAttempt(attempt) ? { kind: "cleaned" } : { kind: "uncertain" };
    } catch {
      return { kind: "uncertain" };
    }
  }, [reconcileCloudAttempt]);

  useEffect(() => {
    let active = true;
    const request = disclosureRequestRef.current + 1;
    disclosureRequestRef.current = request;
    setDisclosure(undefined);
    setDisclosureFingerprint(undefined);
    if (!category || !targetScopeId) return () => { active = false; };
    void buildResearchDisclosure({ workspace, trip: tripProjection(trip) }, { category, targetScopeId })
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
  }, [category, targetScopeId, trip, workspace]);

  useEffect(() => {
    lifecycleRef.current += 1;
    const lifecycle = lifecycleRef.current;
    operationAbortRef.current?.abort();
    operationGenerationRef.current += 1;
    inFlightRef.current = false;
    taskFingerprintRef.current = undefined;
    confirmedFingerprintRef.current = undefined;
    completedTaskRef.current = undefined;
    pendingCancellationRef.current = undefined;
    finalizingCancellationRef.current = false;
    setTargetScopeId(scopes.length === 1 ? scopes[0]?.targetScopeId : undefined);
    setCategory(undefined);
    setPrepared(undefined);
    setConfirmed(false);
    setResearchStatus({ phase: "idle" });
    setOperation(bridge ? "restoring" : "idle");
    setOperationError(undefined);
    const controller = new AbortController();
    operationAbortRef.current = controller;
    if (bridge) {
      void bridge.getResearchStatus({ signal: controller.signal }).then((next) => {
        if (controller.signal.aborted || lifecycleRef.current !== lifecycle) return;
        setResearchStatus(next);
        setOperation("idle");
      }).catch(() => {
        if (controller.signal.aborted || lifecycleRef.current !== lifecycle) return;
        setOperation("error");
        setOperationError("本机 Bridge 状态暂时无法读取，共同决定仍可正常使用。");
      });
    }
    return () => {
      controller.abort();
      operationAbortRef.current?.abort();
      lifecycleRef.current += 1;
      operationGenerationRef.current += 1;
      inFlightRef.current = false;
      const pending = pendingAttemptRef.current;
      if (pending) void reconcileCloudAttempt(pending).catch(() => undefined);
    };
  }, [bridge, reconcileCloudAttempt, repository, scopes, tripSafetyKey]);

  useEffect(() => {
    if (!bridge || !activePhases.has(researchStatus.phase)) return;
    const controller = new AbortController();
    const lifecycle = lifecycleRef.current;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const next = await bridge.getResearchStatus({ signal: controller.signal });
        if (controller.signal.aborted || lifecycleRef.current !== lifecycle) return;
        setResearchStatus(next);
        if (activePhases.has(next.phase)) timer = globalThis.setTimeout(() => { void poll(); }, pollDelayMs);
      } catch {
        if (controller.signal.aborted || lifecycleRef.current !== lifecycle) return;
        setOperation("error");
        setOperationError("本机研究状态暂时无法确认，请重试对账。");
        timer = globalThis.setTimeout(() => { void poll(); }, pollDelayMs);
      }
    };
    timer = globalThis.setTimeout(() => { void poll(); }, pollDelayMs);
    return () => {
      if (timer !== undefined) globalThis.clearTimeout(timer);
      controller.abort();
    };
  }, [bridge, researchStatus.phase, researchTaskId, tripSafetyKey]);

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
    const { generation, lifecycle } = beginOperation("cancelling");
    void (async () => {
      try {
        if (attempt && !await reconcileCloudAttempt(attempt)) throw new Error("RUN_RECONCILIATION_UNCERTAIN");
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
  }, [reconcileCloudAttempt, researchStatus]);

  useEffect(() => {
    if (operation !== "error" && researchStatus.phase !== "failed" && researchStatus.phase !== "superseded") return;
    const frame = requestAnimationFrame(() => retryRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [operation, researchStatus.phase]);

  async function prepareLocal() {
    if (!bridge || !category || !targetScopeId || !disclosure || !disclosureFingerprint || inFlightRef.current) return;
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
    if (!bridge || !prepared || !confirmed || confirmedFingerprintRef.current !== disclosureFingerprint
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
        const cleaned = await reconcileCloudAttempt(attempt);
        if (!isCurrent(generation, lifecycle)) return;
        if (!cleaned) throw new Error("PENDING_RUN_UNCERTAIN");
        confirmedFingerprintRef.current = undefined;
        setPrepared(undefined);
        setConfirmed(false);
        setOperation("idle");
        return;
      }
      if (!attempt) {
        attempt = {
          kind: "start",
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
        await reconcileCloudAttempt(attempt).catch(() => undefined);
        return;
      }
      stage = "claim";
      await attempt.bridge.claim(agentRunId, { signal: controller.signal });
      if (!isCurrent(generation, lifecycle)) {
        await reconcileCloudAttempt(attempt).catch(() => undefined);
        return;
      }
      stage = "execute";
      attempt = { ...attempt, bridgeOperationStarted: true };
      pendingAttemptRef.current = attempt;
      taskFingerprintRef.current = disclosureFingerprint;
      const next = await attempt.bridge.executeTravelResearch({
        agentRunId,
        targetCategory: category,
        targetScopeId,
        disclosureFingerprint,
      }, { signal: controller.signal });
      if (!isCurrent(generation, lifecycle)) {
        await reconcileCloudAttempt(attempt).catch(() => undefined);
        return;
      }
      confirmedFingerprintRef.current = undefined;
      setPrepared(undefined);
      setConfirmed(false);
      setResearchStatus(next);
      setOperation("idle");
    } catch (error) {
      if (!attempt) return;
      if (!isCurrent(generation, lifecycle) || controller.signal.aborted) {
        await reconcileCloudAttempt(attempt).catch(() => undefined);
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
        const outcome = await reconcileAfterBridgeFailure(attempt, stage);
        if (!isCurrent(generation, lifecycle)) return;
        if (outcome.kind === "restored") {
          confirmedFingerprintRef.current = undefined;
          setPrepared(undefined);
          setConfirmed(false);
          setResearchStatus(outcome.status);
          setOperation("idle");
        } else {
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
    if (!bridge || researchStatus.phase !== "needs_owner_action" || inFlightRef.current) return;
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
        const cleaned = await reconcileCloudAttempt(attempt);
        if (!isCurrent(generation, lifecycle)) return;
        if (!cleaned) throw new Error("PENDING_RUN_UNCERTAIN");
        setOperation("error");
        setOperationError("上一个云端授权已安全清理，请再次继续原任务。");
        return;
      }
      if (!attempt) {
        const material = await bridge.prepare({ signal: controller.signal });
        if (!isCurrent(generation, lifecycle)) return;
        attempt = {
          kind: "resume",
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
        await reconcileCloudAttempt(attempt).catch(() => undefined);
        return;
      }
      stage = "claim";
      await attempt.bridge.claim(agentRunId, { signal: controller.signal });
      if (!isCurrent(generation, lifecycle)) {
        await reconcileCloudAttempt(attempt).catch(() => undefined);
        return;
      }
      stage = "resume";
      attempt = { ...attempt, bridgeOperationStarted: true };
      pendingAttemptRef.current = attempt;
      const next = await attempt.bridge.resumeTravelResearch({ agentRunId, researchTaskId: blocked.researchTaskId, resumeAction }, { signal: controller.signal });
      if (!isCurrent(generation, lifecycle)) {
        await reconcileCloudAttempt(attempt).catch(() => undefined);
        return;
      }
      setResearchStatus(next);
      setOperation("idle");
    } catch (error) {
      if (!attempt) return;
      if (!isCurrent(generation, lifecycle) || controller.signal.aborted) {
        await reconcileCloudAttempt(attempt).catch(() => undefined);
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
        const outcome = await reconcileAfterBridgeFailure(attempt, stage, blocked.researchTaskId);
        if (!isCurrent(generation, lifecycle)) return;
        if (outcome.kind === "restored") {
          setResearchStatus(outcome.status);
          setOperation("idle");
        } else {
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
    pendingCancellationRef.current = taskId;
    inFlightRef.current = true;
    const { controller, generation, lifecycle } = beginOperation("cancelling");
    try {
      try {
        await bridge.cancelResearch({ researchTaskId: taskId }, { signal: controller.signal });
      } catch {
        // A lost cancellation response is reconciled by the required status read below.
      }
      if (!isCurrent(generation, lifecycle)) {
        if (attempt) await reconcileCloudAttempt(attempt).catch(() => undefined);
        return;
      }
      const reconciled = await bridge.getResearchStatus({ signal: controller.signal });
      if (!isCurrent(generation, lifecycle)) {
        if (attempt) await reconcileCloudAttempt(attempt).catch(() => undefined);
        return;
      }
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
      if (!isCurrent(generation, lifecycle)) return;
      pendingCancellationRef.current = undefined;
      setResearchStatus(reconciled);
      setOperation("idle");
    } catch {
      if (!isCurrent(generation, lifecycle) || controller.signal.aborted) {
        if (attempt) await reconcileCloudAttempt(attempt).catch(() => undefined);
        return;
      }
      setOperation("error");
      setOperationError("停止结果尚未确认，不会将本次操作标记为成功。");
    } finally {
      if (isCurrent(generation, lifecycle)) inFlightRef.current = false;
    }
  }

  const operationAllowsRetry = operation === "idle" || operation === "error";
  const locked = !operationAllowsRetry || activePhases.has(researchStatus.phase) || researchStatus.phase === "needs_owner_action";
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
      {bridge && researchStatus.phase === "needs_owner_action" ? <>
        <button ref={retryRef} className="control-button control-button--primary" type="button" disabled={!operationAllowsRetry} onClick={() => { void resumeResearch(researchStatus.blockedReason === "codex_auth_required" ? "retry_codex_auth" : "skip_blocked_source"); }}>
          {researchStatus.blockedReason === "codex_auth_required" ? "已恢复登录，继续研究" : "跳过该来源并继续"}
        </button>
        <button className="control-button control-button--danger" type="button" disabled={!operationAllowsRetry} onClick={() => { void stopResearch(); }}>停止任务</button>
      </> : null}
      {bridge && activePhases.has(researchStatus.phase) && researchStatus.phase !== "cancelling" ? <button className="control-button control-button--danger" type="button" disabled={!operationAllowsRetry} onClick={() => { void stopResearch(); }}>停止搜索</button> : null}
      {bridge && researchStatus.phase !== "needs_owner_action" && !activePhases.has(researchStatus.phase) ? <>
        {!prepared ? <button className="control-button control-button--secondary" type="button" disabled={!category || !targetScopeId || !disclosure || !operationAllowsRetry} onClick={() => { void prepareLocal(); }}>准备本机 Codex</button> : null}
        {prepared && category ? <button className="control-button control-button--primary" type="button" disabled={!confirmed || !disclosureFingerprint || !operationAllowsRetry} onClick={() => { void startResearch(); }}>开始研究{categoryCopy[category]}候选</button> : null}
      </> : null}
      {operation === "error" && researchStatus.phase !== "needs_owner_action" ? <button ref={retryRef} className="control-button control-button--secondary" type="button" onClick={() => {
        setOperation("idle");
        setOperationError(undefined);
      }}>{activePhases.has(researchStatus.phase) ? "继续查看状态" : "返回研究设置"}</button> : null}
      {operation !== "error" && (researchStatus.phase === "failed" || researchStatus.phase === "superseded") ? <button ref={retryRef} className="control-button control-button--secondary" type="button" onClick={() => {
        taskFingerprintRef.current = undefined;
        confirmedFingerprintRef.current = undefined;
        setPrepared(undefined);
        setConfirmed(false);
        setResearchStatus({ phase: "idle" });
        setOperation("idle");
        setOperationError(undefined);
      }}>重新选择研究范围</button> : null}
    </div>
  </section>;
}
