import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { DecisionCommand, DecisionWorkspace, DecisionWorkspaceRepository, Member, PreferenceProfile, Trip } from "@travel/contracts";
import type { LocalAgentBridge } from "../../infrastructure/localAgentBridgeClient";
import { DecisionAgentMemberNotice } from "./DecisionAgentMemberNotice";
import { DecisionAgentPanel } from "./DecisionAgentPanel";
import { DecisionWorkspaceShowcase } from "./DecisionWorkspaceShowcase";
import { toDecisionWorkspaceViewModel } from "./decisionWorkspaceAdapter";

type Props = {
  repository: DecisionWorkspaceRepository;
  trip: Trip;
  member: Member;
  agentBridge?: LocalAgentBridge;
  onBack: () => void;
  newIdempotencyKey?: () => string;
};

type MessageState = {
  text: string;
  role: "status" | "alert";
  source: "load" | "command" | "refresh";
};

type PreferenceField = "pace" | "budget" | "accommodation" | "walking" | "queue" | "dining" | "attractions" | "mustHave" | "mustAvoid" | "note";
type PreferenceValues = Record<PreferenceField, string>;
type PreferenceDraft = {
  values: PreferenceValues;
  baseline: PreferenceValues;
  dirtyFields: PreferenceField[];
  baseRevision: number;
  latestRevision: number;
  conflict: boolean;
};
type PageOperation = { kind: "command" | "refresh"; generation: number };
type PageScope = { repository: DecisionWorkspaceRepository; tripId: string; memberUid: string; generation: number };

const preferenceFields: PreferenceField[] = ["pace", "budget", "accommodation", "walking", "queue", "dining", "attractions", "mustHave", "mustAvoid", "note"];

