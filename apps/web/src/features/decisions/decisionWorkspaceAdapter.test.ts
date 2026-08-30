import { describe, expect, it } from "vitest";
import type { DecisionWorkspace, Member, Trip } from "@travel/contracts";
import { toDecisionWorkspaceViewModel } from "./decisionWorkspaceAdapter";

const trip = {
  id: "trip-1", title: "双人旅行", startDate: "2026-10-01", endDate: "2026-10-02",
  travelers: [{ id: "fs_admin", name: "一鸣" }, { id: "fs_member", name: "美垚" }],
  days: [{ id: "day-1", date: "2026-10-01", city: "香港", itemIds: [] }],
  unscheduledItemIds: [], orders: [], memberUids: ["fs_admin", "fs_member"], version: 1,
} satisfies Trip;
const member = { uid: "fs_admin", displayName: "一鸣", role: "admin", version: 1, createdAt: "2026-08-28T00:00:00.000Z" } satisfies Member;
const workspace = {
  tripId: "trip-1",
  preferences: [{ id: "p-1", tripId: "trip-1", ownerUid: "fs_admin", answers: { pace: "slow" }, freeText: { mustHave: "有窗" }, status: "completed", revision: 2, updatedAt: "2026-08-28T00:00:00.000Z", updatedBy: "fs_admin" }],
  candidates: [{ id: "candidate-1", tripId: "trip-1", category: "hotel", entity: { name: "海边酒店", address: "香港" }, applicability: { dates: { start: "2026-10-01", end: "2026-10-02" }, travelers: 2 }, recommendation: { round: 1, reason: "交通方便", preferenceRevisionIds: [], feedbackIds: [] }, verificationState: "web_verified", decisionState: "tentative", currentEvidenceId: "evidence-1", revision: 3, updatedAt: "2026-08-28T00:00:00.000Z" }],
  evidence: [{ id: "evidence-1", tripId: "trip-1", candidateId: "candidate-1", sourceKind: "official", sourceName: "酒店官网", sourceUrl: "https://example.com", capturedAt: "2026-08-28T00:00:00.000Z", queryContext: { travelers: 2 }, captureMethod: "detail_page", facts: { propertyName: "海边酒店", address: "香港", checkInDate: "2026-10-01", checkOutDate: "2026-10-02", travelers: 2, roomTypeOrBed: "双床", availability: "available", priceAmount: 1800, currency: "HKD", priceDisplay: "total", cancellationPolicy: "可取消" }, fieldCompleteness: [], verificationOutcome: "web_verified", revision: 1, updatedAt: "2026-08-28T00:00:00.000Z" }],
  feedback: [{ id: "feedback-1", tripId: "trip-1", candidateId: "candidate-1", actorUid: "fs_member", kind: "like", reason: "喜欢", createdAt: "2026-08-28T00:00:00.000Z", revision: 1, updatedAt: "2026-08-28T00:00:00.000Z" }],
  placements: [{ id: "placement-1", tripId: "trip-1", candidateId: "candidate-1", tripDayId: "day-1", date: "2026-10-01", sortKey: "a0", status: "planned", revision: 1, updatedAt: "2026-08-28T00:00:00.000Z" }],
  confirmations: [{ id: "confirmation-1", tripId: "trip-1", candidateId: "candidate-1", memberUid: "fs_admin", active: true, actedAt: "2026-08-28T00:00:00.000Z", revision: 1, updatedAt: "2026-08-28T00:00:00.000Z" }],
  workspaceCursor: "7",
  fetchedAt: "2026-08-28T00:00:00.000Z",
} satisfies DecisionWorkspace;

describe("decision workspace adapter", () => {
  it("joins evidence, feedback, placement and both-member confirmation progress", () => {
    const view = toDecisionWorkspaceViewModel(workspace, trip, member);

    expect(view.travelers.map(({ name }) => name)).toEqual(["一鸣", "美垚"]);
    expect(view.travelers[1]?.status).toBe("editing");
    expect(view.candidates[0]?.evidence.source).toBe("酒店官网");
    expect(view.candidates[0]?.evidence.snapshot).toContain("HKD 1800");
    expect(view.candidates[0]?.feedback[0]?.traveler).toBe("美垚");
    expect(view.candidates[0]?.placement).toContain("D1");
    expect(view.candidates[0]?.confirmations).toEqual({ confirmedBy: ["一鸣"], awaiting: ["美垚"] });
  });

  it("preserves a standard verification block reason and human takeover guidance", () => {
    const blocked = {
      ...workspace,
      candidates: [{
        ...workspace.candidates[0]!,
        verificationState: "needs_takeover" as const,
        verificationBlockReason: "risk_control" as const,
      }],
    } satisfies DecisionWorkspace;

    expect(toDecisionWorkspaceViewModel(blocked, trip, member).candidates[0]).toMatchObject({
      verificationBlockReason: "网页触发风险控制",
      takeoverGuidance: "请在本机浏览器完成验证后，让 Agent 重试网页核验。",
    });
  });
});
