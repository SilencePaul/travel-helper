import type { DecisionWorkspace, EvidenceSnapshot, Member, Trip } from "@travel/contracts";
import type { DecisionWorkspaceViewModel } from "./decisionWorkspaceViewModel";

const verificationBlockCopy = {
  login: "网页需要登录",
  captcha: "网页要求验证码",
  risk_control: "网页触发风险控制",
  load_failed: "网页加载失败",
  field_missing: "网页缺少必要字段",
} as const;

function displayValue(value: string | string[] | number | boolean | null) {
  if (Array.isArray(value)) return value.join("、");
  if (value === null) return "未填写";
  if (typeof value === "boolean") return value ? "是" : "否";
  return String(value);
}

function evidenceSnapshot(evidence: EvidenceSnapshot | undefined) {
  if (!evidence) return "尚无可显示的来源快照";
  const facts = evidence.facts;
  if ("priceAmount" in facts) {
    const price = facts.priceAmount === "not_provided" ? "价格未提供" : `${facts.currency} ${facts.priceAmount}`;
    return `${price} · ${facts.roomTypeOrBed} · ${facts.cancellationPolicy}`;
  }
  const parts = [facts.priceSnapshot, facts.openInformation];
  if ("ticketType" in facts) parts.push(facts.ticketType);
  return parts.join(" · ");
}

export function toDecisionWorkspaceViewModel(workspace: DecisionWorkspace, trip: Trip, member?: Member): DecisionWorkspaceViewModel {
  const memberUids = trip.memberUids?.length ? trip.memberUids : workspace.preferences.map(({ ownerUid }) => ownerUid);
  const travelerNames = new Map(trip.travelers.map((traveler) => [traveler.id, traveler.name]));
  const nameFor = (uid: string) => travelerNames.get(uid) ?? (uid === member?.uid ? member.displayName : "同行者");
  const preferencesByOwner = new Map(workspace.preferences.map((profile) => [profile.ownerUid, profile]));

  return {
    travelers: memberUids.map((uid) => {
      const profile = preferencesByOwner.get(uid);
      return {
        id: uid,
        name: nameFor(uid),
        status: profile?.status ?? "editing",
        updatedAt: profile?.updatedAt ?? workspace.fetchedAt,
        preferences: profile ? Object.entries(profile.answers).map(([key, value]) => `${key} · ${displayValue(value)}`) : [],
        ...(profile?.freeText?.mustHave ? { mustHave: profile.freeText.mustHave } : {}),
        ...(profile?.freeText?.mustAvoid ? { mustAvoid: profile.freeText.mustAvoid } : {}),
      };
    }),
    ...(workspace.summary ? { summary: {
      status: workspace.summary.status,
      common: workspace.summary.common,
      disagreements: workspace.summary.disagreements,
      tradeoffs: workspace.summary.tradeoffs,
    } } : {}),
    candidates: workspace.candidates.map((candidate) => {
      const evidence = workspace.evidence.find(({ id }) => id === candidate.currentEvidenceId)
        ?? workspace.evidence.filter(({ candidateId }) => candidateId === candidate.id).at(-1);
      const feedback = workspace.feedback.filter(({ candidateId }) => candidateId === candidate.id);
      const placement = workspace.placements.find(({ candidateId, status }) => candidateId === candidate.id && status !== "detached");
      const activeConfirmationUids = workspace.confirmations.filter(({ candidateId, active }) => candidateId === candidate.id && active).map(({ memberUid }) => memberUid);
      const dayIndex = placement ? trip.days.findIndex(({ id }) => id === placement.tripDayId) : -1;
      const dates = candidate.applicability.dates;
      const applicability = [dates ? `${dates.start}–${dates.end}` : undefined, candidate.applicability.travelers ? `${candidate.applicability.travelers} 人` : undefined].filter(Boolean).join(" · ");
      return {
        id: candidate.id,
        category: candidate.category,
        name: candidate.entity.name,
        location: candidate.entity.address ?? "位置待补充",
        applicability: applicability || "适用条件待补充",
        recommendation: candidate.recommendation.reason,
        verificationState: candidate.verificationState,
        ...(candidate.verificationBlockReason ? {
          verificationBlockReason: verificationBlockCopy[candidate.verificationBlockReason],
          takeoverGuidance: "请在本机浏览器完成验证后，让 Agent 重试网页核验。",
        } : {}),
        decisionState: candidate.decisionState,
        evidence: {
          source: evidence?.sourceName ?? "来源待补充",
          capturedAt: evidence?.capturedAt ?? candidate.updatedAt,
          snapshot: evidenceSnapshot(evidence),
        },
        feedback: feedback.map((item) => ({ traveler: nameFor(item.actorUid), kind: item.kind, ...(item.reason ? { note: item.reason } : {}) })),
        ...(placement ? { placement: `${dayIndex >= 0 ? `D${dayIndex + 1}` : placement.date} · ${trip.days[dayIndex]?.city ?? placement.date} · ${placement.status === "linked" ? "已写入行程" : "暂定"}` } : {}),
        ...(placement ? { confirmations: {
          confirmedBy: activeConfirmationUids.map(nameFor),
          awaiting: memberUids.filter((uid) => !activeConfirmationUids.includes(uid)).map(nameFor),
        } } : {}),
      };
    }),
  };
}
