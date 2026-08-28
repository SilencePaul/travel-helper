import { useCallback, useEffect, useState, type FormEvent } from "react";
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

function defaultIdempotencyKey() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `decision-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function DecisionWorkspacePage({ repository, trip, member, onBack, newIdempotencyKey = defaultIdempotencyKey }: Props) {
  const [workspace, setWorkspace] = useState<DecisionWorkspace>();
  const [message, setMessage] = useState("正在读取共同决定…");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const loaded = await repository.load(trip.id);
      setWorkspace(loaded);
      setMessage("");
    } catch {
      setMessage("共同决定暂时无法加载，请检查网络后重试。");
    }
  }, [repository, trip.id]);

  useEffect(() => {
    let active = true;
    void repository.load(trip.id).then((loaded) => {
      if (active) { setWorkspace(loaded); setMessage(""); }
    }).catch(() => { if (active) setMessage("共同决定暂时无法加载，请检查网络后重试。"); });
    const unsubscribe = repository.subscribe(trip.id, (next) => { if (active) setWorkspace(next); });
    return () => { active = false; unsubscribe(); };
  }, [repository, trip.id]);

  const runCommand = useCallback(async (command: DecisionCommand) => {
    setBusy(true);
    setMessage("正在保存共同决定…");
    try {
      const result = await repository.command(command);
      if (!result.ok) {
        setMessage(result.error === "VERSION_CONFLICT" ? "内容已被同行者更新，请查看最新版本后再试。" : `保存失败：${result.error}`);
        return false;
      }
      await refresh();
      setMessage("已保存并同步给同行者。");
      return true;
    } catch {
      setMessage("保存失败，请检查网络后重试。");
      return false;
    } finally {
      setBusy(false);
    }
  }, [refresh, repository]);

  if (!workspace) return <main className="decision-page"><button type="button" onClick={onBack}>返回行程</button><p role="status">{message}</p></main>;

  const profile = workspace.preferences.find(({ ownerUid }) => ownerUid === member.uid);
  const finishedProfiles = workspace.preferences.filter(({ status }) => status === "completed" || status === "skipped");
  const canGenerateSummary = trip.memberUids?.length === 2 && finishedProfiles.length === 2;
  const viewModel = toDecisionWorkspaceViewModel(workspace, trip, member);

  function savePreference(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
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
    });
  }

  return <main className="decision-page">
    <nav className="decision-page-nav" aria-label="决策页面操作">
      <button type="button" onClick={onBack}>返回行程</button>
      <span>{member.displayName} · 共同决定</span>
    </nav>

    <form className="decision-preference-form" key={profile?.revision ?? 0} onSubmit={savePreference}>
      <div><p>MY PREFERENCE PASS</p><h2>我的五分钟偏好</h2></div>
      <label>旅行节奏<select name="pace" aria-label="旅行节奏" defaultValue={String(profile?.answers.pace ?? "slow")}><option value="slow">慢慢走</option><option value="balanced">松紧适中</option><option value="fast">尽量多看</option></select></label>
      <label>预算倾向<select name="budget" aria-label="预算倾向" defaultValue={String(profile?.answers.budget ?? "mid")}><option value="value">性价比</option><option value="mid">舒适平衡</option><option value="experience">体验优先</option></select></label>
      <label>住宿标准<select name="accommodation" aria-label="住宿标准" defaultValue={String(profile?.answers.accommodation ?? "comfortable")}><option value="value">干净实用</option><option value="comfortable">舒适方便</option><option value="quiet">安静优先</option></select></label>
      <label>步行强度<select name="walking" aria-label="步行强度" defaultValue={String(profile?.answers.walking ?? "balanced")}><option value="light">少走路</option><option value="balanced">适量步行</option><option value="active">可以多走</option></select></label>
      <label>排队接受度<select name="queue" aria-label="排队接受度" defaultValue={String(profile?.answers.queue ?? "short")}><option value="none">尽量不排</option><option value="short">短队可以</option><option value="worthwhile">值得就等</option></select></label>
      <label>饮食偏好<input name="dining" aria-label="饮食偏好" defaultValue={String(profile?.answers.dining ?? "")} placeholder="例如：本地小店、清淡" /></label>
      <label>想看的景点<input name="attractions" aria-label="想看的景点" defaultValue={String(profile?.answers.attractions ?? "")} placeholder="例如：海边、博物馆" /></label>
      <label>一定要有<input name="mustHave" aria-label="一定要有" defaultValue={profile?.freeText?.mustHave ?? ""} /></label>
      <label>坚决不要<input name="mustAvoid" aria-label="坚决不要" defaultValue={profile?.freeText?.mustAvoid ?? ""} /></label>
      <label>补充原因<textarea name="note" aria-label="补充原因" defaultValue={profile?.freeText?.note ?? ""} /></label>
      <div className="decision-form-actions">
        <button type="submit" disabled={busy}>保存我的偏好</button>
        <button type="button" disabled={busy || !profile} onClick={() => profile && void runCommand({ action: "completePreference", tripId: trip.id, expectedRevision: profile.revision, idempotencyKey: newIdempotencyKey() })}>标记已完成</button>
        <button type="button" disabled={busy || !profile} onClick={() => profile && void runCommand({ action: "skipPreference", tripId: trip.id, expectedRevision: profile.revision, idempotencyKey: newIdempotencyKey() })}>本轮跳过</button>
        <button type="button" disabled={busy || !canGenerateSummary} onClick={() => void runCommand({ action: "generatePreferenceSummary", tripId: trip.id, sourcePreferenceRevisions: Object.fromEntries(finishedProfiles.map(({ ownerUid, revision }) => [ownerUid, revision])), idempotencyKey: newIdempotencyKey() })}>生成共同摘要</button>
      </div>
    </form>

    {message ? <p className="decision-page-message" role="status">{message}</p> : null}
    <DecisionWorkspaceShowcase workspace={viewModel} />

    {workspace.candidates.length > 0 ? <section className="decision-action-desk" aria-labelledby="decision-actions-title">
      <h2 id="decision-actions-title">把票根变成共同决定</h2>
      {workspace.candidates.slice(0, 4).map((candidate) => {
        const placement = workspace.placements.find((item) => item.candidateId === candidate.id && item.status !== "detached");
        const ownReceipt = workspace.confirmations.find((item) => item.candidateId === candidate.id && item.memberUid === member.uid);
        const firstDay = trip.days[0];
        return <article key={candidate.id} className="decision-action-row">
          <strong>{candidate.entity.name}</strong>
          <button type="button" disabled={busy} onClick={() => void runCommand({ action: "recordFeedback", tripId: trip.id, candidateId: candidate.id, kind: "like", idempotencyKey: newIdempotencyKey() })}>喜欢</button>
          <button type="button" disabled={busy} onClick={() => void runCommand({ action: "recordFeedback", tripId: trip.id, candidateId: candidate.id, kind: "dislike", idempotencyKey: newIdempotencyKey() })}>反对</button>
          <button type="button" disabled={busy || !firstDay || candidate.decisionState === "confirmed"} onClick={() => firstDay && void runCommand({ action: "placeTentative", tripId: trip.id, candidateId: candidate.id, expectedCandidateRevision: candidate.revision, placement: { tripDayId: firstDay.id, date: firstDay.date, sortKey: `candidate-${candidate.id}` }, idempotencyKey: newIdempotencyKey() })}>{placement ? "调整暂定日程" : "加入暂定行程"}</button>
          <button type="button" disabled={busy || !placement || candidate.decisionState === "none"} onClick={() => void runCommand({ action: "setConfirmationReceipt", tripId: trip.id, candidateId: candidate.id, expectedCandidateRevision: candidate.revision, active: !ownReceipt?.active, idempotencyKey: newIdempotencyKey() })}>{ownReceipt?.active ? "撤回我的确认" : "确认这张票根"}</button>
        </article>;
      })}
    </section> : null}
  </main>;
}
