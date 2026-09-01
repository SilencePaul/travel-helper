import { useEffect, useRef, useState } from "react";
import {
  AgentRunSchema,
  type AgentRun,
  type AgentScope,
  type DecisionCommand,
  type DecisionWorkspaceRepository,
} from "@travel/contracts";
import type { LocalAgentBridge, PreparedAgentRun } from "../../infrastructure/localAgentBridgeClient";

type Props = {
  repository: DecisionWorkspaceRepository;
  bridge?: LocalAgentBridge;
  tripId: string;
  newIdempotencyKey: () => string;
};

type Phase = "idle" | "preparing" | "prepared" | "creating" | "claiming" | "pending_claim" | "active" | "offline" | "error" | "conflict" | "revoking" | "revoke_error" | "reconciling" | "reconcile_error" | "revoked" | "expired";
type PanelMessage = { text: string; role: "status" | "alert" };
type CreateAgentRunCommand = Extract<DecisionCommand, { action: "createAgentRun" }>;

const agentScope: AgentScope[] = ["submitProposalBatch", "appendEvidenceSnapshot", "reportVerificationBlocked"];
const scopeCopy: Record<AgentScope, string> = {
  submitProposalBatch: "提出每轮 2–4 个候选",
  appendEvidenceSnapshot: "追加带来源与时间的证据快照",
  reportVerificationBlocked: "报告登录、验证码与风控阻断",
  generatePreferenceSummary: "按双方当前偏好生成共同摘要",
};
const statusPollMs = 5_000;
const maxTimerMs = 2_147_483_647;

function parseSafeRun(value: unknown, tripId: string, agentRunId: string) {
  const parsed = AgentRunSchema.safeParse(value);
  if (!parsed.success || parsed.data.tripId !== tripId || parsed.data.agentRunId !== agentRunId) {
    throw new Error("INVALID_AGENT_RUN_STATUS");
  }
  return parsed.data;
}

