import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DecisionCommandResult, DecisionWorkspace, DecisionWorkspaceRepository, Member, ResearchStatus, Trip } from "@travel/contracts";
import { expect, test, vi } from "vitest";
import type { LocalAgentBridge } from "../../infrastructure/localAgentBridgeClient";
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
const tripTwo = {
  ...trip,
  id: "trip-2",
  title: "第二段旅行",
  days: [{ id: "day-2", date: "2026-10-01", city: "澳门", itemIds: [] }],
} satisfies Trip;
const memberTwo = { ...member, uid: "fs_member", displayName: "美垚" } satisfies Member;
const workspaceTwo = {
  ...workspace,
  tripId: "trip-2",
  preferences: [{ ...workspace.preferences[0]!, id: "p-2", tripId: "trip-2", ownerUid: "fs_member", answers: { pace: "fast", budget: "mid" }, revision: 4, updatedBy: "fs_member" }],
  workspaceCursor: "4",
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
  const repository = { load: vi.fn().mockResolvedValue(workspace), refresh: vi.fn().mockResolvedValue(workspace), command, events: vi.fn(), subscribe: vi.fn(() => () => undefined) } satisfies DecisionWorkspaceRepository;

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
  const repository = { load: vi.fn().mockResolvedValue(workspace), refresh: vi.fn().mockResolvedValue(workspace), command, events: vi.fn(), subscribe: vi.fn(() => () => undefined) } satisfies DecisionWorkspaceRepository;
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
  const repository = { load: vi.fn().mockRejectedValue(new Error("offline")), refresh: vi.fn().mockRejectedValue(new Error("offline")), command: vi.fn(), events: vi.fn(), subscribe: vi.fn(() => () => undefined) } satisfies DecisionWorkspaceRepository;
  render(<DecisionWorkspacePage repository={repository} trip={trip} member={member} onBack={() => undefined} />);

  expect(await screen.findByRole("alert")).toHaveTextContent("共同决定暂时无法加载");
});

test("retries an initial load failure with a strict refresh", async () => {
  const repository = {
    load: vi.fn().mockRejectedValue(new Error("offline")),
    refresh: vi.fn().mockResolvedValue(workspace),
    command: vi.fn(),
    events: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
  } satisfies DecisionWorkspaceRepository;
  const user = userEvent.setup();
  render(<DecisionWorkspacePage repository={repository} trip={trip} member={member} onBack={() => undefined} />);

  const retry = await screen.findByRole("button", { name: "重新加载共同决定" });
  await waitFor(() => expect(retry).toHaveFocus());
  await user.click(retry);

  expect(await screen.findByRole("heading", { name: "两个人的偏好，正在汇成一张路线" })).toBeVisible();
  expect(repository.refresh).toHaveBeenCalledTimes(1);
});

