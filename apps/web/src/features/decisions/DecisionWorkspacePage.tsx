import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { DecisionCommand, DecisionWorkspace, DecisionWorkspaceRepository, Member, Trip } from "@travel/contracts";
import { DecisionWorkspaceShowcase } from "./DecisionWorkspaceShowcase";
import { toDecisionWorkspaceViewModel } from "./decisionWorkspaceAdapter";

type Props = {
  repository: DecisionWorkspaceRepository;
  trip: Trip;
  member: Member;
  onBack: () => void;
  newIdempotencyKey?: () => string;
};

type MessageState = {
  text: string;
  role: "status" | "alert";
  source: "load" | "command";
};

function defaultIdempotencyKey() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `decision-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function DecisionWorkspacePage({ repository, trip, member, onBack, newIdempotencyKey = defaultIdempotencyKey }: Props) {
  const [workspace, setWorkspace] = useState<DecisionWorkspace>();
  const [message, setMessage] = useState<MessageState>({ text: "正在读取共同决定…", role: "status", source: "load" });
  const [busy, setBusy] = useState(false);
  const preferenceFormRef = useRef<HTMLFormElement>(null);

  const refresh = useCallback(async () => {
    try {
      const loaded = await repository.load(trip.id);
      setWorkspace(loaded);
      setMessage({ text: "", role: "status", source: "load" });
    } catch {
      setMessage({ text: "共同决定暂时无法加载，请检查网络后重试。", role: "alert", source: "load" });
    }
  }, [repository, trip.id]);

  useEffect(() => {
    let active = true;
    void repository.load(trip.id).then((loaded) => {
      if (active) { setWorkspace(loaded); setMessage({ text: "", role: "status", source: "load" }); }
    }).catch(() => { if (active) setMessage({ text: "共同决定暂时无法加载，请检查网络后重试。", role: "alert", source: "load" }); });
    const unsubscribe = repository.subscribe(trip.id, (next) => {
      if (!active) return;
      setWorkspace(next);
      setMessage((current) => current.source === "load" ? { text: "", role: "status", source: "load" } : current);
    });
    return () => { active = false; unsubscribe(); };
  }, [repository, trip.id]);

  const runCommand = useCallback(async (command: DecisionCommand, trigger?: HTMLElement) => {
    let succeeded = false;
    setBusy(true);
    setMessage({ text: "正在保存共同决定…", role: "status", source: "command" });
    try {
      const result = await repository.command(command);
      if (!result.ok) {
        setMessage({ text: result.error === "VERSION_CONFLICT" ? "内容已被同行者更新，请查看最新版本后再试。" : `保存失败：${result.error}`, role: "alert", source: "command" });
        return false;
      }
      await refresh();
      succeeded = true;
      setMessage({ text: "已保存并同步给同行者。", role: "status", source: "command" });
      return true;
    } catch {
      setMessage({ text: "保存失败，请检查网络后重试。", role: "alert", source: "command" });
      return false;
    } finally {
      setBusy(false);
      if (!succeeded) requestAnimationFrame(() => {
        const primary = preferenceFormRef.current?.querySelector<HTMLElement>("button[type='submit']:not([disabled])");
        const fallback = primary ?? preferenceFormRef.current?.querySelector<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])");
        (trigger?.isConnected ? trigger : fallback)?.focus();
      });
    }
  }, [refresh, repository]);

  if (!workspace) return <main className="decision-page"><button className="control-button control-button--text" type="button" onClick={onBack}>返回行程</button>{message.text ? <p role={message.role}>{message.text}</p> : null}</main>;

  const profile = workspace.preferences.find(({ ownerUid }) => ownerUid === member.uid);
  const finishedProfiles = workspace.preferences.filter(({ status }) => status === "completed" || status === "skipped");
  const canGenerateSummary = trip.memberUids?.length === 2 && finishedProfiles.length === 2;
  const viewModel = toDecisionWorkspaceViewModel(workspace, trip, member);

  function savePreference(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const trigger = (event.nativeEvent as SubmitEvent).submitter;
    void runCommand({
      action: "upsertPreference",
      tripId: trip.id,
      expectedRevision: profile?.revision ?? 0,
      idempotencyKey: newIdempotencyKey(),
      answers: {
        pace: String(form.get("pace") ?? ""),
        budget: String(form.get("budget") ?? ""),
        accommodation: String(form.get("accommodation") ?? ""),
        walking: String(form.get("walking") ?? ""),
        queue: String(form.get("queue") ?? ""),
        dining: String(form.get("dining") ?? ""),
        attractions: String(form.get("attractions") ?? ""),
      },
      freeText: { mustHave: String(form.get("mustHave") ?? ""), mustAvoid: String(form.get("mustAvoid") ?? ""), note: String(form.get("note") ?? "") },
    }, trigger instanceof HTMLElement ? trigger : undefined);
  }

  return <main className="decision-page">
    <nav className="decision-page-nav" aria-label="决策页面操作">
      <button className="control-button control-button--text" type="button" onClick={onBack}>返回行程</button>
      <span>{member.displayName} · 共同决定</span>
    </nav>

    <form ref={preferenceFormRef} className="decision-preference-form" key={profile?.revision ?? 0} aria-busy={busy} onSubmit={savePreference}>
      <div><p>MY PREFERENCE PASS</p><h2>我的五分钟偏好</h2></div>
      <label>旅行节奏<select className="control-field" name="pace" aria-label="旅行节奏" disabled={busy} defaultValue={String(profile?.answers.pace ?? "slow")}><option value="slow">慢慢走</option><option value="balanced">松紧适中</option><option value="fast">尽量多看</option></select></label>
      <label>预算倾向<select className="control-field" name="budget" aria-label="预算倾向" disabled={busy} defaultValue={String(profile?.answers.budget ?? "mid")}><option value="value">性价比</option><option value="mid">舒适平衡</option><option value="experience">体验优先</option></select></label>
      <label>住宿标准<select className="control-field" name="accommodation" aria-label="住宿标准" disabled={busy} defaultValue={String(profile?.answers.accommodation ?? "comfortable")}><option value="value">干净实用</option><option value="comfortable">舒适方便</option><option value="quiet">安静优先</option></select></label>
      <label>步行强度<select className="control-field" name="walking" aria-label="步行强度" disabled={busy} defaultValue={String(profile?.answers.walking ?? "balanced")}><option value="light">少走路</option><option value="balanced">适量步行</option><option value="active">可以多走</option></select></label>
      <label>排队接受度<select className="control-field" name="queue" aria-label="排队接受度" disabled={busy} defaultValue={String(profile?.answers.queue ?? "short")}><option value="none">尽量不排</option><option value="short">短队可以</option><option value="worthwhile">值得就等</option></select></label>
      <label>饮食偏好<input className="control-field" name="dining" aria-label="饮食偏好" disabled={busy} defaultValue={String(profile?.answers.dining ?? "")} placeholder="例如：本地小店、清淡" /></label>
      <label>想看的景点<input className="control-field" name="attractions" aria-label="想看的景点" disabled={busy} defaultValue={String(profile?.answers.attractions ?? "")} placeholder="例如：海边、博物馆" /></label>
      <label>一定要有<input className="control-field" name="mustHave" aria-label="一定要有" disabled={busy} defaultValue={profile?.freeText?.mustHave ?? ""} /></label>
      <label>坚决不要<input className="control-field" name="mustAvoid" aria-label="坚决不要" disabled={busy} defaultValue={profile?.freeText?.mustAvoid ?? ""} /></label>
      <label>补充原因<textarea className="control-field" name="note" aria-label="补充原因" disabled={busy} defaultValue={profile?.freeText?.note ?? ""} /></label>
      <div className="decision-form-actions">
        <button className="control-button control-button--primary" type="submit" disabled={busy}>保存我的偏好</button>
        <button className="control-button control-button--secondary" type="button" disabled={busy || !profile} onClick={(event) => profile && void runCommand({ action: "completePreference", tripId: trip.id, expectedRevision: profile.revision, idempotencyKey: newIdempotencyKey() }, event.currentTarget)}>标记已完成</button>
        <button className="control-button control-button--secondary" type="button" disabled={busy || !profile} onClick={(event) => profile && void runCommand({ action: "skipPreference", tripId: trip.id, expectedRevision: profile.revision, idempotencyKey: newIdempotencyKey() }, event.currentTarget)}>本轮跳过</button>
        <button className="control-button control-button--secondary" type="button" disabled={busy || !canGenerateSummary} onClick={(event) => void runCommand({ action: "generatePreferenceSummary", tripId: trip.id, sourcePreferenceRevisions: Object.fromEntries(finishedProfiles.map(({ ownerUid, revision }) => [ownerUid, revision])), idempotencyKey: newIdempotencyKey() }, event.currentTarget)}>生成共同摘要</button>
      </div>
    </form>

    {message.text ? <p className="decision-page-message" role={message.role}>{message.text}</p> : null}
    <DecisionWorkspaceShowcase workspace={viewModel} />

    {workspace.candidates.length > 0 ? <section className="decision-action-desk" aria-labelledby="decision-actions-title" aria-busy={busy}>
      <h2 id="decision-actions-title">把票根变成共同决定</h2>
      {workspace.candidates.slice(0, 4).map((candidate) => {
        const placement = workspace.placements.find((item) => item.candidateId === candidate.id && item.status !== "detached");
        const ownReceipt = workspace.confirmations.find((item) => item.candidateId === candidate.id && item.memberUid === member.uid);
        const firstDay = trip.days[0];
        return <article key={candidate.id} className="decision-action-row">
          <strong>{candidate.entity.name}</strong>
          <button className="control-button control-button--secondary" type="button" disabled={busy} onClick={(event) => void runCommand({ action: "recordFeedback", tripId: trip.id, candidateId: candidate.id, kind: "like", idempotencyKey: newIdempotencyKey() }, event.currentTarget)}>喜欢</button>
          <button className="control-button control-button--danger" type="button" disabled={busy} onClick={(event) => void runCommand({ action: "recordFeedback", tripId: trip.id, candidateId: candidate.id, kind: "dislike", idempotencyKey: newIdempotencyKey() }, event.currentTarget)}>反对</button>
          <button className={`control-button ${placement ? "control-button--secondary" : "control-button--primary"}`} type="button" disabled={busy || !firstDay || candidate.decisionState === "confirmed"} onClick={(event) => firstDay && void runCommand({ action: "placeTentative", tripId: trip.id, candidateId: candidate.id, expectedCandidateRevision: candidate.revision, placement: { tripDayId: firstDay.id, date: firstDay.date, sortKey: `candidate-${candidate.id}` }, idempotencyKey: newIdempotencyKey() }, event.currentTarget)}>{placement ? "调整暂定日程" : "加入暂定行程"}</button>
          <button className={`control-button ${ownReceipt?.active ? "control-button--danger" : placement ? "control-button--primary" : "control-button--secondary"}`} type="button" disabled={busy || !placement || candidate.decisionState === "none"} onClick={(event) => void runCommand({ action: "setConfirmationReceipt", tripId: trip.id, candidateId: candidate.id, expectedCandidateRevision: candidate.revision, active: !ownReceipt?.active, idempotencyKey: newIdempotencyKey() }, event.currentTarget)}>{ownReceipt?.active ? "撤回我的确认" : "确认这张票根"}</button>
        </article>;
      })}
    </section> : null}
  </main>;
}
