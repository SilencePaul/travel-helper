import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DecisionCommandResult, DecisionWorkspace, DecisionWorkspaceRepository, Member, Trip } from "@travel/contracts";
import { expect, test, vi } from "vitest";
import { DecisionWorkspacePage } from "./DecisionWorkspacePage";

const trip = {
  id: "trip-1", title: "双人旅行", startDate: "2026-10-01", endDate: "2026-10-02",
  travelers: [{ id: "fs_admin", name: "一鸣" }, { id: "fs_member", name: "美垚" }],
  days: [{ id: "day-1", date: "2026-10-01", city: "香港", itemIds: [] }],
  unscheduledItemIds: [], orders: [], memberUids: ["fs_admin", "fs_member"], version: 1,
} satisfies Trip;
const member = { uid: "fs_admin", displayName: "一鸣", role: "admin", version: 1, createdAt: "2026-08-28T00:00:00.000Z" } satisfies Member;
const workspace = {
  tripId: "trip-1",
  preferences: [{ id: "p-1", tripId: "trip-1", ownerUid: "fs_admin", answers: { pace: "slow", budget: "mid" }, status: "editing", revision: 1, updatedAt: "2026-08-28T00:00:00.000Z", updatedBy: "fs_admin" }],
  candidates: [], placements: [], evidence: [], feedback: [], confirmations: [], workspaceCursor: "0", fetchedAt: "2026-08-28T00:00:00.000Z",
} satisfies DecisionWorkspace;

test("loads the decision workspace and saves the current member preference", async () => {
  const user = userEvent.setup();
  const command = vi.fn().mockResolvedValue({ ok: true, action: "upsertPreference", data: workspace.preferences[0] });
  const repository = { load: vi.fn().mockResolvedValue(workspace), command, events: vi.fn(), subscribe: vi.fn(() => () => undefined) } satisfies DecisionWorkspaceRepository;

  render(<DecisionWorkspacePage repository={repository} trip={trip} member={member} onBack={() => undefined} newIdempotencyKey={() => "request-001"} />);

  expect(await screen.findByRole("heading", { name: "两个人的偏好，正在汇成一张路线" })).toBeVisible();
  await user.selectOptions(screen.getByLabelText("旅行节奏"), "fast");
  await user.selectOptions(screen.getByLabelText("住宿标准"), "quiet");
  await user.selectOptions(screen.getByLabelText("步行强度"), "light");
  await user.selectOptions(screen.getByLabelText("排队接受度"), "short");
  await user.type(screen.getByLabelText("饮食偏好"), "本地小店");
  await user.type(screen.getByLabelText("想看的景点"), "海边和博物馆");
  await user.type(screen.getByLabelText("一定要有"), "有窗");
  await user.click(screen.getByRole("button", { name: "保存我的偏好" }));

  expect(command).toHaveBeenCalledWith({
    action: "upsertPreference",
    tripId: "trip-1",
    expectedRevision: 1,
    idempotencyKey: "request-001",
    answers: {
      pace: "fast",
      budget: "mid",
      accommodation: "quiet",
      walking: "light",
      queue: "short",
      dining: "本地小店",
      attractions: "海边和博物馆",
    },
    freeText: { mustHave: "有窗", mustAvoid: "", note: "" },
  });
});

test("disables preference fields while saving and exposes saving and success as statuses", async () => {
  let finishCommand!: (result: DecisionCommandResult) => void;
  const command = vi.fn(() => new Promise<DecisionCommandResult>((resolve) => { finishCommand = resolve; }));
  const repository = { load: vi.fn().mockResolvedValue(workspace), command, events: vi.fn(), subscribe: vi.fn(() => () => undefined) } satisfies DecisionWorkspaceRepository;
  const user = userEvent.setup();
  render(<DecisionWorkspacePage repository={repository} trip={trip} member={member} onBack={() => undefined} newIdempotencyKey={() => "request-001"} />);

  await screen.findByRole("heading", { name: "两个人的偏好，正在汇成一张路线" });
  await user.click(screen.getByRole("button", { name: "保存我的偏好" }));

  expect(screen.getByRole("status")).toHaveTextContent("正在保存共同决定");
  for (const field of [...screen.getAllByRole("combobox"), ...screen.getAllByRole("textbox")]) {
    expect(field).toBeDisabled();
  }

  await act(async () => finishCommand({ ok: true, action: "upsertPreference", data: workspace.preferences[0]! }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("已保存并同步给同行者"));
  expect(screen.getByLabelText("旅行节奏")).toBeEnabled();
});

test("announces a workspace load failure as an alert", async () => {
  const repository = { load: vi.fn().mockRejectedValue(new Error("offline")), command: vi.fn(), events: vi.fn(), subscribe: vi.fn(() => () => undefined) } satisfies DecisionWorkspaceRepository;
  render(<DecisionWorkspacePage repository={repository} trip={trip} member={member} onBack={() => undefined} />);

  expect(await screen.findByRole("alert")).toHaveTextContent("共同决定暂时无法加载");
});

test.each([
  [{ ok: false as const, error: "INVALID_REQUEST" as const }, "保存失败：INVALID_REQUEST"],
  [{ ok: false as const, error: "VERSION_CONFLICT" as const }, "内容已被同行者更新"],
])("announces command failure %s as an alert", async (result, expectedMessage) => {
  const repository = { load: vi.fn().mockResolvedValue(workspace), command: vi.fn().mockResolvedValue(result), events: vi.fn(), subscribe: vi.fn(() => () => undefined) } satisfies DecisionWorkspaceRepository;
  const user = userEvent.setup();
  render(<DecisionWorkspacePage repository={repository} trip={trip} member={member} onBack={() => undefined} />);

  await screen.findByRole("heading", { name: "两个人的偏好，正在汇成一张路线" });
  await user.click(screen.getByRole("button", { name: "保存我的偏好" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(expectedMessage);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