function displayTime(value?: string) {
  if (!value) return "等待服务端确认";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function DecisionAgentPanel({ repository, bridge, tripId, newIdempotencyKey }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [prepared, setPrepared] = useState<PreparedAgentRun>();
  const [confirmed, setConfirmed] = useState(false);
  const [run, setRun] = useState<AgentRun>();
  const [createdRunId, setCreatedRunId] = useState<string>();
  const [reconcileRunId, setReconcileRunId] = useState<string>();
  const [message, setMessage] = useState<PanelMessage>();
  const abortRef = useRef<AbortController | undefined>(undefined);
  const generationRef = useRef(0);
  const lifecycleRef = useRef(0);
  const retryRef = useRef<HTMLButtonElement>(null);
  const createKeyRef = useRef<string | undefined>(undefined);
  const pendingCreateRef = useRef<CreateAgentRunCommand | undefined>(undefined);

  useEffect(() => {
    lifecycleRef.current += 1;
    abortRef.current?.abort();
    generationRef.current += 1;
    createKeyRef.current = undefined;
    pendingCreateRef.current = undefined;
    setPhase("idle");
    setPrepared(undefined);
    setConfirmed(false);
    setRun(undefined);
    setCreatedRunId(undefined);
    setReconcileRunId(undefined);
    setMessage(undefined);
    return () => abortRef.current?.abort();
  }, [tripId, repository, bridge]);

  useEffect(() => {
    if (!["offline", "error", "conflict", "revoke_error", "reconcile_error"].includes(phase)) return;
    const frame = requestAnimationFrame(() => retryRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [phase]);

  useEffect(() => {
    if (!run || !["active", "pending_claim"].includes(phase) || !repository.getAgentRunStatus) return;
    const observedRunId = run.agentRunId;
    const observedLifecycle = lifecycleRef.current;
    let stopped = false;
    let polling = false;
    const expiresIn = new Date(run.expiresAt).getTime() - Date.now();
    const expiryTimer = expiresIn > 0 && expiresIn <= maxTimerMs
      ? globalThis.setTimeout(() => {
        if (stopped || lifecycleRef.current !== observedLifecycle) return;
        setRun((current) => current?.agentRunId === observedRunId ? { ...current, status: "expired" } : current);
        setPhase("expired");
        setMessage({ text: "Agent 运行已过期，可重新准备一个新的运行。", role: "alert" });
      }, expiresIn)
      : undefined;
    const pollTimer = globalThis.setInterval(async () => {
      if (stopped || polling) return;
      polling = true;
      try {
        const status = parseSafeRun(await repository.getAgentRunStatus!(tripId, observedRunId), tripId, observedRunId);
        if (stopped || lifecycleRef.current !== observedLifecycle) return;
        setRun(status);
        if (status.status === "revoked") {
          setPhase("revoked");
          setMessage({ text: "Agent 已停止，新的签名写入会被拒绝。", role: "status" });
        } else if (status.status === "expired" || new Date(status.expiresAt).getTime() <= Date.now()) {
          setRun({ ...status, status: "expired" });
          setPhase("expired");
          setMessage({ text: "Agent 运行已过期，可重新准备一个新的运行。", role: "alert" });
        } else if (status.status === "pending_claim") {
          setPhase("pending_claim");
          setMessage({ text: "授权已创建，正在等待 Desktop Agent 领取。", role: "status" });
        } else {
          setPhase("active");
        }
      } catch {
        // A transient status refresh failure must not affect the shared decision workspace.
      } finally {
        polling = false;
      }
    }, statusPollMs);
    return () => {
      stopped = true;
      if (expiryTimer !== undefined) globalThis.clearTimeout(expiryTimer);
      globalThis.clearInterval(pollTimer);
    };
  }, [phase, repository, run, tripId]);

  function beginOperation() {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    generationRef.current += 1;
    return { controller, generation: generationRef.current, lifecycle: lifecycleRef.current };
  }

  function isCurrent(generation: number, lifecycle: number) {
    return generationRef.current === generation && lifecycleRef.current === lifecycle;
  }

  function presentRun(status: AgentRun, overrideMessage?: PanelMessage) {
    const expired = status.status !== "revoked" && new Date(status.expiresAt).getTime() <= Date.now();
    const current = expired ? { ...status, status: "expired" as const } : status;
    setRun(current);
    if (current.status === "revoked") {
      setPhase("revoked");
      setMessage(overrideMessage ?? { text: "Agent 已停止，新的签名写入会被拒绝。", role: "status" });
    } else if (current.status === "expired") {
      setPhase("expired");
      setMessage(overrideMessage ?? { text: "Agent 运行已过期，可重新准备一个新的运行。", role: "alert" });
    } else if (current.status === "pending_claim") {
      setPhase("pending_claim");
      setMessage(overrideMessage ?? { text: "授权已创建，正在等待 Desktop Agent 领取。", role: "status" });
    } else {
      setPhase("active");
      setMessage(overrideMessage ?? { text: "Agent 已领取本次授权。", role: "status" });
    }
  }

  async function readRunStatus(agentRunId: string, generation: number, lifecycle: number, overrideMessage?: PanelMessage) {
    if (!repository.getAgentRunStatus) throw new Error("AGENT_STATUS_UNAVAILABLE");
    const status = parseSafeRun(await repository.getAgentRunStatus(tripId, agentRunId), tripId, agentRunId);
    if (!isCurrent(generation, lifecycle)) return;
    presentRun(status, overrideMessage);
  }

  async function prepareBridge() {
    if (!bridge) return;
    const { controller, generation, lifecycle } = beginOperation();
    setPhase("preparing");
    setMessage({ text: "正在与本机 Desktop Bridge 建立准备通道…", role: "status" });
    try {
      const next = await bridge.prepare(agentScope, { signal: controller.signal });
      if (!isCurrent(generation, lifecycle)) return;
      setPrepared(next);
      setConfirmed(false);
      setPhase("prepared");
      setMessage({ text: "非机密配对材料已准备，请确认授权范围。", role: "status" });
    } catch {
      if (!isCurrent(generation, lifecycle) || controller.signal.aborted) return;
      setPhase("offline");
      setMessage({ text: "Desktop Bridge 未在线，已保存的共同决定仍可使用。", role: "alert" });
    }
  }

  async function claimRun(agentRunId: string) {
    if (!bridge) return;
    const { controller, generation, lifecycle } = beginOperation();
    setPhase("claiming");
    setMessage({ text: "正在让本机 Agent 领取授权…", role: "status" });
    try {
      await bridge.claim(agentRunId, { signal: controller.signal });
      await readRunStatus(agentRunId, generation, lifecycle);
    } catch {
      if (!isCurrent(generation, lifecycle) || controller.signal.aborted) return;
      setPhase("error");
      setMessage({ text: "Agent 已创建，连接响应丢失，可安全重试。", role: "alert" });
    }
  }

  async function reconcileCancelledCreate(input: CreateAgentRunCommand, lifecycle: number) {
    if (lifecycleRef.current !== lifecycle || !repository.getAgentRunStatus) return;
    const { generation } = beginOperation();
    setPhase("reconciling");
    setMessage({ text: "正在对账取消前可能已提交的授权…", role: "status" });
    try {
      const result = await repository.command(input);
      if (!isCurrent(generation, lifecycle)) return;
      if (!result.ok || result.action !== "createAgentRun") throw new Error(result.ok ? "INVALID_RESPONSE" : result.error);
      setCreatedRunId(result.data.agentRunId);
      setReconcileRunId(result.data.agentRunId);
      await readRunStatus(result.data.agentRunId, generation, lifecycle, {
        text: "取消时授权可能已提交；已恢复远端状态，请确认是否停止 Agent。",
        role: "alert",
      });
      if (isCurrent(generation, lifecycle)) pendingCreateRef.current = undefined;
    } catch {
      if (!isCurrent(generation, lifecycle)) return;
      setPhase("reconcile_error");
      setMessage({ text: "取消后的远端授权状态暂时无法确认，请重试状态对账。", role: "alert" });
    }
  }

  async function reconcileKnownRun(agentRunId: string, lifecycle: number) {
    if (lifecycleRef.current !== lifecycle || !repository.getAgentRunStatus) return;
    const { generation } = beginOperation();
    setReconcileRunId(agentRunId);
    setPhase("reconciling");
    setMessage({ text: "正在对账取消前可能已提交的授权…", role: "status" });
    try {
      await readRunStatus(agentRunId, generation, lifecycle, {
        text: "取消时授权可能已提交；已恢复远端状态，请确认是否停止 Agent。",
        role: "alert",
      });
    } catch {
      if (!isCurrent(generation, lifecycle)) return;
      setPhase("reconcile_error");
      setMessage({ text: "取消后的远端授权状态暂时无法确认，请重试状态对账。", role: "alert" });
    }
  }

  async function createAndClaim() {
    if (!prepared || !confirmed || !bridge) return;
    if (!repository.getAgentRunStatus) {
      setPhase("error");
      setMessage({ text: "当前无法读取 Agent 安全状态，未创建授权。请稍后重试。", role: "alert" });
      return;
    }
    const { controller, generation, lifecycle } = beginOperation();
    setPhase("creating");
    setMessage({ text: "正在创建 15 分钟的范围化授权…", role: "status" });
    createKeyRef.current ??= newIdempotencyKey();
    const input: CreateAgentRunCommand = {
      action: "createAgentRun",
      tripId,
      publicKeyJwk: prepared.publicKeyJwk,
      pairingCodeHash: prepared.pairingCodeHash,
      scope: agentScope,
      idempotencyKey: createKeyRef.current,
    };
    pendingCreateRef.current = input;
    try {
      const result = await repository.command(input);
      if (!isCurrent(generation, lifecycle)) return;
      if (!result.ok || result.action !== "createAgentRun") throw new Error(result.ok ? "INVALID_RESPONSE" : result.error);
      pendingCreateRef.current = undefined;
      setCreatedRunId(result.data.agentRunId);
      if (controller.signal.aborted) return;
      await claimRun(result.data.agentRunId);
    } catch {
      if (!isCurrent(generation, lifecycle) || controller.signal.aborted) return;
      setPhase("error");
      setMessage({ text: "授权暂时无法创建，可使用原请求安全重试。", role: "alert" });
    }
  }

  function cancelStart() {
    const lifecycle = lifecycleRef.current;
    const pendingCreate = pendingCreateRef.current;
    const knownRunId = createdRunId;
    abortRef.current?.abort();
    generationRef.current += 1;
    if (knownRunId && repository.getAgentRunStatus) {
      void reconcileKnownRun(knownRunId, lifecycle);
    } else if (pendingCreate) {
      void reconcileCancelledCreate(pendingCreate, lifecycle);
    } else {
      setPhase(prepared ? "prepared" : "idle");
      setMessage({ text: "已取消本次连接；共同决定不受影响。", role: "status" });
    }
  }

  async function revokeRun() {
    if (!run || !repository.getAgentRunStatus || phase === "revoking") return;
    const { generation, lifecycle } = beginOperation();
    setPhase("revoking");
    setMessage({ text: "正在读取最新安全状态并停止 Agent…", role: "status" });
    try {
      const latest = parseSafeRun(await repository.getAgentRunStatus(tripId, run.agentRunId), tripId, run.agentRunId);
      if (!isCurrent(generation, lifecycle)) return;
      setRun(latest);
      if (latest.status === "revoked" || latest.status === "expired" || new Date(latest.expiresAt).getTime() <= Date.now()) {
        presentRun(latest);
        return;
      }
      const result = await repository.command({
        action: "revokeAgentRun",
        tripId,
        agentRunId: latest.agentRunId,
        expectedRevision: latest.revision,
        idempotencyKey: newIdempotencyKey(),
      });
      if (!isCurrent(generation, lifecycle)) return;
      if (!result.ok) {
        if (result.error === "VERSION_CONFLICT") {
          const conflictLatest = parseSafeRun(result.latest, tripId, latest.agentRunId);
          setRun(conflictLatest);
          setPhase("conflict");
          setMessage({ text: "Agent 状态已变化，请确认后重试停止。", role: "alert" });
          return;
        }
        throw new Error(result.error);
      }
      if (result.action !== "revokeAgentRun") throw new Error("INVALID_RESPONSE");
      presentRun({ ...latest, status: "revoked", revokedAt: result.data.revokedAt, revision: latest.revision + 1 });
    } catch {
      if (!isCurrent(generation, lifecycle)) return;
      setPhase("revoke_error");
      setMessage({ text: "停止失败，请读取最新状态后重试。", role: "alert" });
    }
  }

  function startFreshRun() {
    abortRef.current?.abort();
    generationRef.current += 1;
    createKeyRef.current = undefined;
    pendingCreateRef.current = undefined;
    setPrepared(undefined);
    setConfirmed(false);
    setRun(undefined);
    setCreatedRunId(undefined);
    setReconcileRunId(undefined);
    setMessage(undefined);
    setPhase("idle");
    void prepareBridge();
  }

  const starting = ["preparing", "creating", "claiming", "reconciling", "revoking"].includes(phase);
  const title = phase === "active" ? "Agent 正在运行"
    : phase === "pending_claim" ? "等待 Agent 领取"
      : phase === "revoking" ? "正在停止 Agent"
        : phase === "revoked" ? "Agent 已停止"
          : phase === "expired" ? "Agent 已过期"
            : phase === "prepared" ? "等待成员授权"
              : phase === "reconciling" ? "正在核对远端状态"
                : run ? "Agent 状态待处理"
                  : bridge ? "Agent 尚未启动" : "Desktop Bridge 未连接";

  return <section className={`decision-agent-panel decision-agent-panel--${phase}`} aria-labelledby="decision-agent-title" aria-busy={starting}>
    <div className="decision-agent-panel__route" aria-hidden="true"><span>WEB</span><i /> <span>LOCAL AGENT</span></div>
    <header>
      <p>LOCAL AGENT CONTROL · 15 MIN PASS</p>
      <h2 id="decision-agent-title">{title}</h2>
      <span>{bridge ? "浏览器只传递公钥材料与 AgentRun ID。" : "共同决定与已保存行程仍可正常使用。"}</span>
    </header>

    {prepared && !run ? <div className="decision-agent-panel__permit">
      <div><small>配对指纹</small><strong>{prepared.pairingCodeFingerprint}</strong></div>
      <p>请与 Desktop Agent 显示的配对指纹逐字核对。</p>
      <ul>
        <li>读取当前行程共享决策上下文</li>
        {agentScope.map((scope) => <li key={scope}>{scopeCopy[scope]}</li>)}
      </ul>
      <label><input type="checkbox" checked={confirmed} disabled={starting} onChange={(event) => setConfirmed(event.currentTarget.checked)} /> 我确认以上授权范围</label>
    </div> : null}

    {run ? <dl className="decision-agent-panel__status">
      <div><dt>运行编号</dt><dd>{run.agentRunId}</dd></div>
      <div><dt>授权到期</dt><dd>{displayTime(run.expiresAt)}</dd></div>
      <div><dt>下一序号</dt><dd>{run.nextSequence}</dd></div>
    </dl> : null}

    {message ? <p className="decision-agent-panel__message" role={message.role}>{message.text}</p> : null}

    <div className="decision-agent-panel__actions">
      {!bridge ? null : phase === "idle" || phase === "offline"
        ? <button ref={phase === "offline" ? retryRef : undefined} className="control-button control-button--primary" type="button" onClick={() => { void prepareBridge(); }}>{phase === "offline" ? "重试准备" : "准备本机 Agent"}</button>
        : phase === "prepared"
          ? <button className="control-button control-button--primary" type="button" disabled={!confirmed} onClick={() => { void createAndClaim(); }}>授权并连接</button>
          : phase === "error" && createdRunId
            ? <button ref={retryRef} className="control-button control-button--primary" type="button" onClick={() => { void claimRun(createdRunId); }}>重试连接</button>
            : phase === "error"
              ? <button ref={retryRef} className="control-button control-button--primary" type="button" onClick={() => { void createAndClaim(); }}>重试授权</button>
              : phase === "reconcile_error"
                ? <button ref={retryRef} className="control-button control-button--primary" type="button" onClick={() => {
                  if (reconcileRunId) void reconcileKnownRun(reconcileRunId, lifecycleRef.current);
                  else if (pendingCreateRef.current) void reconcileCancelledCreate(pendingCreateRef.current, lifecycleRef.current);
                }}>重试状态对账</button>
                : phase === "active" || phase === "pending_claim"
                  ? <button className="control-button control-button--danger" type="button" onClick={() => { void revokeRun(); }}>停止 Agent</button>
                  : phase === "revoking"
                    ? <button className="control-button control-button--danger" type="button" disabled>正在停止…</button>
                    : phase === "conflict"
                      ? <button ref={retryRef} className="control-button control-button--danger" type="button" onClick={() => { void revokeRun(); }}>再次停止 Agent</button>
                      : phase === "revoke_error"
                        ? <button ref={retryRef} className="control-button control-button--danger" type="button" onClick={() => { void revokeRun(); }}>重试停止 Agent</button>
                        : phase === "revoked" || phase === "expired"
                          ? <button className="control-button control-button--primary" type="button" onClick={startFreshRun}>准备新 Agent</button>
                          : null}
      {["preparing", "creating", "claiming"].includes(phase) ? <button className="control-button control-button--secondary" type="button" onClick={cancelStart}>取消连接</button> : null}
    </div>
  </section>;
}