function defaultIdempotencyKey() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `decision-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function valuesFromProfile(profile?: PreferenceProfile): PreferenceValues {
  return {
    pace: String(profile?.answers.pace ?? "slow"),
    budget: String(profile?.answers.budget ?? "mid"),
    accommodation: String(profile?.answers.accommodation ?? "comfortable"),
    walking: String(profile?.answers.walking ?? "balanced"),
    queue: String(profile?.answers.queue ?? "short"),
    dining: String(profile?.answers.dining ?? ""),
    attractions: String(profile?.answers.attractions ?? ""),
    mustHave: profile?.freeText?.mustHave ?? "",
    mustAvoid: profile?.freeText?.mustAvoid ?? "",
    note: profile?.freeText?.note ?? "",
  };
}

function cleanDraft(profile?: PreferenceProfile): PreferenceDraft {
  const values = valuesFromProfile(profile);
  const revision = profile?.revision ?? 0;
  return { values, baseline: values, dirtyFields: [], baseRevision: revision, latestRevision: revision, conflict: false };
}

function decimalCursor(cursor: string): bigint | undefined {
  return /^\d+$/.test(cursor) ? BigInt(cursor) : undefined;
}

export function DecisionWorkspacePage({ repository, trip, member, agentBridge, onBack, newIdempotencyKey = defaultIdempotencyKey }: Props) {
  const [workspace, setWorkspace] = useState<DecisionWorkspace>();
  const [draft, setDraft] = useState<PreferenceDraft>();
  const [message, setMessage] = useState<MessageState>({ text: "正在读取共同决定…", role: "status", source: "load" });
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const workspaceRef = useRef<DecisionWorkspace | undefined>(undefined);
  const draftRef = useRef<PreferenceDraft | undefined>(undefined);
  const preferenceFormRef = useRef<HTMLFormElement>(null);
  const loadRetryRef = useRef<HTMLButtonElement>(null);
  const operationRef = useRef<PageOperation | undefined>(undefined);
  const scopeRef = useRef<PageScope | undefined>(undefined);
  const previousScope = scopeRef.current;
  if (!previousScope || previousScope.repository !== repository || previousScope.tripId !== trip.id || previousScope.memberUid !== member.uid) {
    scopeRef.current = { repository, tripId: trip.id, memberUid: member.uid, generation: (previousScope?.generation ?? 0) + 1 };
    operationRef.current = undefined;
  }
  const scopeGeneration = scopeRef.current!.generation;

  const isCurrentScope = useCallback((generation: number) => scopeRef.current?.generation === generation, []);

  const replaceDraft = useCallback((next: PreferenceDraft) => {
    draftRef.current = next;
    setDraft(next);
  }, []);

  const acceptWorkspace = useCallback((next: DecisionWorkspace): boolean => {
    if (next.tripId !== trip.id) return false;
    const current = workspaceRef.current;
    const currentCursor = current && decimalCursor(current.workspaceCursor);
    const nextCursor = decimalCursor(next.workspaceCursor);
    if (nextCursor === undefined || (current && currentCursor !== undefined && nextCursor <= currentCursor)) return false;

    workspaceRef.current = next;
    setWorkspace(next);
    const profile = next.preferences.find(({ ownerUid }) => ownerUid === member.uid);
    const currentDraft = draftRef.current;
    if (!currentDraft) {
      replaceDraft(cleanDraft(profile));
      return true;
    }
    if ((profile?.revision ?? 0) <= currentDraft.latestRevision) return true;

    const remoteValues = valuesFromProfile(profile);
    if (currentDraft.dirtyFields.length === 0) {
      replaceDraft(cleanDraft(profile));
      return true;
    }

    const mergedValues = { ...remoteValues };
    for (const field of currentDraft.dirtyFields) mergedValues[field] = currentDraft.values[field];
    const dirtyFields = currentDraft.dirtyFields.filter((field) => mergedValues[field] !== remoteValues[field]);
    if (dirtyFields.length === 0) {
      replaceDraft(cleanDraft(profile));
      return true;
    }
    replaceDraft({
      values: mergedValues,
      baseline: remoteValues,
      dirtyFields,
      baseRevision: currentDraft.baseRevision,
      latestRevision: profile?.revision ?? 0,
      conflict: true,
    });
    return true;
  }, [member.uid, replaceDraft, trip.id]);

  const acceptOwnProfile = useCallback((profile: PreferenceProfile) => {
    const current = draftRef.current ?? cleanDraft(profile);
    const remoteValues = valuesFromProfile(profile);
    const values = { ...remoteValues };
    for (const field of current.dirtyFields) values[field] = current.values[field];
    const dirtyFields = current.dirtyFields.filter((field) => values[field] !== remoteValues[field]);
    replaceDraft({ values, baseline: remoteValues, dirtyFields, baseRevision: profile.revision, latestRevision: profile.revision, conflict: false });
  }, [replaceDraft]);

  const focusLoadRetry = useCallback(() => {
    requestAnimationFrame(() => loadRetryRef.current?.focus());
  }, []);

  useEffect(() => {
    let active = true;
    const generation = scopeGeneration;
    workspaceRef.current = undefined;
    draftRef.current = undefined;
    operationRef.current = undefined;
    setWorkspace(undefined);
    setDraft(undefined);
    setBusy(false);
    setRefreshing(false);
    setMessage({ text: "正在读取共同决定…", role: "status", source: "load" });

    void repository.load(trip.id).then((loaded) => {
      if (!active || !isCurrentScope(generation)) return;
      if (acceptWorkspace(loaded)) {
        setMessage((current) => current.source === "load" ? { text: "", role: "status", source: "load" } : current);
      } else if (!workspaceRef.current) {
        setMessage({ text: "共同决定暂时无法加载，请检查网络后重试。", role: "alert", source: "load" });
        focusLoadRetry();
      }
    }).catch(() => {
      if (!active || !isCurrentScope(generation) || workspaceRef.current) return;
      setMessage({ text: "共同决定暂时无法加载，请检查网络后重试。", role: "alert", source: "load" });
      focusLoadRetry();
    });
    const unsubscribe = repository.subscribe(trip.id, (next) => {
      if (!active || !isCurrentScope(generation) || !acceptWorkspace(next)) return;
      setMessage((current) => current.source === "load" ? { text: "", role: "status", source: "load" } : current);
    });
    return () => { active = false; unsubscribe(); };
  }, [acceptWorkspace, focusLoadRetry, isCurrentScope, repository, scopeGeneration, trip.id]);

  const retryInitialLoad = useCallback(async () => {
    const generation = scopeGeneration;
    if (!isCurrentScope(generation) || operationRef.current) return;
    const operation: PageOperation = { kind: "refresh", generation };
    operationRef.current = operation;
    setRefreshing(true);
    setMessage({ text: "正在重新加载共同决定…", role: "status", source: "load" });
    try {
      const refreshed = await repository.refresh(trip.id);
      if (!isCurrentScope(generation)) return;
      if (refreshed.tripId !== trip.id || !acceptWorkspace(refreshed) && !workspaceRef.current) throw new Error("invalid workspace");
      setMessage({ text: "", role: "status", source: "load" });
    } catch {
      if (!isCurrentScope(generation)) return;
      if (workspaceRef.current) {
        setMessage((current) => current.source === "load" ? { text: "", role: "status", source: "load" } : current);
        return;
      }
      setMessage({ text: "共同决定暂时无法加载，请检查网络后重试。", role: "alert", source: "load" });
      focusLoadRetry();
    } finally {
      if (isCurrentScope(generation) && operationRef.current === operation) {
        operationRef.current = undefined;
        setRefreshing(false);
      }
    }
  }, [acceptWorkspace, focusLoadRetry, isCurrentScope, repository, scopeGeneration, trip.id]);

  const retryRefresh = useCallback(async () => {
    const generation = scopeGeneration;
    if (!isCurrentScope(generation) || operationRef.current) return;
    const operation: PageOperation = { kind: "refresh", generation };
    operationRef.current = operation;
    setRefreshing(true);
    setMessage({ text: "正在刷新共同决定…", role: "status", source: "refresh" });
    try {
      const refreshed = await repository.refresh(trip.id);
      if (!isCurrentScope(generation)) return;
      if (refreshed.tripId !== trip.id) throw new Error("invalid workspace");
      acceptWorkspace(refreshed);
      setMessage({ text: "已刷新共同决定。", role: "status", source: "refresh" });
    } catch {
      if (!isCurrentScope(generation)) return;
      setMessage({ text: "共同决定暂时无法刷新，请检查网络后重试。", role: "alert", source: "refresh" });
    } finally {
      if (isCurrentScope(generation) && operationRef.current === operation) {
        operationRef.current = undefined;
        setRefreshing(false);
      }
    }
  }, [acceptWorkspace, isCurrentScope, repository, scopeGeneration, trip.id]);

  const runCommand = useCallback(async (command: DecisionCommand, trigger?: HTMLElement) => {
    const generation = scopeGeneration;
    if (!isCurrentScope(generation) || operationRef.current) return false;
    const operation: PageOperation = { kind: "command", generation };
    operationRef.current = operation;
    let commandCommitted = false;
    const preferenceWrite = command.action === "upsertPreference" || command.action === "completePreference" || command.action === "skipPreference";
    setBusy(true);
    setMessage({ text: "正在保存共同决定…", role: "status", source: "command" });
    try {
      const result = await repository.command(command);
      if (!isCurrentScope(generation)) return false;
      if (!result.ok) {
        if (result.error === "VERSION_CONFLICT") {
          try {
            const refreshed = await repository.refresh(trip.id);
            if (!isCurrentScope(generation)) return false;
            if (refreshed.tripId !== trip.id) throw new Error("invalid workspace");
            acceptWorkspace(refreshed);
            if (preferenceWrite && draftRef.current?.conflict) setMessage({ text: "", role: "status", source: "command" });
            else setMessage({ text: "内容已被同行者更新，请查看最新版本后再试。", role: "alert", source: "command" });
          } catch {
            if (!isCurrentScope(generation)) return false;
            setMessage({ text: "内容已被更新，但暂时无法读取最新版本。", role: "alert", source: "refresh" });
          }
        } else {
          setMessage({ text: `保存失败：${result.error}`, role: "alert", source: "command" });
        }
        return false;
      }
      commandCommitted = true;
      if (result.action === "upsertPreference" || result.action === "completePreference" || result.action === "skipPreference") acceptOwnProfile(result.data);
      try {
        const refreshed = await repository.refresh(trip.id);
        if (!isCurrentScope(generation)) return false;
        if (refreshed.tripId !== trip.id) throw new Error("invalid workspace");
        acceptWorkspace(refreshed);
      } catch {
        if (!isCurrentScope(generation)) return false;
        setMessage({ text: "修改已经保存，但暂时无法确认其他成员看到的最新状态。", role: "alert", source: "refresh" });
        return false;
      }
      if (draftRef.current?.conflict) setMessage({ text: "", role: "status", source: "command" });
      else setMessage({ text: "已保存并同步给同行者。", role: "status", source: "command" });
      return true;
    } catch {
      if (!isCurrentScope(generation)) return false;
      setMessage({ text: "保存失败，请检查网络后重试。", role: "alert", source: "command" });
      return false;
    } finally {
      if (isCurrentScope(generation) && operationRef.current === operation) {
        operationRef.current = undefined;
        setBusy(false);
        if (!commandCommitted) requestAnimationFrame(() => {
          if (!isCurrentScope(generation)) return;
          const conflictAction = preferenceFormRef.current?.querySelector<HTMLElement>(".decision-draft-conflict button:not([disabled])");
          const primary = preferenceFormRef.current?.querySelector<HTMLElement>("button[type='submit']:not([disabled])");
          const fallback = conflictAction ?? primary ?? preferenceFormRef.current?.querySelector<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])");
          const triggerAvailable = trigger?.isConnected && !trigger.matches(":disabled") && trigger.tabIndex >= 0;
          (triggerAvailable ? trigger : fallback)?.focus();
        });
      }
    }
  }, [acceptOwnProfile, acceptWorkspace, isCurrentScope, repository, scopeGeneration, trip.id]);

  function updateDraftField(field: PreferenceField, value: string) {
    const current = draftRef.current;
    if (!current) return;
    const values = { ...current.values, [field]: value };
    const dirtyFields = preferenceFields.filter((candidate) => values[candidate] !== current.baseline[candidate]);
    replaceDraft({
      ...current,
      values,
      dirtyFields,
      baseRevision: dirtyFields.length === 0 ? current.latestRevision : current.baseRevision,
      conflict: current.conflict && dirtyFields.length > 0,
    });
  }

  function useLatestPreference() {
    const current = draftRef.current;
    if (!current) return;
    replaceDraft({ values: current.baseline, baseline: current.baseline, dirtyFields: [], baseRevision: current.latestRevision, latestRevision: current.latestRevision, conflict: false });
    setMessage({ text: "已使用最新偏好版本。", role: "status", source: "command" });
  }

  function keepPreferenceChanges() {
    const current = draftRef.current;
    if (!current) return;
    const dirtyFields = preferenceFields.filter((field) => current.values[field] !== current.baseline[field]);
    replaceDraft({ ...current, dirtyFields, baseRevision: current.latestRevision, conflict: false });
    setMessage({ text: "已保留你的修改，并以最新版本继续。", role: "status", source: "command" });
  }

  if (!workspace || !draft) return <main className="decision-page">
    <button className="control-button control-button--text" type="button" onClick={onBack}>返回行程</button>
    {message.text ? <p role={message.role}>{message.text}</p> : null}
    {message.role === "alert" ? <button ref={loadRetryRef} className="control-button control-button--primary" type="button" disabled={refreshing} onClick={() => { void retryInitialLoad(); }}>重新加载共同决定</button> : null}
  </main>;

  const profile = workspace.preferences.find(({ ownerUid }) => ownerUid === member.uid);
  const finishedProfiles = workspace.preferences.filter(({ status }) => status === "completed" || status === "skipped");
  const canGenerateSummary = trip.memberUids?.length === 2 && finishedProfiles.length === 2;
  const viewModel = toDecisionWorkspaceViewModel(workspace, trip, member);

  function savePreference(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const currentDraft = draftRef.current;
    if (!currentDraft || currentDraft.conflict) return;
    const trigger = (event.nativeEvent as SubmitEvent).submitter;
    void runCommand({
      action: "upsertPreference",
      tripId: trip.id,
      expectedRevision: currentDraft.baseRevision,
      idempotencyKey: newIdempotencyKey(),
      answers: {
        pace: currentDraft.values.pace,
        budget: currentDraft.values.budget,
        accommodation: currentDraft.values.accommodation,
        walking: currentDraft.values.walking,
        queue: currentDraft.values.queue,
        dining: currentDraft.values.dining,
        attractions: currentDraft.values.attractions,
      },
      freeText: { mustHave: currentDraft.values.mustHave, mustAvoid: currentDraft.values.mustAvoid, note: currentDraft.values.note },
    }, trigger instanceof HTMLElement ? trigger : undefined);
  }

  const interactionBusy = busy || refreshing;
  const writeDisabled = interactionBusy || draft.conflict;

  return <main className="decision-page">
    <nav className="decision-page-nav" aria-label="决策页面操作">
      <button className="control-button control-button--text" type="button" onClick={onBack}>返回行程</button>
      <span>{member.displayName} · 共同决定</span>
    </nav>

    {member.role === "admin"
      ? <DecisionAgentPanel
          repository={repository}
          bridge={agentBridge}
          trip={trip}
          workspace={workspace}
          onResearchCompleted={retryRefresh}
          newIdempotencyKey={newIdempotencyKey}
        />
      : <DecisionAgentMemberNotice />}

    <form ref={preferenceFormRef} className="decision-preference-form" aria-busy={interactionBusy} onSubmit={savePreference}>
      <div><p>MY PREFERENCE PASS</p><h2>我的五分钟偏好</h2></div>
      <label>旅行节奏<select className="control-field" name="pace" aria-label="旅行节奏" disabled={interactionBusy} value={draft.values.pace} onChange={(event) => updateDraftField("pace", event.currentTarget.value)}><option value="slow">慢慢走</option><option value="balanced">松紧适中</option><option value="fast">尽量多看</option></select></label>
      <label>预算倾向<select className="control-field" name="budget" aria-label="预算倾向" disabled={interactionBusy} value={draft.values.budget} onChange={(event) => updateDraftField("budget", event.currentTarget.value)}><option value="value">性价比</option><option value="mid">舒适平衡</option><option value="experience">体验优先</option></select></label>
      <label>住宿标准<select className="control-field" name="accommodation" aria-label="住宿标准" disabled={interactionBusy} value={draft.values.accommodation} onChange={(event) => updateDraftField("accommodation", event.currentTarget.value)}><option value="value">干净实用</option><option value="comfortable">舒适方便</option><option value="quiet">安静优先</option></select></label>
      <label>步行强度<select className="control-field" name="walking" aria-label="步行强度" disabled={interactionBusy} value={draft.values.walking} onChange={(event) => updateDraftField("walking", event.currentTarget.value)}><option value="light">少走路</option><option value="balanced">适量步行</option><option value="active">可以多走</option></select></label>
      <label>排队接受度<select className="control-field" name="queue" aria-label="排队接受度" disabled={interactionBusy} value={draft.values.queue} onChange={(event) => updateDraftField("queue", event.currentTarget.value)}><option value="none">尽量不排</option><option value="short">短队可以</option><option value="worthwhile">值得就等</option></select></label>
      <label>饮食偏好<input className="control-field" name="dining" aria-label="饮食偏好" disabled={interactionBusy} value={draft.values.dining} onChange={(event) => updateDraftField("dining", event.currentTarget.value)} placeholder="例如：本地小店、清淡" /></label>
      <label>想看的景点<input className="control-field" name="attractions" aria-label="想看的景点" disabled={interactionBusy} value={draft.values.attractions} onChange={(event) => updateDraftField("attractions", event.currentTarget.value)} placeholder="例如：海边、博物馆" /></label>
      <label>一定要有<input className="control-field" name="mustHave" aria-label="一定要有" disabled={interactionBusy} value={draft.values.mustHave} onChange={(event) => updateDraftField("mustHave", event.currentTarget.value)} /></label>
      <label>坚决不要<input className="control-field" name="mustAvoid" aria-label="坚决不要" disabled={interactionBusy} value={draft.values.mustAvoid} onChange={(event) => updateDraftField("mustAvoid", event.currentTarget.value)} /></label>
      <label>补充原因<textarea className="control-field" name="note" aria-label="补充原因" disabled={interactionBusy} value={draft.values.note} onChange={(event) => updateDraftField("note", event.currentTarget.value)} /></label>
      {draft.conflict ? <div className="decision-form-actions decision-draft-conflict" role="alert">
        <p>你的偏好草稿与最新版本有冲突。已保留修改字段，其他字段已更新。</p>
        <button className="control-button control-button--secondary" type="button" disabled={interactionBusy} onClick={useLatestPreference}>使用最新版本</button>
        <button className="control-button control-button--primary" type="button" disabled={interactionBusy} onClick={keepPreferenceChanges}>保留我的修改并继续</button>
      </div> : null}
      <div className="decision-form-actions">
        <button className="control-button control-button--primary" type="submit" disabled={writeDisabled}>保存我的偏好</button>
        <button className="control-button control-button--secondary" type="button" disabled={writeDisabled || !profile} onClick={(event) => profile && void runCommand({ action: "completePreference", tripId: trip.id, expectedRevision: profile.revision, idempotencyKey: newIdempotencyKey() }, event.currentTarget)}>标记已完成</button>
        <button className="control-button control-button--secondary" type="button" disabled={writeDisabled || !profile} onClick={(event) => profile && void runCommand({ action: "skipPreference", tripId: trip.id, expectedRevision: profile.revision, idempotencyKey: newIdempotencyKey() }, event.currentTarget)}>本轮跳过</button>
        <button className="control-button control-button--secondary" type="button" disabled={interactionBusy || !canGenerateSummary} onClick={(event) => void runCommand({ action: "generatePreferenceSummary", tripId: trip.id, sourcePreferenceRevisions: Object.fromEntries(finishedProfiles.map(({ ownerUid, revision }) => [ownerUid, revision])), idempotencyKey: newIdempotencyKey() }, event.currentTarget)}>生成共同摘要</button>
      </div>
    </form>

    {message.text ? <p className="decision-page-message" role={message.role}>{message.text}</p> : null}
    {message.source === "refresh" && message.role === "alert" ? <button className="control-button control-button--secondary" type="button" disabled={refreshing} onClick={() => { void retryRefresh(); }}>重新刷新共同决定</button> : null}
    <DecisionWorkspaceShowcase workspace={viewModel} />

    {workspace.candidates.length > 0 ? <section className="decision-action-desk" aria-labelledby="decision-actions-title" aria-busy={interactionBusy}>
      <h2 id="decision-actions-title">把票根变成共同决定</h2>
      {workspace.candidates.slice(0, 4).map((candidate) => {
        const placement = workspace.placements.find((item) => item.candidateId === candidate.id && item.status !== "detached");
        const ownReceipt = workspace.confirmations.find((item) => item.candidateId === candidate.id && item.memberUid === member.uid);
        const firstDay = trip.days[0];
        return <article key={candidate.id} className="decision-action-row">
          <strong>{candidate.entity.name}</strong>
          <button className="control-button control-button--secondary" type="button" disabled={interactionBusy} onClick={(event) => void runCommand({ action: "recordFeedback", tripId: trip.id, candidateId: candidate.id, kind: "like", idempotencyKey: newIdempotencyKey() }, event.currentTarget)}>喜欢</button>
          <button className="control-button control-button--danger" type="button" disabled={interactionBusy} onClick={(event) => void runCommand({ action: "recordFeedback", tripId: trip.id, candidateId: candidate.id, kind: "dislike", idempotencyKey: newIdempotencyKey() }, event.currentTarget)}>反对</button>
          <button className={`control-button ${placement ? "control-button--secondary" : "control-button--primary"}`} type="button" disabled={interactionBusy || !firstDay || candidate.decisionState === "confirmed"} onClick={(event) => firstDay && void runCommand({ action: "placeTentative", tripId: trip.id, candidateId: candidate.id, expectedCandidateRevision: candidate.revision, placement: { tripDayId: firstDay.id, date: firstDay.date, sortKey: `candidate-${candidate.id}` }, idempotencyKey: newIdempotencyKey() }, event.currentTarget)}>{placement ? "调整暂定日程" : "加入暂定行程"}</button>
          <button className={`control-button ${ownReceipt?.active ? "control-button--danger" : placement ? "control-button--primary" : "control-button--secondary"}`} type="button" disabled={interactionBusy || !placement || candidate.decisionState === "none"} onClick={(event) => void runCommand({ action: "setConfirmationReceipt", tripId: trip.id, candidateId: candidate.id, expectedCandidateRevision: candidate.revision, active: !ownReceipt?.active, idempotencyKey: newIdempotencyKey() }, event.currentTarget)}>{ownReceipt?.active ? "撤回我的确认" : "确认这张票根"}</button>
        </article>;
      })}
    </section> : null}
  </main>;
}
