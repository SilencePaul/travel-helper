import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { DecisionWorkspaceShowcase } from "./DecisionWorkspaceShowcase";

const workspace = {
  travelers: [
    {
      id: "yiming",
      name: "一鸣",
      status: "completed" as const,
      updatedAt: "2026-08-28T09:20:00.000Z",
      preferences: ["住得离地铁近", "每天留一点空白"],
      mustHave: "有窗",
    },
    {
      id: "meiyao",
      name: "美垚",
      status: "completed" as const,
      updatedAt: "2026-08-28T09:26:00.000Z",
      preferences: ["想吃本地小店", "不赶早班"],
      mustAvoid: "排队超过半小时",
    },
  ],
  summary: {
    status: "ready" as const,
    common: ["慢一点走", "优先交通方便"],
    disagreements: ["一鸣更看重预算；美垚更看重体验"],
    tradeoffs: ["香港住宿可多花一点，把澳门当天节奏放松"],
  },
  candidates: [
    {
      id: "hotel-1",
      category: "hotel" as const,
      name: "The Hari Hong Kong",
      location: "湾仔 · 距会展站 420 米",
      applicability: "10 月 4 日–6 日 · 2 人 · 大床房",
      recommendation: "兼顾美垚想逛小店与一鸣对通勤的要求。",
      verificationState: "web_verified" as const,
      decisionState: "tentative" as const,
      evidence: { source: "酒店官网", capturedAt: "2026-08-28T09:31:00.000Z", snapshot: "CNY 2,480 · 含税 · 可取消" },
      feedback: [
        { traveler: "一鸣", kind: "like" as const, note: "地铁距离合适" },
        { traveler: "美垚", kind: "comment" as const, note: "房间采光不错" },
      ],
      placement: "D2 · 香港 · 暂定入住",
      confirmations: { confirmedBy: ["一鸣"], awaiting: ["美垚"] },
    },
    {
      id: "restaurant-1",
      category: "restaurant" as const,
      name: "新记车仔面",
      location: "中环 · 步行 9 分钟",
      applicability: "10 月 5 日 · 午餐 · 2 人",
      recommendation: "把中环步行路线收在一顿不需要预订的午餐里。",
      verificationState: "needs_takeover" as const,
      decisionState: "none" as const,
      evidence: { source: "Google Maps", capturedAt: "2026-08-28T09:34:00.000Z", snapshot: "营业信息待网页核验" },
      feedback: [],
    },
    {
      id: "attraction-1",
      category: "attraction" as const,
      name: "澳门塔观景层",
      location: "澳门半岛 · 南湾湖畔",
      applicability: "10 月 6 日 · 下午 · 2 人",
      recommendation: "在跨城移动后的傍晚安排一个节奏可控的高点。",
      verificationState: "stale" as const,
      decisionState: "confirmed" as const,
      evidence: { source: "澳门塔官网", capturedAt: "2026-08-20T09:41:00.000Z", snapshot: "票价快照已过期" },
      feedback: [{ traveler: "美垚", kind: "like" as const, note: "想看日落" }],
      placement: "D4 · 澳门 · 17:30",
      confirmations: { confirmedBy: ["一鸣", "美垚"], awaiting: [] },
    },
  ],
};

test("renders shared preferences and the travel-pass proposal evidence", () => {
  render(<DecisionWorkspaceShowcase workspace={workspace} />);

  expect(screen.getByRole("heading", { name: "两个人的偏好，正在汇成一张路线" })).toBeVisible();
  expect(screen.getByText("一鸣 · 已完成")).toBeVisible();
  expect(screen.getByText("美垚 · 已完成")).toBeVisible();
  expect(screen.getByText("慢一点走")).toBeVisible();
  expect(screen.getByText("一鸣更看重预算；美垚更看重体验")).toBeVisible();
  expect(screen.getByText("The Hari Hong Kong")).toBeVisible();
  expect(screen.getByText("来源 · 酒店官网")).toBeVisible();
  expect(screen.getAllByText(/最后核验 · 2026年8月28日/)).toHaveLength(2);
  expect(screen.getByText("网页已核验")).toBeVisible();
  expect(screen.getByText("需要你接管网页核验")).toBeVisible();
  expect(screen.getByText("快照已过期")).toBeVisible();
});

test("renders feedback, tentative placement, and both-traveler confirmation progress", () => {
  render(<DecisionWorkspaceShowcase workspace={workspace} />);

  expect(screen.getByText("一鸣 · 喜欢 · 地铁距离合适")).toBeVisible();
  expect(screen.getByText("美垚 · 留言 · 房间采光不错")).toBeVisible();
  expect(screen.getByText("暂定日程 · D2 · 香港 · 暂定入住")).toBeVisible();
  expect(screen.getByText("一鸣已确认 · 等待美垚确认")).toBeVisible();
  expect(screen.getByText("双方已确认")).toBeVisible();
});

test("keeps the proposal rail to at most four tickets", () => {
  render(<DecisionWorkspaceShowcase workspace={{ ...workspace, candidates: [...workspace.candidates, { ...workspace.candidates[0]!, id: "hotel-2", name: "Extra ticket" }, { ...workspace.candidates[0]!, id: "hotel-3", name: "Hidden ticket" }] }} />);

  expect(screen.getAllByTestId("decision-candidate-ticket")).toHaveLength(4);
  expect(screen.queryByText("Hidden ticket")).not.toBeInTheDocument();
});
