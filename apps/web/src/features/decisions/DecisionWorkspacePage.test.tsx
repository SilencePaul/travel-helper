import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
const candidate = {
  id: "candidate-1",
  tripId: "trip-1",
  category: "hotel",
  entity: { name: "海边酒店", address: "香港" },
  applicability: { dates: { start: "2026-10-01", end: "2026-10-02" }, travelers: 2 },
  recommendation: { round: 1, reason: "交通方便", preferenceRevisionIds: [], feedbackIds: [] },
  verificationState: "web_verified",
  decisionState: "tentative",
  currentEvidenceId: "evidence-1",
  revision: 3,
  updatedAt: "2026-08-28T00:00:00.000Z",
} satisfies DecisionWorkspace["candidates"][number];

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

test("clears a load error when the workspace subscription recovers", async () => {
  let publish!: (next: DecisionWorkspace) => void;
  const repository = {
    load: vi.fn().mockRejectedValue(new Error("offline")),
    command: vi.fn(),
    events: vi.fn(),
    subscribe: vi.fn((_tripId: string, onChange: (next: DecisionWorkspace) => void) => {
      publish = onChange;
      return () => undefined;
    }),
  } satisfies DecisionWorkspaceRepository;
  render(<DecisionWorkspacePage repository={repository} trip={trip} member={member} onBack={() => undefined} />);

  expect(await screen.findByRole("alert")).toHaveTextContent("共同决定暂时无法加载");
  act(() => publish(workspace));

  expect(await screen.findByRole("heading", { name: "两个人的偏好，正在汇成一张路线" })).toBeVisible();
  expect(screen.queryByText("共同决定暂时无法加载，请检查网络后重试。")).not.toBeInTheDocument();
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

test("restores the command trigger after a command failure", async () => {
  let finishCommand!: (result: DecisionCommandResult) => void;
  const command = vi.fn(() => new Promise<DecisionCommandResult>((resolve) => { finishCommand = resolve; }));
  const repository = { load: vi.fn().mockResolvedValue(workspace), command, events: vi.fn(), subscribe: vi.fn(() => () => undefined) } satisfies DecisionWorkspaceRepository;
  const user = userEvent.setup();
  render(<DecisionWorkspacePage repository={repository} trip={trip} member={member} onBack={() => undefined} />);

  await screen.findByRole("heading", { name: "两个人的偏好，正在汇成一张路线" });
  const trigger = screen.getByRole("button", { name: "保存我的偏好" });
  await user.click(trigger);
  document.body.tabIndex = -1;
  document.body.focus();
  expect(document.body).toHaveFocus();

  await act(async () => finishCommand({ ok: false, error: "INVALID_REQUEST" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("保存失败：INVALID_REQUEST");
  await waitFor(() => expect(trigger).toHaveFocus());
  document.body.removeAttribute("tabindex");
});

test("restores the stable preference submit action when a failed form submission has no submitter", async () => {
  let finishCommand!: (result: DecisionCommandResult) => void;
  const command = vi.fn(() => new Promise<DecisionCommandResult>((resolve) => { finishCommand = resolve; }));
  const repository = { load: vi.fn().mockResolvedValue(workspace), command, events: vi.fn(), subscribe: vi.fn(() => () => undefined) } satisfies DecisionWorkspaceRepository;
  render(<DecisionWorkspacePage repository={repository} trip={trip} member={member} onBack={() => undefined} />);

  const save = await screen.findByRole("button", { name: "保存我的偏好" });
  fireEvent.submit(save.closest("form")!);
  document.body.tabIndex = -1;
  document.body.focus();

  await act(async () => finishCommand({ ok: false, error: "INVALID_REQUEST" }));

  try {
    await waitFor(() => expect(save).toHaveFocus());
  } finally {
    document.body.removeAttribute("tabindex");
  }
});

test("restores the replacement preference submit action when the failed command trigger disconnects", async () => {
  let finishCommand!: (result: DecisionCommandResult) => void;
  let publish!: (next: DecisionWorkspace) => void;
  const command = vi.fn(() => new Promise<DecisionCommandResult>((resolve) => { finishCommand = resolve; }));
  const repository = {
    load: vi.fn().mockResolvedValue(workspace),
    command,
    events: vi.fn(),
    subscribe: vi.fn((_tripId: string, onChange: (next: DecisionWorkspace) => void) => {
      publish = onChange;
      return () => undefined;
    }),
  } satisfies DecisionWorkspaceRepository;
  const user = userEvent.setup();
  render(<DecisionWorkspacePage repository={repository} trip={trip} member={member} onBack={() => undefined} />);

  const disconnectedTrigger = await screen.findByRole("button", { name: "保存我的偏好" });
  await user.click(disconnectedTrigger);
  act(() => publish({
    ...workspace,
    preferences: [{ ...workspace.preferences[0]!, revision: 2 }],
  }));
  expect(disconnectedTrigger.isConnected).toBe(false);
  const replacementSave = screen.getByRole("button", { name: "保存我的偏好" });
  document.body.tabIndex = -1;
  document.body.focus();

  await act(async () => finishCommand({ ok: false, error: "INVALID_REQUEST" }));

  try {
    await waitFor(() => expect(replacementSave).toHaveFocus());
  } finally {
    document.body.removeAttribute("tabindex");
  }
});

test("keeps only the confirmation action primary after a candidate is placed", async () => {
  const placedWorkspace = {
    ...workspace,
    candidates: [candidate],
    placements: [{
      id: "placement-1",
      tripId: "trip-1",
      candidateId: "candidate-1",
      tripDayId: "day-1",
      date: "2026-10-01",
      sortKey: "a0",
      status: "planned",
      revision: 1,
      updatedAt: "2026-08-28T00:00:00.000Z",
    }],
  } satisfies DecisionWorkspace;
  const repository = { load: vi.fn().mockResolvedValue(placedWorkspace), command: vi.fn(), events: vi.fn(), subscribe: vi.fn(() => () => undefined) } satisfies DecisionWorkspaceRepository;
  render(<DecisionWorkspacePage repository={repository} trip={trip} member={member} onBack={() => undefined} />);

  const adjust = await screen.findByRole("button", { name: "调整暂定日程" });
  const confirm = screen.getByRole("button", { name: "确认这张票根" });

  expect(adjust).toHaveClass("control-button--secondary");
  expect(adjust).not.toHaveClass("control-button--primary");
  expect(confirm).toHaveClass("control-button--primary");
});

test("keeps the disabled confirmation secondary until a candidate is placed", async () => {
  const unplacedWorkspace = { ...workspace, candidates: [candidate] } satisfies DecisionWorkspace;
  const repository = { load: vi.fn().mockResolvedValue(unplacedWorkspace), command: vi.fn(), events: vi.fn(), subscribe: vi.fn(() => () => undefined) } satisfies DecisionWorkspaceRepository;
  render(<DecisionWorkspacePage repository={repository} trip={trip} member={member} onBack={() => undefined} />);

  const add = await screen.findByRole("button", { name: "加入暂定行程" });
  const confirm = screen.getByRole("button", { name: "确认这张票根" });

  expect(add.closest(".decision-action-row")?.querySelectorAll(".control-button--primary")).toHaveLength(1);
  expect(confirm).toBeDisabled();
  expect(confirm).toHaveClass("control-button--secondary");
  expect(confirm).not.toHaveClass("control-button--primary");
});
