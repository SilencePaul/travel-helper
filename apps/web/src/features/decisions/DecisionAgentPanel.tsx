import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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

function safeContextKey(trip: Trip, workspace: DecisionWorkspace, category?: CandidateCategory, targetScopeId?: string) {
  const candidateIds = new Set(workspace.candidates.filter((candidate) => candidate.category === category).map(({ id }) => id));
  return JSON.stringify({
    category,
    targetScopeId,
    trip: tripProjection(trip),
    preferences: workspace.preferences.filter(({ status }) => status === "completed").map(({ id, revision, answers, freeText, status }) => ({ id, revision, answers, freeText, status })),
    summary: workspace.summary && {
      id: workspace.summary.id,
      revision: workspace.summary.revision,
      common: workspace.summary.common,
      disagreements: workspace.summary.disagreements,
      tradeoffs: workspace.summary.tradeoffs,
      status: workspace.summary.status,
    },
    candidates: workspace.candidates.filter(({ id }) => candidateIds.has(id)).map((candidate) => ({
      id: candidate.id,
      revision: candidate.revision,
      category: candidate.category,
      entity: { name: candidate.entity.name, address: candidate.entity.address },
      applicability: candidate.applicability,
      recommendation: { reason: candidate.recommendation.reason },
    })),
    evidence: workspace.evidence.filter(({ candidateId }) => candidateIds.has(candidateId)).map((evidence) => ({
      id: evidence.id,
      revision: evidence.revision,
      candidateId: evidence.candidateId,
      sourceKind: evidence.sourceKind,
      sourceName: evidence.sourceName,
      sourceUrl: evidence.sourceUrl,
      queryContext: evidence.queryContext,
      captureMethod: evidence.captureMethod,
      facts: evidence.facts,
    })),
    feedback: workspace.feedback.filter(({ candidateId }) => candidateIds.has(candidateId)).map((feedback) => ({
      id: feedback.id,
      revision: feedback.revision,
      candidateId: feedback.candidateId,
      kind: feedback.kind,
      reason: feedback.reason,
    })),
  });
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
  const [cloudRunId, setCloudRunId] = useState<string>();
  const lifecycleRef = useRef(0);
  const operationGenerationRef = useRef(0);
  const operationAbortRef = useRef<AbortController | undefined>(undefined);
  const inFlightRef = useRef(false);
  const statusRef = useRef<ResearchStatus>({ phase: "idle" });
  const taskFingerprintRef = useRef<string | undefined>(undefined);
  const lastContextKeyRef = useRef<string | undefined>(undefined);
  const contextKeyRef = useRef("");
  const completedTaskRef = useRef<string | undefined>(undefined);
  const pendingCancellationRef = useRef<string | undefined>(undefined);
  const finalizingCancellationRef = useRef(false);
  const retryRef = useRef<HTMLButtonElement>(null);
  const contextKey = safeContextKey(trip, workspace, category, targetScopeId);
  const researchTaskId = researchStatus.phase === "idle" ? undefined : researchStatus.researchTaskId;

  function setResearchStatus(next: ResearchStatus) {
    statusRef.current = next;
    if (bridgeRevokedPhases.has(next.phase)) setCloudRunId(undefined);
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

  const revokeCloudRun = useCallback(async (agentRunId: string) => {
    if (!repository.getAgentRunStatus) throw new Error("AGENT_STATUS_UNAVAILABLE");
    const parsed = AgentRunSchema.safeParse(await repository.getAgentRunStatus(trip.id, agentRunId));
    if (!parsed.success || parsed.data.tripId !== trip.id || parsed.data.agentRunId !== agentRunId) throw new Error("INVALID_AGENT_RUN_STATUS");
    const latest: AgentRun = parsed.data;
    if (latest.status === "revoked" || latest.status === "expired") return;
    const result = await repository.command({
      action: "revokeAgentRun",
      tripId: trip.id,
      agentRunId,
      expectedRevision: latest.revision,
      idempotencyKey: newIdempotencyKey(),
    });
    if (!result.ok || result.action !== "revokeAgentRun") throw new Error(result.ok ? "INVALID_RESPONSE" : result.error);
  }, [newIdempotencyKey, repository, trip.id]);

  useLayoutEffect(() => {
    contextKeyRef.current = contextKey;
    const previous = lastContextKeyRef.current;
    lastContextKeyRef.current = contextKey;
    if (previous === undefined || previous === contextKey) return;
    setConfirmed(false);
    setPrepared(undefined);
    if (statusRef.current.phase === "needs_owner_action" && taskFingerprintRef.current) {
      operationAbortRef.current?.abort();
      operationGenerationRef.current += 1;
      setResearchStatus(syntheticSuperseded(statusRef.current));
      setOperation("idle");
      setOperationError(undefined);
    }
  }, [contextKey]);

  useEffect(() => {
    let active = true;
    setDisclosure(undefined);
    setDisclosureFingerprint(undefined);
    if (!category || !targetScopeId) return () => { active = false; };
    void buildResearchDisclosure({ workspace, trip: tripProjection(trip) }, { category, targetScopeId })
      .then(async (next) => ({ next, fingerprint: await computeDisclosureFingerprint(next) }))
      .then(({ next, fingerprint }) => {
        if (!active) return;
        setDisclosure(next);
        setDisclosureFingerprint(fingerprint);
      })
      .catch(() => {
        if (!active) return;
        setOperation("error");
        setOperationError("当前行程段无法生成安全披露，请刷新行程后重试。");
      });
    return () => { active = false; };
  }, [category, contextKey, targetScopeId, trip, workspace]);

  useEffect(() => {
    lifecycleRef.current += 1;
    const lifecycle = lifecycleRef.current;
    operationAbortRef.current?.abort();
    operationGenerationRef.current += 1;
    inFlightRef.current = false;
    taskFingerprintRef.current = undefined;
    completedTaskRef.current = undefined;
    pendingCancellationRef.current = undefined;
    finalizingCancellationRef.current = false;
    const nextScopes = buildResearchTargetScopes(tripProjection(trip));
    setTargetScopeId(nextScopes.length === 1 ? nextScopes[0]?.targetScopeId : undefined);
    setCategory(undefined);
    setPrepared(undefined);
    setConfirmed(false);
    setCloudRunId(undefined);
    setResearchStatus({ phase: "idle" });
    setOperation(bridge ? "restoring" : "idle");
    setOperationError(undefined);
    if (!bridge) return;
    const controller = new AbortController();
    operationAbortRef.current = controller;
    void bridge.getResearchStatus({ signal: controller.signal }).then((next) => {
      if (controller.signal.aborted || lifecycleRef.current !== lifecycle) return;
      setResearchStatus(next);
      setOperation("idle");
    }).catch(() => {
      if (controller.signal.aborted || lifecycleRef.current !== lifecycle) return;
      setOperation("error");
      setOperationError("本机 Bridge 状态暂时无法读取，共同决定仍可正常使用。");
    });
    return () => controller.abort();
  }, [bridge, repository, trip, tripSafetyKey]);

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
    const runId = cloudRunId;
    const { generation, lifecycle } = beginOperation("cancelling");
    void (async () => {
      try {
        if (runId) await revokeCloudRun(runId);
        if (!isCurrent(generation, lifecycle)) return;
        pendingCancellationRef.current = undefined;
        setCloudRunId(undefined);
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
  }, [cloudRunId, researchStatus, revokeCloudRun]);

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
      setConfirmed(false);
      setOperation("idle");
    } catch (error) {
      if (!isCurrent(generation, lifecycle) || controller.signal.aborted) return;
      setOperation("error");
      setOperationError(error instanceof LocalAgentBridgeError && error.code === "CODEX_NOT_AUTHENTICATED"
        ? "请在 ChatGPT/Codex 中恢复登录，然后重试准备。"
        : "本机 Codex 暂未就绪，已保存的共同决定不受影响。");
    } finally {
      inFlightRef.current = false;
    }
  }

  async function createCloudRun(material: PreparedAgentRun): Promise<string> {
    const input: CreateAgentRunCommand = {
      action: "createAgentRun",
      tripId: trip.id,
      publicKeyJwk: material.publicKeyJwk,
      pairingCodeHash: material.pairingCodeHash,
      scope: ["submitProposalBatch"],
      idempotencyKey: newIdempotencyKey(),
    };
    const result = await repository.command(input);
    if (!result.ok || result.action !== "createAgentRun") throw new Error(result.ok ? "INVALID_RESPONSE" : result.error);
    return result.data.agentRunId;
  }

  async function startResearch() {
    if (!bridge || !prepared || !confirmed || !category || !targetScopeId || !disclosureFingerprint || inFlightRef.current) return;
    inFlightRef.current = true;
    const { controller, generation, lifecycle } = beginOperation("starting");
    const startingContextKey = contextKeyRef.current;
    let agentRunId: string | undefined;
    try {
      agentRunId = await createCloudRun(prepared);
      if (!isCurrent(generation, lifecycle) || startingContextKey !== contextKeyRef.current) {
        await revokeCloudRun(agentRunId);
        return;
      }
      setCloudRunId(agentRunId);
      await bridge.claim(agentRunId, { signal: controller.signal });
      if (!isCurrent(generation, lifecycle) || startingContextKey !== contextKeyRef.current) {
        await revokeCloudRun(agentRunId);
        return;
      }
      taskFingerprintRef.current = disclosureFingerprint;
      setPrepared(undefined);
      setConfirmed(false);
      const next = await bridge.executeTravelResearch({
        agentRunId,
        targetCategory: category,
        targetScopeId,
        disclosureFingerprint,
      }, { signal: controller.signal });
      if (!isCurrent(generation, lifecycle)) return;
      setResearchStatus(next);
      setOperation("idle");
    } catch (error) {
      if (!isCurrent(generation, lifecycle) || controller.signal.aborted) return;
      if (error instanceof LocalAgentBridgeError && error.code === "DISCLOSURE_CONTEXT_CHANGED") {
        const current = statusRef.current;
        if (current.phase !== "idle") setResearchStatus(syntheticSuperseded(current));
        setConfirmed(false);
        setPrepared(undefined);
        setOperation("idle");
      } else {
        setOperation("error");
        setOperationError("研究未能安全启动，请重新准备后再试。");
      }
    } finally {
      inFlightRef.current = false;
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
    try {
      const material = await bridge.prepare({ signal: controller.signal });
      if (!isCurrent(generation, lifecycle)) return;
      const agentRunId = await createCloudRun(material);
      setCloudRunId(agentRunId);
      await bridge.claim(agentRunId, { signal: controller.signal });
      if (!isCurrent(generation, lifecycle)) return;
      const next = await bridge.resumeTravelResearch({ agentRunId, researchTaskId: blocked.researchTaskId, resumeAction }, { signal: controller.signal });
      if (!isCurrent(generation, lifecycle)) return;
      setResearchStatus(next);
      setOperation("idle");
    } catch (error) {
      if (!isCurrent(generation, lifecycle) || controller.signal.aborted) return;
      if (error instanceof LocalAgentBridgeError && error.code === "DISCLOSURE_CONTEXT_CHANGED") {
        setResearchStatus(syntheticSuperseded(blocked));
        setConfirmed(false);
        setPrepared(undefined);
        setOperation("idle");
      } else {
        setOperation("error");
        setOperationError("暂时无法继续原 Codex 任务，未创建新研究内容。");
      }
    } finally {
      inFlightRef.current = false;
    }
  }

  async function stopResearch() {
    if (!bridge || researchStatus.phase === "idle" || inFlightRef.current) return;
    const taskId = researchStatus.researchTaskId;
    pendingCancellationRef.current = taskId;
    inFlightRef.current = true;
    const { controller, generation, lifecycle } = beginOperation("cancelling");
    try {
      try {
        await bridge.cancelResearch({ researchTaskId: taskId }, { signal: controller.signal });
      } catch {
        // A lost cancellation response is reconciled by the required status read below.
      }
      const reconciled = await bridge.getResearchStatus({ signal: controller.signal });
      if (!isCurrent(generation, lifecycle)) return;
      if (reconciled.phase === "idle" || reconciled.researchTaskId !== taskId) throw new Error("INVALID_RESEARCH_STATUS");
      if (reconciled.phase !== "cancelled") {
        setResearchStatus(reconciled);
        setOperation("error");
        setOperationError(reconciled.phase === "writing"
          ? "写入结果尚未确认，正在继续对账；当前不宣称已停止。"
          : "本机停止结果尚未确认，请继续对账。");
        return;
      }
      if (cloudRunId) await revokeCloudRun(cloudRunId);
      pendingCancellationRef.current = undefined;
      setCloudRunId(undefined);
      setResearchStatus(reconciled);
      setOperation("idle");
    } catch {
      if (!isCurrent(generation, lifecycle) || controller.signal.aborted) return;
      setOperation("error");
      setOperationError("停止结果尚未确认，不会将本次操作标记为成功。");
    } finally {
      inFlightRef.current = false;
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
      onConfirmedChange={setConfirmed}
    /> : null}

    {cloudRunId || researchStatus.phase !== "idle" ? <dl className="decision-agent-panel__status-card">
      {cloudRunId ? <div><dt>云端授权</dt><dd>{cloudRunId}</dd></div> : null}
      {researchStatus.phase !== "idle" ? <div><dt>本机任务</dt><dd>{researchStatus.researchTaskId}</dd></div> : null}
      <div><dt>当前阶段</dt><dd>{researchStatus.phase}</dd></div>
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
        {!prepared ? <button ref={operation === "error" ? retryRef : undefined} className="control-button control-button--secondary" type="button" disabled={!category || !targetScopeId || !disclosure || !operationAllowsRetry} onClick={() => { void prepareLocal(); }}>准备本机 Codex</button> : null}
        {prepared && category ? <button ref={operation === "error" ? retryRef : undefined} className="control-button control-button--primary" type="button" disabled={!confirmed || !disclosureFingerprint || !operationAllowsRetry} onClick={() => { void startResearch(); }}>开始研究{categoryCopy[category]}候选</button> : null}
      </> : null}
      {operation === "error" && researchStatus.phase !== "needs_owner_action" && activePhases.has(researchStatus.phase) ? <button ref={retryRef} className="control-button control-button--secondary" type="button" onClick={() => {
        setOperation("idle");
        setOperationError(undefined);
      }}>继续查看状态</button> : null}
    </div>
  </section>;
}
