import type { ResearchDisclosure } from "@travel/contracts";

const categoryCopy = { hotel: "酒店", restaurant: "餐厅", attraction: "景点" } as const;
const feedbackCopy = { like: "喜欢", dislike: "反对", comment: "留言" } as const;
const sourceKindCopy = { flyai: "FlyAI", amap: "高德", web: "网页", official: "官方", manual: "手动记录" } as const;
const captureMethodCopy = { detail_page: "详情页", search_result: "搜索结果", api_result: "API 结果", manual: "手动记录" } as const;
const factLabel: Record<string, string> = {
  propertyName: "住宿名称", name: "名称", address: "地址", checkInDate: "入住日期", checkOutDate: "离店日期",
  travelers: "人数", roomTypeOrBed: "房型或床型", availability: "可订状态", priceAmount: "价格", currency: "币种",
  priceDisplay: "价格口径", cancellationPolicy: "取消政策", openInformation: "营业信息", priceSnapshot: "价格摘要", ticketType: "票种",
};

function answerText(answers: ResearchDisclosure["preferences"][number]["answers"]) {
  return Object.entries(answers).map(([key, value]) => `${key}：${Array.isArray(value) ? value.join("、") : String(value)}`).join("；");
}

function applicabilityText(candidate: ResearchDisclosure["existingCandidates"][number]) {
  const parts: string[] = [];
  if (candidate.applicability.dates) parts.push(`${candidate.applicability.dates.start} 至 ${candidate.applicability.dates.end}`);
  if (candidate.applicability.travelers !== undefined) parts.push(`${candidate.applicability.travelers} 人`);
  return parts.join(" · ");
}

function queryText(evidence: ResearchDisclosure["existingCandidates"][number]["evidence"][number]) {
  const parts: string[] = [];
  if (evidence.queryContext.dates) parts.push(`${evidence.queryContext.dates.start} 至 ${evidence.queryContext.dates.end}`);
  if (evidence.queryContext.travelers !== undefined) parts.push(`${evidence.queryContext.travelers} 人`);
  if (evidence.queryContext.roomOrTicket) parts.push(evidence.queryContext.roomOrTicket);
  return parts.join(" · ");
}

type Props = {
  disclosure: ResearchDisclosure;
  confirmed: boolean;
  disabled: boolean;
  onConfirmedChange: (confirmed: boolean) => void;
};

export function DecisionResearchDisclosure({ disclosure, confirmed, disabled, onConfirmedChange }: Props) {
  return <details className="decision-research-disclosure" open>
    <summary>本次将发送给 Codex</summary>
    <div className="decision-research-disclosure__body">
      <dl>
        <div><dt>行程段</dt><dd>{disclosure.segment.city} · {disclosure.segment.startDate} 至 {disclosure.segment.endDate} · {disclosure.segment.travelerCount} 人</dd></div>
        <div><dt>研究类别</dt><dd>{categoryCopy[disclosure.category]}</dd></div>
        <div><dt>成员姓名</dt><dd>{disclosure.travelerNames.join("、")}</dd></div>
      </dl>

      <section aria-labelledby="decision-disclosure-preferences">
        <h3 id="decision-disclosure-preferences">双方已完成偏好</h3>
        {disclosure.preferences.length > 0 ? <ul>{disclosure.preferences.map((preference, index) => <li key={index}>
          {answerText(preference.answers)}
          {preference.freeText?.mustHave ? `；一定要有：${preference.freeText.mustHave}` : ""}
          {preference.freeText?.mustAvoid ? `；坚决不要：${preference.freeText.mustAvoid}` : ""}
          {preference.freeText?.note ? `；补充：${preference.freeText.note}` : ""}
        </li>)}</ul> : <p>暂无已完成偏好</p>}
      </section>

      <section aria-labelledby="decision-disclosure-summary">
        <h3 id="decision-disclosure-summary">当前共同摘要</h3>
        {disclosure.summary ? <>
          <p>摘要状态：{disclosure.summary.status === "ready" ? "已更新" : "待更新"}</p>
          {disclosure.summary.common.map((item) => <p key={`common-${item}`}>{item}</p>)}
          {disclosure.summary.disagreements.map((item) => <p key={`different-${item}`}>分歧：{item}</p>)}
          {disclosure.summary.tradeoffs.map((item) => <p key={`tradeoff-${item}`}>取舍：{item}</p>)}
        </> : <p>暂无共同摘要</p>}
      </section>

      <section aria-labelledby="decision-disclosure-feedback">
        <h3 id="decision-disclosure-feedback">相关反馈</h3>
        {disclosure.feedback.length > 0 ? <ul>{disclosure.feedback.map((item, index) => <li key={index}>{item.candidateName} · {feedbackCopy[item.kind]}{item.reason ? ` · ${item.reason}` : ""}</li>)}</ul> : <p>暂无相关反馈</p>}
      </section>

      <section aria-labelledby="decision-disclosure-candidates">
        <h3 id="decision-disclosure-candidates">已有候选摘要</h3>
        {disclosure.existingCandidates.length > 0 ? <ul className="decision-research-disclosure__candidates">{disclosure.existingCandidates.map((candidate, index) => <li key={index}>
          <p className="decision-research-disclosure__candidate-title">{candidate.entity.name}{candidate.entity.address ? ` · ${candidate.entity.address}` : ""} · {categoryCopy[candidate.category]} · {candidate.recommendation.reason}</p>
          {applicabilityText(candidate) ? <p>适用：{applicabilityText(candidate)}</p> : null}
          {candidate.evidence.length > 0 ? <ul className="decision-research-disclosure__evidence">{candidate.evidence.map((evidence, evidenceIndex) => <li key={evidenceIndex}>
            <strong>{evidence.sourceName}</strong> · {sourceKindCopy[evidence.sourceKind]} · {captureMethodCopy[evidence.captureMethod]}
            {evidence.sourceUrl ? <p>来源：<a href={evidence.sourceUrl} target="_blank" rel="noreferrer">{evidence.sourceUrl}</a></p> : null}
            {queryText(evidence) ? <p>查询条件：{queryText(evidence)}</p> : null}
            <dl className="decision-research-disclosure__facts">{Object.entries(evidence.facts).map(([key, value]) => <div key={key}><dt>{factLabel[key] ?? key}</dt><dd>{String(value)}</dd></div>)}</dl>
          </li>)}</ul> : null}
        </li>)}</ul> : <p>本类别暂无已有候选</p>}
      </section>

      <p className="decision-research-disclosure__history">本次研究会保存在设备所有者的本机 Codex 历史中。</p>
      <label className="decision-research-disclosure__confirmation">
        <input type="checkbox" checked={confirmed} disabled={disabled} onChange={(event) => onConfirmedChange(event.currentTarget.checked)} />
        <span>我确认以上授权范围，并同意将这些内容发送给本机 Codex 完成本次研究</span>
      </label>
    </div>
  </details>;
}
