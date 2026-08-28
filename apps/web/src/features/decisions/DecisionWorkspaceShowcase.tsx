import type {
  CandidateFeedbackViewModel,
  DecisionCandidateViewModel,
  DecisionWorkspaceViewModel,
  PreferenceCompletion,
  VerificationPresentationState,
} from "./decisionWorkspaceViewModel";
import "./decisionWorkspace.css";

type Props = { workspace: DecisionWorkspaceViewModel };

const preferenceStatus: Record<PreferenceCompletion, string> = {
  editing: "填写中",
  completed: "已完成",
  skipped: "已跳过",
};

const verificationLabel: Record<VerificationPresentationState, string> = {
  candidate: "候选快照",
  web_verified: "网页已核验",
  needs_takeover: "需要你接管网页核验",
  stale: "快照已过期",
};

const feedbackLabel: Record<CandidateFeedbackViewModel["kind"], string> = {
  like: "喜欢",
  dislike: "反对",
  comment: "留言",
};

function dateStamp(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "long", timeZone: "UTC" }).format(new Date(value));
}

function confirmationCopy(candidate: DecisionCandidateViewModel) {
  if (candidate.decisionState === "confirmed") return "双方已确认";
  if (!candidate.confirmations) return "尚未加入共同决定";
  const confirmed = candidate.confirmations.confirmedBy.map((name) => `${name}已确认`);
  const awaiting = candidate.confirmations.awaiting.map((name) => `等待${name}确认`);
  return [...confirmed, ...awaiting].join(" · ");
}

function CandidateTicket({ candidate }: { candidate: DecisionCandidateViewModel }) {
  return <article className={`decision-candidate-ticket decision-candidate-ticket--${candidate.verificationState}`} data-testid="decision-candidate-ticket">
    <header className="decision-ticket-header">
      <span>{candidate.category === "hotel" ? "STAY PASS" : candidate.category === "restaurant" ? "TABLE NOTE" : "ENTRY PASS"}</span>
      <span className="decision-verification-stamp">{verificationLabel[candidate.verificationState]}</span>
    </header>
    <h3>{candidate.name}</h3>
    <p className="decision-ticket-location">{candidate.location}</p>
    <p className="decision-ticket-applicability">{candidate.applicability}</p>
    <p className="decision-recommendation">“{candidate.recommendation}”</p>
    <dl className="decision-evidence">
      <div><dt>来源</dt><dd>来源 · {candidate.evidence.source}</dd></div>
      <div><dt>最后核验</dt><dd>最后核验 · {dateStamp(candidate.evidence.capturedAt)}</dd></div>
      <div><dt>动态快照</dt><dd>{candidate.evidence.snapshot}</dd></div>
    </dl>
    {candidate.feedback.length > 0 ? <ul className="decision-feedback-list" aria-label={`${candidate.name} 的成员反馈`}>
      {candidate.feedback.map((feedback, index) => <li key={`${feedback.traveler}-${index}`}>{feedback.traveler} · {feedbackLabel[feedback.kind]}{feedback.note ? ` · ${feedback.note}` : ""}</li>)}
    </ul> : <p className="decision-feedback-empty">还没有留下同行反馈</p>}
    {candidate.placement ? <p className="decision-placement">暂定日程 · {candidate.placement}</p> : null}
    <footer className={`decision-confirmation decision-confirmation--${candidate.decisionState}`}>
      {confirmationCopy(candidate)}
    </footer>
  </article>;
}

export function DecisionWorkspaceShowcase({ workspace }: Props) {
  const candidates = workspace.candidates.slice(0, 4);

  return <section className="decision-workspace" aria-labelledby="decision-workspace-title">
    <header className="decision-workspace-heading">
      <p>DECISION DESK · PRIVATE JOURNEY</p>
      <h2 id="decision-workspace-title">两个人的偏好，正在汇成一张路线</h2>
      <span>每一张票根都保留来源、时间与彼此的决定。</span>
    </header>

    <section className="decision-preferences" aria-labelledby="decision-preferences-title">
      <div className="decision-section-heading"><p>01 · 公开偏好</p><h3 id="decision-preferences-title">先看见彼此，再一起决定</h3></div>
      <div className="decision-preference-grid">
        {workspace.travelers.map((traveler) => <article className="decision-preference-ticket" key={traveler.id}>
          <p>{traveler.name} · {preferenceStatus[traveler.status]}</p>
          <time dateTime={traveler.updatedAt}>更新于 {dateStamp(traveler.updatedAt)}</time>
          <ul>{traveler.preferences.map((preference) => <li key={preference}>{preference}</li>)}</ul>
          {traveler.mustHave ? <span>一定要有 · {traveler.mustHave}</span> : null}
          {traveler.mustAvoid ? <span>尽量避开 · {traveler.mustAvoid}</span> : null}
        </article>)}
      </div>
    </section>

    {workspace.summary ? <section className={`decision-summary decision-summary--${workspace.summary.status}`} aria-labelledby="decision-summary-title">
      <div className="decision-section-heading"><p>02 · 共同读本</p><h3 id="decision-summary-title">{workspace.summary.status === "ready" ? "共同偏好与需要讨论的地方" : "偏好已更新，摘要等待重算"}</h3></div>
      {workspace.summary.status === "ready" ? <div className="decision-summary-columns">
        <div><h4>共同偏好</h4>{workspace.summary.common.map((item) => <p key={item}>{item}</p>)}</div>
        <div><h4>待讨论</h4>{workspace.summary.disagreements.map((item) => <p key={item}>{item}</p>)}</div>
        <div><h4>建议取舍</h4>{workspace.summary.tradeoffs.map((item) => <p key={item}>{item}</p>)}</div>
      </div> : null}
    </section> : null}

    <section className="decision-proposals" aria-labelledby="decision-proposals-title">
      <div className="decision-section-heading"><p>03 · 证据票根</p><h3 id="decision-proposals-title">这一轮，只留下值得一起看的候选</h3></div>
      <p className="decision-proposals-note">每轮最多四项；价格、营业与库存均为带时间的快照。</p>
      <div className="decision-candidate-rail">{candidates.map((candidate) => <CandidateTicket candidate={candidate} key={candidate.id} />)}</div>
    </section>
  </section>;
}