test("keeps the initial-load alert and retry action after another failed attempt", async () => {
  const repository = {
    load: vi.fn().mockRejectedValue(new Error("offline")),
    refresh: vi.fn().mockRejectedValue(new Error("still offline")),
    command: vi.fn(),
    events: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
  } satisfies DecisionWorkspaceRepository;
  const user = userEvent.setup();
  render(<DecisionWorkspacePage repository={repository} trip={trip} member={member} onBack={() => undefined} />);

  await user.click(await screen.findByRole("button", { name: "重新加载共同决定" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("共同决定暂时无法加载");
  expect(screen.getByRole("button", { name: "重新加载共同决定" })).toBeEnabled();
  expect(repository.refresh).toHaveBeenCalledTimes(1);
});

test("ignores a late initial snapshot whose decimal cursor is behind a subscription", async () => {
  let resolveLoad!: (next: DecisionWorkspace) => void;
  let publish!: (next: DecisionWorkspace) => void;
  const latest = {
    ...workspace,
    preferences: [{ ...workspace.preferences[0]!, revision: 2, answers: { ...workspace.preferences[0]!.answers, pace: "fast" } }],
    workspaceCursor: "10",
  } satisfies DecisionWorkspace;
  const late = {
    ...workspace,
    preferences: [{ ...workspace.preferences[0]!, answers: { ...workspace.preferences[0]!.answers, pace: "balanced" } }],
    workspaceCursor: "9",
  } satisfies DecisionWorkspace;
  const repository = {
    load: vi.fn(() => new Promise<DecisionWorkspace>((resolve) => { resolveLoad = resolve; })),
    refresh: vi.fn().mockResolvedValue(latest),
    command: vi.fn(),
    events: vi.fn(),
    subscribe: vi.fn((_tripId: string, onChange: (next: DecisionWorkspace) => void) => {
      publish = onChange;
      return () => undefined;
    }),
  } satisfies DecisionWorkspaceRepository;
  render(<DecisionWorkspacePage repository={repository} trip={trip} member={member} onBack={() => undefined} />);

  act(() => publish(latest));
  expect(await screen.findByLabelText("旅行节奏")).toHaveValue("fast");
  await act(async () => resolveLoad(late));

  expect(screen.getByLabelText("旅行节奏")).toHaveValue("fast");
});

test("does not replace an available subscription snapshot with a late load error", async () => {
  let rejectLoad!: (error: Error) => void;
  let publish!: (next: DecisionWorkspace) => void;
  const repository = {
    load: vi.fn(() => new Promise<DecisionWorkspace>((_resolve, reject) => { rejectLoad = reject; })),
    refresh: vi.fn().mockResolvedValue(workspace),
    command: vi.fn(),
    events: vi.fn(),
    subscribe: vi.fn((_tripId: string, onChange: (next: DecisionWorkspace) => void) => {
      publish = onChange;
      return () => undefined;
    }),
  } satisfies DecisionWorkspaceRepository;
  render(<DecisionWorkspacePage repository={repository} trip={trip} member={member} onBack={() => undefined} />);

  act(() => publish({ ...workspace, workspaceCursor: "2" }));
  expect(await screen.findByRole("heading", { name: "两个人的偏好，正在汇成一张路线" })).toBeVisible();
  await act(async () => rejectLoad(new Error("late offline")));

  expect(screen.queryByText("共同决定暂时无法加载，请检查网络后重试。")).not.toBeInTheDocument();
});

test("rejects a workspace for a different trip instead of rendering it", async () => {
  const repository = {
    load: vi.fn().mockResolvedValue(workspaceTwo),
    refresh: vi.fn().mockResolvedValue(workspaceTwo),
    command: vi.fn(),
    events: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
  } satisfies DecisionWorkspaceRepository;
  render(<DecisionWorkspacePage repository={repository} trip={trip} member={member} onBack={() => undefined} />);

  expect(await screen.findByRole("alert")).toHaveTextContent("共同决定暂时无法加载");
  expect(screen.queryByDisplayValue("fast")).not.toBeInTheDocument();
});

test("ignores a command result after the repository, trip, and member scope changes", async () => {
  let finishCommand!: (result: DecisionCommandResult) => void;
  const oldRepository = {
    load: vi.fn().mockResolvedValue(workspace),
    refresh: vi.fn().mockResolvedValue(workspace),
    command: vi.fn(() => new Promise<DecisionCommandResult>((resolve) => { finishCommand = resolve; })),
    events: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
  } satisfies DecisionWorkspaceRepository;
  const newRepository = {
    load: vi.fn().mockResolvedValue(workspaceTwo),
    refresh: vi.fn().mockResolvedValue(workspaceTwo),
    command: vi.fn(),
    events: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
  } satisfies DecisionWorkspaceRepository;
  const user = userEvent.setup();
  const view = render(<DecisionWorkspacePage repository={oldRepository} trip={trip} member={member} onBack={() => undefined} />);

  await user.click(await screen.findByRole("button", { name: "保存我的偏好" }));
  view.rerender(<DecisionWorkspacePage repository={newRepository} trip={tripTwo} member={memberTwo} onBack={() => undefined} />);
  expect(await screen.findByLabelText("旅行节奏")).toHaveValue("fast");
  await act(async () => finishCommand({ ok: false, error: "INVALID_REQUEST" }));

  expect(screen.queryByText("保存失败：INVALID_REQUEST")).not.toBeInTheDocument();
  expect(screen.getByLabelText("旅行节奏")).toHaveValue("fast");
});

test("ignores an initial retry result after its page scope changes", async () => {
  let finishRetry!: (next: DecisionWorkspace) => void;
  const oldRepository = {
    load: vi.fn().mockRejectedValue(new Error("offline")),
    refresh: vi.fn(() => new Promise<DecisionWorkspace>((resolve) => { finishRetry = resolve; })),
    command: vi.fn(),
    events: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
  } satisfies DecisionWorkspaceRepository;
  const newRepository = {
    load: vi.fn().mockResolvedValue(workspaceTwo),
    refresh: vi.fn().mockResolvedValue(workspaceTwo),
    command: vi.fn(),
    events: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
  } satisfies DecisionWorkspaceRepository;
  const user = userEvent.setup();
  const view = render(<DecisionWorkspacePage repository={oldRepository} trip={trip} member={member} onBack={() => undefined} />);

  await user.click(await screen.findByRole("button", { name: "重新加载共同决定" }));
  view.rerender(<DecisionWorkspacePage repository={newRepository} trip={tripTwo} member={memberTwo} onBack={() => undefined} />);
  expect(await screen.findByLabelText("旅行节奏")).toHaveValue("fast");
  await act(async () => finishRetry({ ...workspace, candidates: [candidate], workspaceCursor: "9" }));

  expect(screen.getByLabelText("旅行节奏")).toHaveValue("fast");
  expect(screen.getByText("美垚 · 共同决定")).toBeVisible();
  expect(screen.queryAllByText("海边酒店")).toHaveLength(0);
});

test("does not show a stale retry error after a subscription has recovered the workspace", async () => {
  let rejectRetry!: (error: Error) => void;
  let publish!: (next: DecisionWorkspace) => void;
  const repository = {
    load: vi.fn().mockRejectedValue(new Error("offline")),
    refresh: vi.fn(() => new Promise<DecisionWorkspace>((_resolve, reject) => { rejectRetry = reject; })),
    command: vi.fn(),
    events: vi.fn(),
    subscribe: vi.fn((_tripId: string, onChange: (next: DecisionWorkspace) => void) => {
      publish = onChange;
      return () => undefined;
    }),
  } satisfies DecisionWorkspaceRepository;
  const user = userEvent.setup();
  render(<DecisionWorkspacePage repository={repository} trip={trip} member={member} onBack={() => undefined} />);

  await user.click(await screen.findByRole("button", { name: "重新加载共同决定" }));
  act(() => publish({ ...workspace, workspaceCursor: "1" }));
  expect(await screen.findByRole("heading", { name: "两个人的偏好，正在汇成一张路线" })).toBeVisible();
  await act(async () => rejectRetry(new Error("late offline")));

  expect(screen.queryByText("共同决定暂时无法加载，请检查网络后重试。")).not.toBeInTheDocument();
});

test("clears a load error when the workspace subscription recovers", async () => {
  let publish!: (next: DecisionWorkspace) => void;
  const repository = {
    load: vi.fn().mockRejectedValue(new Error("offline")),
    refresh: vi.fn().mockResolvedValue(workspace),
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

test("preserves dirty fields and focus, adopts untouched remote fields, and blocks saving until resolution", async () => {
  let publish!: (next: DecisionWorkspace) => void;
  const latest = {
    ...workspace,
    preferences: [{ ...workspace.preferences[0]!, revision: 2, answers: { ...workspace.preferences[0]!.answers, pace: "fast", dining: "远端推荐" } }],
    workspaceCursor: "2",
  } satisfies DecisionWorkspace;
  const command = vi.fn();
  const repository = {
    load: vi.fn().mockResolvedValue(workspace),
    refresh: vi.fn().mockResolvedValue(latest),
    command,
    events: vi.fn(),
    subscribe: vi.fn((_tripId: string, onChange: (next: DecisionWorkspace) => void) => {
      publish = onChange;
      return () => undefined;
    }),
  } satisfies DecisionWorkspaceRepository;
  const user = userEvent.setup();
  render(<DecisionWorkspacePage repository={repository} trip={trip} member={member} onBack={() => undefined} />);

  const dining = await screen.findByLabelText("饮食偏好");
  await user.type(dining, "本地小店");
  expect(dining).toHaveFocus();
  act(() => publish(latest));

  expect(screen.getByLabelText("饮食偏好")).toHaveValue("本地小店");
  expect(screen.getByLabelText("旅行节奏")).toHaveValue("fast");
  expect(dining).toHaveFocus();
  expect(screen.getByRole("alert")).toHaveTextContent("偏好草稿与最新版本有冲突");
  expect(screen.getByRole("button", { name: "保存我的偏好" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "标记已完成" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "本轮跳过" })).toBeDisabled();
  expect(command).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "保留我的修改并继续" }));
  expect(screen.getByRole("button", { name: "保存我的偏好" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "标记已完成" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "本轮跳过" })).toBeEnabled();
  expect(command).not.toHaveBeenCalled();
});

test("keeps dirty fields against the latest revision only after explicit conflict resolution", async () => {
  let publish!: (next: DecisionWorkspace) => void;
  const latestProfile = { ...workspace.preferences[0]!, revision: 2, answers: { ...workspace.preferences[0]!.answers, pace: "fast", dining: "远端推荐" } };
  const latest = { ...workspace, preferences: [latestProfile], workspaceCursor: "2" } satisfies DecisionWorkspace;
  const savedProfile = { ...latestProfile, revision: 3, answers: { ...latestProfile.answers, dining: "本地小店" } };
  const command = vi.fn().mockResolvedValue({ ok: true, action: "upsertPreference", data: savedProfile });
  const repository = {
    load: vi.fn().mockResolvedValue(workspace),
    refresh: vi.fn().mockResolvedValue({ ...latest, preferences: [savedProfile], workspaceCursor: "3" }),
    command,
    events: vi.fn(),
    subscribe: vi.fn((_tripId: string, onChange: (next: DecisionWorkspace) => void) => {
      publish = onChange;
      return () => undefined;
    }),
  } satisfies DecisionWorkspaceRepository;
  const user = userEvent.setup();
  render(<DecisionWorkspacePage repository={repository} trip={trip} member={member} onBack={() => undefined} newIdempotencyKey={() => "request-001"} />);

  await user.type(await screen.findByLabelText("饮食偏好"), "本地小店");
  act(() => publish(latest));
  await user.click(screen.getByRole("button", { name: "保留我的修改并继续" }));
  await user.click(screen.getByRole("button", { name: "保存我的偏好" }));

  expect(command).toHaveBeenCalledWith(expect.objectContaining({
    action: "upsertPreference",
    expectedRevision: 2,
    answers: expect.objectContaining({ pace: "fast", dining: "本地小店" }),
  }));
});

test("uses the latest remote profile when that conflict resolution is selected", async () => {
  let publish!: (next: DecisionWorkspace) => void;
  const latest = {
    ...workspace,
    preferences: [{ ...workspace.preferences[0]!, revision: 2, answers: { ...workspace.preferences[0]!.answers, dining: "远端推荐" } }],
    workspaceCursor: "2",
  } satisfies DecisionWorkspace;
  const repository = {
    load: vi.fn().mockResolvedValue(workspace),
    refresh: vi.fn().mockResolvedValue(latest),
    command: vi.fn(),
    events: vi.fn(),
    subscribe: vi.fn((_tripId: string, onChange: (next: DecisionWorkspace) => void) => {
      publish = onChange;
      return () => undefined;
    }),
  } satisfies DecisionWorkspaceRepository;
  const user = userEvent.setup();
  render(<DecisionWorkspacePage repository={repository} trip={trip} member={member} onBack={() => undefined} />);

  await user.type(await screen.findByLabelText("饮食偏好"), "本地小店");
  act(() => publish(latest));
  await user.click(screen.getByRole("button", { name: "使用最新版本" }));

  expect(screen.getByLabelText("饮食偏好")).toHaveValue("远端推荐");
  expect(screen.queryByText("偏好草稿与最新版本有冲突")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "保存我的偏好" })).toBeEnabled();
});

test.each([
  [{ ok: false as const, error: "INVALID_REQUEST" as const }, "保存失败：INVALID_REQUEST"],
  [{ ok: false as const, error: "VERSION_CONFLICT" as const }, "内容已被同行者更新"],
])("announces command failure %s as an alert", async (result, expectedMessage) => {
  const repository = { load: vi.fn().mockResolvedValue(workspace), refresh: vi.fn().mockResolvedValue(workspace), command: vi.fn().mockResolvedValue(result), events: vi.fn(), subscribe: vi.fn(() => () => undefined) } satisfies DecisionWorkspaceRepository;
  const user = userEvent.setup();
  render(<DecisionWorkspacePage repository={repository} trip={trip} member={member} onBack={() => undefined} />);

  await screen.findByRole("heading", { name: "两个人的偏好，正在汇成一张路线" });
  await user.click(screen.getByRole("button", { name: "保存我的偏好" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(expectedMessage);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

test("strictly refreshes a version conflict without retrying the command or discarding the draft", async () => {
  const latest = {
    ...workspace,
    preferences: [{ ...workspace.preferences[0]!, revision: 2, answers: { ...workspace.preferences[0]!.answers, pace: "fast", dining: "远端推荐" } }],
    workspaceCursor: "2",
  } satisfies DecisionWorkspace;
  const command = vi.fn().mockResolvedValue({ ok: false, error: "VERSION_CONFLICT" });
  const refresh = vi.fn().mockResolvedValue(latest);
  const repository = { load: vi.fn().mockResolvedValue(workspace), refresh, command, events: vi.fn(), subscribe: vi.fn(() => () => undefined) } satisfies DecisionWorkspaceRepository;
  const user = userEvent.setup();
  render(<DecisionWorkspacePage repository={repository} trip={trip} member={member} onBack={() => undefined} />);

  await user.type(await screen.findByLabelText("饮食偏好"), "本地小店");
  await user.click(screen.getByRole("button", { name: "保存我的偏好" }));

  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  expect(command).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText("饮食偏好")).toHaveValue("本地小店");
  expect(screen.getByLabelText("旅行节奏")).toHaveValue("fast");
  expect(screen.getByRole("button", { name: "保存我的偏好" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "使用最新版本" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "保留我的修改并继续" })).toBeEnabled();
  await waitFor(() => expect(screen.getByRole("button", { name: "使用最新版本" })).toHaveFocus());
});

test("keeps a candidate command conflict alert visible beside an unrelated preference draft conflict", async () => {
  let publish!: (next: DecisionWorkspace) => void;
  const initial = { ...workspace, candidates: [candidate] } satisfies DecisionWorkspace;
  const latest = {
    ...initial,
    preferences: [{ ...workspace.preferences[0]!, revision: 2, answers: { ...workspace.preferences[0]!.answers, pace: "fast" } }],
    workspaceCursor: "2",
  } satisfies DecisionWorkspace;
  const refreshed = { ...latest, workspaceCursor: "3" } satisfies DecisionWorkspace;
  const command = vi.fn().mockResolvedValue({ ok: false, error: "VERSION_CONFLICT" });
  const repository = {
    load: vi.fn().mockResolvedValue(initial),
    refresh: vi.fn().mockResolvedValue(refreshed),
    command,
    events: vi.fn(),
    subscribe: vi.fn((_tripId: string, onChange: (next: DecisionWorkspace) => void) => {
      publish = onChange;
      return () => undefined;
    }),
  } satisfies DecisionWorkspaceRepository;
  const user = userEvent.setup();
  render(<DecisionWorkspacePage repository={repository} trip={trip} member={member} onBack={() => undefined} />);

  await user.type(await screen.findByLabelText("饮食偏好"), "本地小店");
  act(() => publish(latest));
  await user.click(screen.getByRole("button", { name: "喜欢" }));

  expect(await screen.findByText("内容已被同行者更新，请查看最新版本后再试。")).toBeVisible();
  expect(command).toHaveBeenCalledTimes(1);
  expect(screen.getByText("你的偏好草稿与最新版本有冲突。已保留修改字段，其他字段已更新。")).toBeVisible();
});

test("reports a saved command with failed strict refresh and retries only the refresh", async () => {
  const savedProfile = { ...workspace.preferences[0]!, revision: 2 };
  const command = vi.fn().mockResolvedValue({ ok: true, action: "upsertPreference", data: savedProfile });
  const refresh = vi.fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ ...workspace, preferences: [savedProfile], workspaceCursor: "1" });
  const repository = { load: vi.fn().mockResolvedValue(workspace), refresh, command, events: vi.fn(), subscribe: vi.fn(() => () => undefined) } satisfies DecisionWorkspaceRepository;
  const user = userEvent.setup();
  render(<DecisionWorkspacePage repository={repository} trip={trip} member={member} onBack={() => undefined} />);

  await user.click(await screen.findByRole("button", { name: "保存我的偏好" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("修改已经保存，但暂时无法确认其他成员看到的最新状态");
  expect(screen.queryByText("已保存并同步给同行者。")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "重新刷新共同决定" }));

  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  expect(command).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("status")).toHaveTextContent("已刷新共同决定");
});

test("does not restore the write trigger after the command committed but strict refresh failed", async () => {
  let rejectRefresh!: (error: Error) => void;
  const savedProfile = { ...workspace.preferences[0]!, revision: 2 };
  const command = vi.fn().mockResolvedValue({ ok: true, action: "upsertPreference", data: savedProfile });
  const refresh = vi.fn(() => new Promise<DecisionWorkspace>((_resolve, reject) => { rejectRefresh = reject; }));
  const repository = { load: vi.fn().mockResolvedValue(workspace), refresh, command, events: vi.fn(), subscribe: vi.fn(() => () => undefined) } satisfies DecisionWorkspaceRepository;
  const user = userEvent.setup();
  render(<DecisionWorkspacePage repository={repository} trip={trip} member={member} onBack={() => undefined} />);

  const save = await screen.findByRole("button", { name: "保存我的偏好" });
  await user.click(save);
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  document.body.tabIndex = -1;
  document.body.focus();
  await act(async () => rejectRefresh(new Error("offline")));
  await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

  try {
    expect(await screen.findByRole("alert")).toHaveTextContent("修改已经保存");
    await waitFor(() => expect(save).not.toHaveFocus());
    expect(command).toHaveBeenCalledTimes(1);
  } finally {
    document.body.removeAttribute("tabindex");
  }
});

test("disables all writes and exposes busy state while a manual refresh is in flight", async () => {
  let resolveManualRefresh!: (next: DecisionWorkspace) => void;
  const initial = { ...workspace, candidates: [candidate] } satisfies DecisionWorkspace;
  const savedProfile = { ...workspace.preferences[0]!, revision: 2 };
  const refreshed = { ...initial, preferences: [savedProfile], workspaceCursor: "1" } satisfies DecisionWorkspace;
  const command = vi.fn().mockResolvedValue({ ok: true, action: "upsertPreference", data: savedProfile });
  const refresh = vi.fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockImplementationOnce(() => new Promise<DecisionWorkspace>((resolve) => { resolveManualRefresh = resolve; }));
  const repository = { load: vi.fn().mockResolvedValue(initial), refresh, command, events: vi.fn(), subscribe: vi.fn(() => () => undefined) } satisfies DecisionWorkspaceRepository;
  const user = userEvent.setup();
  render(<DecisionWorkspacePage repository={repository} trip={trip} member={member} onBack={() => undefined} />);

  await user.click(await screen.findByRole("button", { name: "保存我的偏好" }));
  await user.click(await screen.findByRole("button", { name: "重新刷新共同决定" }));

  expect(screen.getByRole("button", { name: "保存我的偏好" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "喜欢" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "反对" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "保存我的偏好" }).closest("form")).toHaveAttribute("aria-busy", "true");
  expect(screen.getByRole("region", { name: "把票根变成共同决定" })).toHaveAttribute("aria-busy", "true");
  await user.click(screen.getByRole("button", { name: "喜欢" }));
  expect(command).toHaveBeenCalledTimes(1);

  await act(async () => resolveManualRefresh(refreshed));
});

test("restores the command trigger after a command failure", async () => {
  let finishCommand!: (result: DecisionCommandResult) => void;
  const command = vi.fn(() => new Promise<DecisionCommandResult>((resolve) => { finishCommand = resolve; }));
  const repository = { load: vi.fn().mockResolvedValue(workspace), refresh: vi.fn().mockResolvedValue(workspace), command, events: vi.fn(), subscribe: vi.fn(() => () => undefined) } satisfies DecisionWorkspaceRepository;
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
  const repository = { load: vi.fn().mockResolvedValue(workspace), refresh: vi.fn().mockResolvedValue(workspace), command, events: vi.fn(), subscribe: vi.fn(() => () => undefined) } satisfies DecisionWorkspaceRepository;
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

test("adopts a clean remote revision without remounting and uses it for the next command", async () => {
  let publish!: (next: DecisionWorkspace) => void;
  const command = vi.fn().mockResolvedValue({ ok: false, error: "INVALID_REQUEST" });
  const repository = {
    load: vi.fn().mockResolvedValue(workspace),
    refresh: vi.fn().mockResolvedValue(workspace),
    command,
    events: vi.fn(),
    subscribe: vi.fn((_tripId: string, onChange: (next: DecisionWorkspace) => void) => {
      publish = onChange;
      return () => undefined;
    }),
  } satisfies DecisionWorkspaceRepository;
  const user = userEvent.setup();
  render(<DecisionWorkspacePage repository={repository} trip={trip} member={member} onBack={() => undefined} />);

  const stableTrigger = await screen.findByRole("button", { name: "保存我的偏好" });
  act(() => publish({
    ...workspace,
    preferences: [{ ...workspace.preferences[0]!, revision: 2, answers: { ...workspace.preferences[0]!.answers, pace: "fast" } }],
    workspaceCursor: "2",
  }));
  expect(stableTrigger.isConnected).toBe(true);
  expect(screen.getByRole("button", { name: "保存我的偏好" })).toBe(stableTrigger);
  expect(screen.getByLabelText("旅行节奏")).toHaveValue("fast");
  await user.click(stableTrigger);

  expect(command).toHaveBeenCalledWith(expect.objectContaining({ action: "upsertPreference", expectedRevision: 2 }));
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
  const repository = { load: vi.fn().mockResolvedValue(placedWorkspace), refresh: vi.fn().mockResolvedValue(placedWorkspace), command: vi.fn(), events: vi.fn(), subscribe: vi.fn(() => () => undefined) } satisfies DecisionWorkspaceRepository;
  render(<DecisionWorkspacePage repository={repository} trip={trip} member={member} onBack={() => undefined} />);

  const adjust = await screen.findByRole("button", { name: "调整暂定日程" });
  const confirm = screen.getByRole("button", { name: "确认这张票根" });

  expect(adjust).toHaveClass("control-button--secondary");
  expect(adjust).not.toHaveClass("control-button--primary");
  expect(confirm).toHaveClass("control-button--primary");
});

test("keeps the disabled confirmation secondary until a candidate is placed", async () => {
  const unplacedWorkspace = { ...workspace, candidates: [candidate] } satisfies DecisionWorkspace;
  const repository = { load: vi.fn().mockResolvedValue(unplacedWorkspace), refresh: vi.fn().mockResolvedValue(unplacedWorkspace), command: vi.fn(), events: vi.fn(), subscribe: vi.fn(() => () => undefined) } satisfies DecisionWorkspaceRepository;
  render(<DecisionWorkspacePage repository={repository} trip={trip} member={member} onBack={() => undefined} />);

  const add = await screen.findByRole("button", { name: "加入暂定行程" });
  const confirm = screen.getByRole("button", { name: "确认这张票根" });

  expect(add.closest(".decision-action-row")?.querySelectorAll(".control-button--primary")).toHaveLength(1);
  expect(confirm).toBeDisabled();
  expect(confirm).toHaveClass("control-button--secondary");
  expect(confirm).not.toHaveClass("control-button--primary");
});

test("mounts the injected Codex research controls only for an administrator", async () => {
  const repository = { load: vi.fn().mockResolvedValue(workspace), refresh: vi.fn().mockResolvedValue(workspace), command: vi.fn(), events: vi.fn(), subscribe: vi.fn(() => () => undefined) } satisfies DecisionWorkspaceRepository;
  const agentBridge = {
    prepare: vi.fn(), claim: vi.fn(), executeTravelResearch: vi.fn(), getResearchStatus: vi.fn().mockResolvedValue({ phase: "idle" }),
    resumeTravelResearch: vi.fn(), cancelResearch: vi.fn(),
  };

  render(<DecisionWorkspacePage repository={repository} trip={trip} member={member} agentBridge={agentBridge} onBack={() => undefined} />);

  expect(await screen.findByRole("button", { name: "准备本机 Codex" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "Codex 旅行研究" })).toBeVisible();
});

test("queues a Codex completion refresh while a page command is busy and runs it once after the command settles", async () => {
  let finishCommand!: (result: DecisionCommandResult) => void;
  let finishStatus!: (status: ResearchStatus) => void;
  const command = vi.fn(() => new Promise<DecisionCommandResult>((resolve) => { finishCommand = resolve; }));
  const refreshed = { ...workspace, workspaceCursor: "1" } satisfies DecisionWorkspace;
  const repository = {
    load: vi.fn().mockResolvedValue(workspace),
    refresh: vi.fn().mockResolvedValue(refreshed),
    command,
    events: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
  } satisfies DecisionWorkspaceRepository;
  const agentBridge = {
    prepare: vi.fn(), claim: vi.fn(), executeTravelResearch: vi.fn(),
    getResearchStatus: vi.fn(() => new Promise<ResearchStatus>((resolve) => { finishStatus = resolve; })),
    resumeTravelResearch: vi.fn(), cancelResearch: vi.fn(),
  } satisfies LocalAgentBridge;
  render(<DecisionWorkspacePage repository={repository} trip={trip} member={member} agentBridge={agentBridge} onBack={() => undefined} />);
  await screen.findByRole("heading", { name: "两个人的偏好，正在汇成一张路线" });

  await userEvent.click(screen.getByRole("button", { name: "保存我的偏好" }));
  await act(async () => finishStatus({
    phase: "completed",
    tripId: trip.id,
    researchTaskId: "research-task-completed-while-busy",
    agentRunId: "agent-run-completed-while-busy",
    operationId: "operation-completed-while-busy",
    reconciliationState: "active",
    startedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:01:00.000Z",
  }));
  expect(repository.refresh).not.toHaveBeenCalled();

  await act(async () => finishCommand({ ok: false, error: "INVALID_REQUEST" }));

  await waitFor(() => expect(repository.refresh).toHaveBeenCalledTimes(1));
});

test("普通成员只看静态说明且 Bridge 全部零调用，仍可反馈和共同确认", async () => {
  const memberRole = { ...member, uid: "fs_member", displayName: "美垚", role: "member" as const };
  const memberWorkspace = {
    ...workspace,
    candidates: [candidate],
    placements: [{ id: "placement-1", tripId: trip.id, candidateId: candidate.id, tripDayId: "day-1", date: "2026-10-01", sortKey: "a0", status: "planned" as const, revision: 1, updatedAt: "2026-08-28T00:00:00.000Z" }],
  } satisfies DecisionWorkspace;
  const command = vi.fn().mockResolvedValue({ ok: false, error: "INVALID_REQUEST" });
  const repository = { load: vi.fn().mockResolvedValue(memberWorkspace), refresh: vi.fn().mockResolvedValue(memberWorkspace), command, events: vi.fn(), subscribe: vi.fn(() => () => undefined) } satisfies DecisionWorkspaceRepository;
  const agentBridge = {
    prepare: vi.fn(), claim: vi.fn(), executeTravelResearch: vi.fn(), getResearchStatus: vi.fn(), resumeTravelResearch: vi.fn(), cancelResearch: vi.fn(),
  };

  render(<DecisionWorkspacePage repository={repository} trip={trip} member={memberRole} agentBridge={agentBridge} onBack={() => undefined} />);

  expect(await screen.findByText("Codex 研究由设备管理员运行，完成后候选会出现在共同决定中")).toBeVisible();
  expect(screen.getAllByText("海边酒店").length).toBeGreaterThan(0);
  await userEvent.click(screen.getByRole("button", { name: "喜欢" }));
  expect(command).toHaveBeenCalledWith(expect.objectContaining({ action: "recordFeedback", candidateId: "candidate-1" }));
  expect(screen.getByRole("button", { name: "确认这张票根" })).toBeEnabled();
  for (const method of Object.values(agentBridge)) expect(method).not.toHaveBeenCalled();
  expect(screen.queryByText(/research-task|Codex 正在|ChatGPT\/Codex/)).not.toBeInTheDocument();
});
