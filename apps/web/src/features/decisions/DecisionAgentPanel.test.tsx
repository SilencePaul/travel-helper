import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  buildResearchTargetScopes,
  type DecisionWorkspace,
  type DecisionWorkspaceRepository,
  type ResearchStatus,
  type Trip,
} from "@travel/contracts";
import { describe, expect, it, vi } from "vitest";
import type { LocalAgentBridge } from "../../infrastructure/localAgentBridgeClient";
import { DecisionAgentPanel } from "./DecisionAgentPanel";

const prepared = {
  publicKeyJwk: { kty: "EC" as const, crv: "P-256" as const, x: "x-coordinate", y: "y-coordinate" },
  pairingCodeHash: "2g8DdGhJvqg00hyxT13Po40J6lVT92CRPLHZfoW3szI",
  pairingCodeFingerprint: "9A4F · 20C1",
};
const trip = {
  id: "trip-secret",
  title: "双人南下",
  startDate: "2026-10-01",
  endDate: "2026-10-03",
  travelers: [{ id: "traveler-admin-secret", name: "一鸣" }, { id: "traveler-member-secret", name: "美垚" }],
  days: [
    { id: "day-hk-secret-1", date: "2026-10-01", city: "香港", itemIds: [] },
    { id: "day-hk-secret-2", date: "2026-10-02", city: "香港", itemIds: [] },
    { id: "day-macau-secret", date: "2026-10-03", city: "澳门", itemIds: [] },
  ],
  unscheduledItemIds: [],
  orders: [],
  memberUids: ["fs-admin-secret", "fs-member-secret"],
  version: 4,
} satisfies Trip;
const hotelCandidate = {
  id: "candidate-secret",
  tripId: trip.id,
  category: "hotel" as const,
  entity: { name: "海景旅店", address: "香港中环" },
  applicability: { dates: { start: "2026-10-01", end: "2026-10-02" }, travelers: 2 },
  recommendation: { round: 1, reason: "交通方便", preferenceRevisionIds: [], feedbackIds: [] },
  verificationState: "web_verified" as const,
  decisionState: "tentative" as const,
  currentEvidenceId: "evidence-secret",
  revision: 2,
  updatedAt: "2026-08-28T00:00:00.000Z",
};
const workspace: DecisionWorkspace = {
  tripId: trip.id,
  preferences: [
    { id: "pref-admin-secret", tripId: trip.id, ownerUid: "fs-admin-secret", answers: { pace: "slow", accommodation: "quiet" }, freeText: { mustHave: "安静" }, status: "completed" as const, revision: 2, updatedAt: "2026-08-28T00:00:00.000Z", updatedBy: "fs-admin-secret" },
    { id: "pref-member-secret", tripId: trip.id, ownerUid: "fs-member-secret", answers: { pace: "balanced", dining: "本地小店" }, status: "completed" as const, revision: 3, updatedAt: "2026-08-28T00:00:00.000Z", updatedBy: "fs-member-secret" },
  ],
  summary: { id: "summary-secret", tripId: trip.id, sourcePreferenceRevisions: { "fs-admin-secret": 2, "fs-member-secret": 3 }, common: ["都想住得安静"], disagreements: ["步行节奏"], tradeoffs: ["早出发换少排队"], status: "ready" as const, generatedAt: "2026-08-28T00:00:00.000Z", revision: 1, updatedAt: "2026-08-28T00:00:00.000Z" },
  candidates: [hotelCandidate],
  placements: [],
  evidence: [{
    id: "evidence-secret", tripId: trip.id, candidateId: hotelCandidate.id, sourceKind: "official" as const,
    sourceName: "旅店官网", sourceUrl: "https://hotel.example/rooms?private=removed#fragment", capturedAt: "2026-08-28T00:00:00.000Z",
    queryContext: { dates: { start: "2026-10-01", end: "2026-10-02" }, travelers: 2 }, captureMethod: "detail_page" as const,
    facts: { propertyName: "海景旅店", address: "香港中环", checkInDate: "2026-10-01", checkOutDate: "2026-10-02", travelers: 2, roomTypeOrBed: "大床", availability: "available" as const, priceAmount: 1800, currency: "CNY", priceDisplay: "total" as const, cancellationPolicy: "可取消" },
    fieldCompleteness: [], verificationOutcome: "web_verified" as const, revision: 1, updatedAt: "2026-08-28T00:00:00.000Z",
  }],
  feedback: [{ id: "feedback-secret", tripId: trip.id, candidateId: hotelCandidate.id, actorUid: "fs-member-secret", kind: "like" as const, reason: "靠近地铁", createdAt: "2026-08-28T00:00:00.000Z", revision: 1, updatedAt: "2026-08-28T00:00:00.000Z" }],
  confirmations: [],
  workspaceCursor: "7",
  fetchedAt: "2026-08-28T00:00:00.000Z",
};

const timestamps = { researchTaskId: "research-task-1", startedAt: "2026-08-28T00:00:00.000Z", updatedAt: "2026-08-28T00:01:00.000Z" };
const researching = { phase: "researching", ...timestamps } satisfies ResearchStatus;
const cancelled = { phase: "cancelled", ...timestamps, errorCode: "CODEX_RESEARCH_CANCELLED" } satisfies ResearchStatus;

function makeBridge(overrides: Partial<LocalAgentBridge> = {}): LocalAgentBridge {
  return {
    prepare: vi.fn().mockResolvedValue(prepared),
    claim: vi.fn().mockResolvedValue({ agentRunId: "agent-run-1", status: "claimed" }),
    executeTravelResearch: vi.fn().mockResolvedValue(researching),
    getResearchStatus: vi.fn().mockResolvedValue({ phase: "idle" }),
    resumeTravelResearch: vi.fn().mockResolvedValue(researching),
    cancelResearch: vi.fn().mockResolvedValue(cancelled),
    ...overrides,
  };
}

function makeRepository(command = vi.fn().mockResolvedValue({ ok: true, action: "createAgentRun", data: { agentRunId: "agent-run-1", expiresAt: "2099-08-28T00:15:00.000Z" } })) {
  return { command, getAgentRunStatus: vi.fn().mockResolvedValue({
    agentRunId: "agent-run-1", tripId: trip.id, status: "claimed", scope: ["submitProposalBatch"], revision: 2, nextSequence: 1,
    createdAt: "2026-08-28T00:00:00.000Z", claimedAt: "2026-08-28T00:01:00.000Z", expiresAt: "2099-08-28T00:15:00.000Z",
  }) } as unknown as DecisionWorkspaceRepository;
}

function setup(options: {
  bridge?: LocalAgentBridge;
  repository?: DecisionWorkspaceRepository;
  onResearchCompleted?: () => void | Promise<void>;
  currentWorkspace?: DecisionWorkspace;
  newIdempotencyKey?: () => string;
} = {}) {
  const bridge = options.bridge ?? makeBridge();
  const repository = options.repository ?? makeRepository();
  const view = render(<DecisionAgentPanel
    repository={repository}
    bridge={bridge}
    trip={trip}
    workspace={options.currentWorkspace ?? workspace}
    onResearchCompleted={options.onResearchCompleted ?? vi.fn()}
    newIdempotencyKey={options.newIdempotencyKey ?? (() => "agent-request-001")}
  />);
  return { ...view, bridge, repository };
}

async function chooseHotelResearch() {
  await userEvent.click(screen.getByRole("radio", { name: /香港/ }));
  await userEvent.click(screen.getByRole("radio", { name: /^酒店/ }));
}

async function prepareAndConfirm() {
  await chooseHotelResearch();
  await userEvent.click(screen.getByRole("button", { name: "准备本机 Codex" }));
  await screen.findByText("本次将发送给 Codex");
  await userEvent.click(screen.getByRole("checkbox", { name: /我确认以上授权范围/ }));
}

async function unmountAndFlush(view: { unmount: () => void }) {
  await act(async () => {
    view.unmount();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function makeCreateAndRevokeCommand() {
  return vi.fn(async (input: { action: string }) => input.action === "createAgentRun"
    ? { ok: true, action: "createAgentRun" as const, data: { agentRunId: "agent-run-1", expiresAt: "2099-08-28T00:15:00.000Z" } }
    : { ok: true, action: "revokeAgentRun" as const, data: { agentRunId: "agent-run-1", revokedAt: "2026-08-28T00:05:00.000Z" } });
}

describe("DecisionAgentPanel", () => {
  it("准备只检查本机，并展示准确且无内部 ID 的授权披露", async () => {
    const { bridge, repository, container } = setup();

    expect(screen.getByRole("group", { name: "选择行程段" })).toBeVisible();
    expect(screen.getByRole("group", { name: "选择研究类别" })).toBeVisible();
    expect(screen.getByRole("button", { name: "准备本机 Codex" })).toBeDisabled();
    await chooseHotelResearch();
    await userEvent.click(screen.getByRole("button", { name: "准备本机 Codex" }));

    expect(await screen.findByText("本次将发送给 Codex")).toBeVisible();
    expect(bridge.prepare).toHaveBeenCalledWith(expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(repository.command).not.toHaveBeenCalled();
    expect(screen.getByText(/香港 · 2026-10-01 至 2026-10-02 · 2 人/)).toBeVisible();
    expect(screen.getByText("一鸣、美垚")).toBeVisible();
    expect(screen.getByText(/slow/)).toBeVisible();
    expect(screen.getByText("都想住得安静")).toBeVisible();
    expect(screen.getByText(/海景旅店.*靠近地铁/)).toBeVisible();
    expect(screen.getByText(/海景旅店.*香港中环/)).toBeVisible();
    expect(screen.getByText(/旅店官网/)).toBeVisible();
    expect(screen.getByText(/大床/)).toBeVisible();
    expect(screen.getByText("本次研究会保存在设备所有者的本机 Codex 历史中。")).toBeVisible();
    expect(screen.getByRole("button", { name: "开始研究酒店候选" })).toBeDisabled();
    expect(container.textContent).not.toMatch(/secret|resourceCommitments|digest|pairingCodeHash|x-coordinate/);
  });

  it("严格按 create → claim → execute 启动，固定 scope 和四字段请求，重复点击去重", async () => {
    const calls: string[] = [];
    let finishExecute!: (status: ResearchStatus) => void;
    const bridge = makeBridge({
      prepare: vi.fn(async () => { calls.push("prepare"); return prepared; }),
      claim: vi.fn(async () => { calls.push("claim"); return { agentRunId: "agent-run-1", status: "claimed" as const }; }),
      executeTravelResearch: vi.fn(() => { calls.push("execute"); return new Promise<ResearchStatus>((resolve) => { finishExecute = resolve; }); }),
    });
    const command = vi.fn(async (input) => {
      calls.push(input.action);
      return { ok: true, action: "createAgentRun" as const, data: { agentRunId: "agent-run-1", expiresAt: "2099-08-28T00:15:00.000Z" } };
    });
    setup({ bridge, repository: makeRepository(command) });
    await prepareAndConfirm();

    const start = screen.getByRole("button", { name: "开始研究酒店候选" });
    await userEvent.dblClick(start);
    expect(await screen.findByRole("status")).toHaveTextContent("正在请 Codex 搜索");
    expect(calls).toEqual(["prepare", "createAgentRun", "claim", "execute"]);
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ action: "createAgentRun", scope: ["submitProposalBatch"] }));
    expect(bridge.executeTravelResearch).toHaveBeenCalledTimes(1);
    expect(bridge.executeTravelResearch).toHaveBeenCalledWith({
      agentRunId: "agent-run-1",
      targetCategory: "hotel",
      targetScopeId: buildResearchTargetScopes({ version: trip.version, days: trip.days.map(({ id, date, city }) => ({ id, date, city })), travelerNames: ["一鸣", "美垚"], travelerCount: 2 })[0]!.targetScopeId,
      disclosureFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));

    await act(async () => finishExecute(researching));
    expect(screen.queryByText("agent-run-1")).not.toBeInTheDocument();
  });

  it("创建响应丢失时使用同一材料和幂等键重放，不创建重叠 run", async () => {
    const keys = ["create-attempt-1", "unexpected-create-2", "revoke-attempt-1"];
    const command = vi.fn()
      .mockRejectedValueOnce(new Error("create response lost"))
      .mockResolvedValueOnce({ ok: true, action: "createAgentRun", data: { agentRunId: "agent-run-1", expiresAt: "2099-08-28T00:15:00.000Z" } });
    const bridge = makeBridge();
    setup({ bridge, repository: makeRepository(command), newIdempotencyKey: () => keys.shift() ?? "unexpected" });
    await prepareAndConfirm();

    await userEvent.click(screen.getByRole("button", { name: "开始研究酒店候选" }));
    await screen.findByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: "开始研究酒店候选" }));

    await waitFor(() => expect(bridge.executeTravelResearch).toHaveBeenCalledTimes(1));
    const createInputs = command.mock.calls.map(([input]) => input).filter((input) => input.action === "createAgentRun");
    expect(createInputs).toHaveLength(2);
    expect(createInputs[0].idempotencyKey).toBe("create-attempt-1");
    expect(createInputs[1].idempotencyKey).toBe("create-attempt-1");
    expect(createInputs[1].pairingCodeHash).toBe(createInputs[0].pairingCodeHash);
  });

  it("create pending 时卸载会使迟到结果失效，只对账撤销而不 claim/execute/resume", async () => {
    let finishCreate!: (result: unknown) => void;
    const command = vi.fn((input: { action: string }) => input.action === "createAgentRun"
      ? new Promise((resolve) => { finishCreate = resolve; })
      : Promise.resolve({ ok: true, action: "revokeAgentRun", data: { agentRunId: "agent-run-1", revokedAt: "2026-08-28T00:05:00.000Z" } }));
    const bridge = makeBridge();
    const view = setup({ bridge, repository: makeRepository(command) });
    await prepareAndConfirm();
    await userEvent.click(screen.getByRole("button", { name: "开始研究酒店候选" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));

    view.unmount();
    await act(async () => finishCreate({ ok: true, action: "createAgentRun", data: { agentRunId: "agent-run-1", expiresAt: "2099-08-28T00:15:00.000Z" } }));

    await waitFor(() => expect(command.mock.calls.some(([input]) => input.action === "revokeAgentRun")).toBe(true));
    expect(bridge.claim).not.toHaveBeenCalled();
    expect(bridge.executeTravelResearch).not.toHaveBeenCalled();
    expect(bridge.resumeTravelResearch).not.toHaveBeenCalled();
  });

  it("claim 响应丢失时先读本机状态再撤销已知 run", async () => {
    const command = vi.fn()
      .mockResolvedValueOnce({ ok: true, action: "createAgentRun", data: { agentRunId: "agent-run-1", expiresAt: "2099-08-28T00:15:00.000Z" } })
      .mockResolvedValueOnce({ ok: true, action: "revokeAgentRun", data: { agentRunId: "agent-run-1", revokedAt: "2026-08-28T00:05:00.000Z" } });
    const bridge = makeBridge({
      claim: vi.fn().mockRejectedValue(new Error("claim response lost")),
      getResearchStatus: vi.fn().mockResolvedValue({ phase: "idle" }),
    });
    setup({ bridge, repository: makeRepository(command) });
    await prepareAndConfirm();

    await userEvent.click(screen.getByRole("button", { name: "开始研究酒店候选" }));

    await waitFor(() => expect(command).toHaveBeenCalledTimes(2));
    expect(bridge.getResearchStatus).toHaveBeenCalledTimes(2);
    expect(command.mock.calls.map(([input]) => input.action)).toEqual(["createAgentRun", "revokeAgentRun"]);
    expect(bridge.executeTravelResearch).not.toHaveBeenCalled();
  });

  it("execute 响应丢失时对账已有本机任务，不创建第二个 run", async () => {
    const bridge = makeBridge({
      executeTravelResearch: vi.fn().mockRejectedValue(new Error("execute response lost")),
      getResearchStatus: vi.fn().mockResolvedValueOnce({ phase: "idle" }).mockResolvedValue(researching),
    });
    const repository = makeRepository();
    const view = setup({ bridge, repository });
    await prepareAndConfirm();

    await userEvent.click(screen.getByRole("button", { name: "开始研究酒店候选" }));

    expect(await screen.findByText("正在请 Codex 搜索候选与可核验来源")).toBeVisible();
    expect(repository.command).toHaveBeenCalledTimes(1);
    expect(bridge.getResearchStatus).toHaveBeenCalledTimes(2);
    await unmountAndFlush(view);
    expect(repository.command).toHaveBeenCalledTimes(1);
  });

  it("resume 响应丢失时只恢复同一 researchTaskId 的本机状态", async () => {
    const blocked = { phase: "needs_owner_action", ...timestamps, blockedReason: "codex_auth_required" as const } satisfies ResearchStatus;
    const bridge = makeBridge({
      getResearchStatus: vi.fn().mockResolvedValueOnce(blocked).mockResolvedValue(researching),
      resumeTravelResearch: vi.fn().mockRejectedValue(new Error("resume response lost")),
    });
    const repository = makeRepository();
    const view = setup({ bridge, repository });

    await userEvent.click(await screen.findByRole("button", { name: "已恢复登录，继续研究" }));

    expect(await screen.findByText("正在请 Codex 搜索候选与可核验来源")).toBeVisible();
    expect(repository.command).toHaveBeenCalledTimes(1);
    expect(bridge.getResearchStatus).toHaveBeenCalledTimes(2);
    await unmountAndFlush(view);
    expect(repository.command).toHaveBeenCalledTimes(1);
  });

  it("resume 响应未到且状态仍是原 blocker 时撤销本次 run，不把旧状态当作新进展", async () => {
    const blocked = { phase: "needs_owner_action", ...timestamps, blockedReason: "codex_auth_required" as const } satisfies ResearchStatus;
    const command = vi.fn()
      .mockResolvedValueOnce({ ok: true, action: "createAgentRun", data: { agentRunId: "agent-run-1", expiresAt: "2099-08-28T00:15:00.000Z" } })
      .mockResolvedValueOnce({ ok: true, action: "revokeAgentRun", data: { agentRunId: "agent-run-1", revokedAt: "2026-08-28T00:05:00.000Z" } });
    const bridge = makeBridge({
      getResearchStatus: vi.fn().mockResolvedValue(blocked),
      resumeTravelResearch: vi.fn().mockRejectedValue(new Error("request did not reach bridge")),
    });
    const repository = makeRepository(command);
    setup({ bridge, repository });

    await userEvent.click(await screen.findByRole("button", { name: "已恢复登录，继续研究" }));

    await waitFor(() => expect(command).toHaveBeenCalledTimes(2));
    expect(command.mock.calls.map(([input]) => input.action)).toEqual(["createAgentRun", "revokeAgentRun"]);
    expect(bridge.resumeTravelResearch).toHaveBeenCalledTimes(1);
    expect(screen.getByText("research-task-1")).toBeVisible();
  });

  it("execute 响应未到且旧终态只变 updatedAt 时撤销本次 run，不把时间戳当作新进展", async () => {
    const oldCompleted = { phase: "completed", ...timestamps } satisfies ResearchStatus;
    const oldCompletedWithNewTimestamp = { ...oldCompleted, updatedAt: "2026-08-28T00:02:00.000Z" } satisfies ResearchStatus;
    const command = vi.fn()
      .mockResolvedValueOnce({ ok: true, action: "createAgentRun", data: { agentRunId: "agent-run-1", expiresAt: "2099-08-28T00:15:00.000Z" } })
      .mockResolvedValueOnce({ ok: true, action: "revokeAgentRun", data: { agentRunId: "agent-run-1", revokedAt: "2026-08-28T00:05:00.000Z" } });
    const bridge = makeBridge({
      getResearchStatus: vi.fn().mockResolvedValueOnce(oldCompleted).mockResolvedValue(oldCompletedWithNewTimestamp),
      executeTravelResearch: vi.fn().mockRejectedValue(new Error("request did not reach bridge")),
    });
    const repository = makeRepository(command);
    setup({ bridge, repository });
    await screen.findByText("Codex 候选已写入共同决定");
    await prepareAndConfirm();

    await userEvent.click(screen.getByRole("button", { name: "开始研究酒店候选" }));

    await waitFor(() => expect(command).toHaveBeenCalledTimes(2));
    expect(command.mock.calls.map(([input]) => input.action)).toEqual(["createAgentRun", "revokeAgentRun"]);
    expect(screen.getByText("research-task-1")).toBeVisible();
  });

  it.each([
    ["failed", { phase: "failed", ...timestamps, errorCode: "CODEX_RESEARCH_FAILED" as const } satisfies ResearchStatus],
    ["superseded", { phase: "superseded", ...timestamps, errorCode: "DISCLOSURE_CONTEXT_CHANGED" as const } satisfies ResearchStatus],
  ] as const)("旧 %s 清除 UI 后，新 execute 未到 Bridge 仍以最后真实观测为 baseline 并撤销", async (_label, terminal) => {
    const command = makeCreateAndRevokeCommand();
    const bridge = makeBridge({
      getResearchStatus: vi.fn().mockResolvedValue(terminal),
      executeTravelResearch: vi.fn().mockRejectedValue(new Error("request did not reach bridge")),
    });
    setup({ bridge, repository: makeRepository(command) });
    await userEvent.click(await screen.findByRole("button", { name: "重新选择研究范围" }));
    await prepareAndConfirm();

    await userEvent.click(screen.getByRole("button", { name: "开始研究酒店候选" }));

    await waitFor(() => expect(command).toHaveBeenCalledTimes(2));
    expect(command.mock.calls.map(([input]) => input.action)).toEqual(["createAgentRun", "revokeAgentRun"]);
    expect(screen.getByRole("alert")).toHaveTextContent(/启动响应未确认/);
  });

  it.each([
    ["新进展", "progress", 1],
    ["原 baseline", "baseline", 2],
    ["状态读取失败", "error", 1],
  ] as const)("execute promise pending 时卸载，Bridge %s 按接管证据决定是否撤销", async (_label, cleanupResult, expectedCommands) => {
    const command = makeCreateAndRevokeCommand();
    const getResearchStatus = vi.fn().mockResolvedValueOnce({ phase: "idle" });
    if (cleanupResult === "progress") getResearchStatus.mockResolvedValueOnce(researching);
    else if (cleanupResult === "baseline") getResearchStatus.mockResolvedValueOnce({ phase: "idle" });
    else getResearchStatus.mockRejectedValueOnce(new Error("status unavailable"));
    const bridge = makeBridge({
      getResearchStatus,
      executeTravelResearch: vi.fn(() => new Promise<ResearchStatus>(() => undefined)),
    });
    const view = setup({ bridge, repository: makeRepository(command) });
    await prepareAndConfirm();
    await userEvent.click(screen.getByRole("button", { name: "开始研究酒店候选" }));
    await waitFor(() => expect(bridge.executeTravelResearch).toHaveBeenCalledTimes(1));

    await unmountAndFlush(view);

    expect(getResearchStatus).toHaveBeenCalledTimes(2);
    expect(getResearchStatus.mock.calls[1]?.[0]).toEqual({ signal: expect.any(AbortSignal) });
    expect(getResearchStatus.mock.calls[1]?.[0]?.signal).not.toBe(vi.mocked(bridge.executeTravelResearch).mock.calls[0]?.[1]?.signal);
    if (expectedCommands === 2) await waitFor(() => expect(command).toHaveBeenCalledTimes(2));
    else expect(command).toHaveBeenCalledTimes(1);
    expect(bridge.cancelResearch).not.toHaveBeenCalled();
  });

  it.each([
    ["新进展", "progress", 1],
    ["原 baseline", "baseline", 2],
    ["状态读取失败", "error", 1],
  ] as const)("resume promise pending 时卸载，Bridge %s 按接管证据决定是否撤销", async (_label, cleanupResult, expectedCommands) => {
    const blocked = { phase: "needs_owner_action", ...timestamps, blockedReason: "codex_auth_required" as const } satisfies ResearchStatus;
    const resuming = { phase: "resuming", ...timestamps, updatedAt: "2026-08-28T00:02:00.000Z" } satisfies ResearchStatus;
    const command = makeCreateAndRevokeCommand();
    const getResearchStatus = vi.fn().mockResolvedValueOnce(blocked);
    if (cleanupResult === "progress") getResearchStatus.mockResolvedValueOnce(resuming);
    else if (cleanupResult === "baseline") getResearchStatus.mockResolvedValueOnce(blocked);
    else getResearchStatus.mockRejectedValueOnce(new Error("status unavailable"));
    const bridge = makeBridge({
      getResearchStatus,
      resumeTravelResearch: vi.fn(() => new Promise<ResearchStatus>(() => undefined)),
    });
    const view = setup({ bridge, repository: makeRepository(command) });
    await userEvent.click(await screen.findByRole("button", { name: "已恢复登录，继续研究" }));
    await waitFor(() => expect(bridge.resumeTravelResearch).toHaveBeenCalledTimes(1));

    await unmountAndFlush(view);

    expect(getResearchStatus).toHaveBeenCalledTimes(2);
    expect(getResearchStatus.mock.calls[1]?.[0]).toEqual({ signal: expect.any(AbortSignal) });
    expect(getResearchStatus.mock.calls[1]?.[0]?.signal).not.toBe(vi.mocked(bridge.resumeTravelResearch).mock.calls[0]?.[1]?.signal);
    if (expectedCommands === 2) await waitFor(() => expect(command).toHaveBeenCalledTimes(2));
    else expect(command).toHaveBeenCalledTimes(1);
    expect(bridge.cancelResearch).not.toHaveBeenCalled();
  });

  it("execute 成功接管 run 后卸载不撤销也不取消，本机任务继续", async () => {
    const bridge = makeBridge({ executeTravelResearch: vi.fn().mockResolvedValue(researching) });
    const repository = makeRepository();
    const view = setup({ bridge, repository });
    await prepareAndConfirm();
    await userEvent.click(screen.getByRole("button", { name: "开始研究酒店候选" }));
    await screen.findByText("正在请 Codex 搜索候选与可核验来源");

    await unmountAndFlush(view);

    expect(repository.command).toHaveBeenCalledTimes(1);
    expect(bridge.cancelResearch).not.toHaveBeenCalled();
  });

  it("resume 成功接管 run 后卸载不撤销也不取消，本机任务继续", async () => {
    const blocked = { phase: "needs_owner_action", ...timestamps, blockedReason: "codex_auth_required" as const } satisfies ResearchStatus;
    const resuming = { phase: "resuming", ...timestamps, updatedAt: "2026-08-28T00:02:00.000Z" } satisfies ResearchStatus;
    const bridge = makeBridge({
      getResearchStatus: vi.fn().mockResolvedValue(blocked),
      resumeTravelResearch: vi.fn().mockResolvedValue(resuming),
    });
    const repository = makeRepository();
    const view = setup({ bridge, repository });
    await userEvent.click(await screen.findByRole("button", { name: "已恢复登录，继续研究" }));
    await screen.findByText("Codex 正在继续研究");

    await unmountAndFlush(view);

    expect(repository.command).toHaveBeenCalledTimes(1);
    expect(bridge.cancelResearch).not.toHaveBeenCalled();
  });

  it("撤销响应丢失时保留 pending run 并用稳定 key 先对账，不启动新 run", async () => {
    const keys = ["create-key", "revoke-key", "unexpected-new-create"];
    const command = vi.fn()
      .mockResolvedValueOnce({ ok: true, action: "createAgentRun", data: { agentRunId: "agent-run-1", expiresAt: "2099-08-28T00:15:00.000Z" } })
      .mockRejectedValueOnce(new Error("revoke response lost"))
      .mockResolvedValueOnce({ ok: true, action: "revokeAgentRun", data: { agentRunId: "agent-run-1", revokedAt: "2026-08-28T00:05:00.000Z" } });
    const bridge = makeBridge({
      claim: vi.fn().mockRejectedValue(new Error("claim response lost")),
      getResearchStatus: vi.fn().mockResolvedValue({ phase: "idle" }),
    });
    setup({ bridge, repository: makeRepository(command), newIdempotencyKey: () => keys.shift() ?? "unexpected" });
    await prepareAndConfirm();
    await userEvent.click(screen.getByRole("button", { name: "开始研究酒店候选" }));
    await screen.findByRole("alert");

    await userEvent.click(screen.getByRole("button", { name: "开始研究酒店候选" }));

    await waitFor(() => expect(command).toHaveBeenCalledTimes(3));
    expect(command.mock.calls.map(([input]) => input.action)).toEqual(["createAgentRun", "revokeAgentRun", "revokeAgentRun"]);
    expect(command.mock.calls[1]![0].idempotencyKey).toBe("revoke-key");
    expect(command.mock.calls[2]![0].idempotencyKey).toBe("revoke-key");
  });

  it.each([
    ["resuming", "Codex 正在继续研究"],
    ["validating", "正在校验候选与来源"],
    ["writing", "正在安全写入共同决定"],
    ["failed", "Codex 研究未完成"],
  ] as const)("为 %s 阶段显示可访问文案", async (phase, copy) => {
    const status = phase === "failed"
      ? { phase, ...timestamps, errorCode: "CODEX_RESEARCH_FAILED" as const }
      : { phase, ...timestamps };
    setup({ bridge: makeBridge({ getResearchStatus: vi.fn().mockResolvedValue(status) }) });

    expect(await screen.findByText(copy)).toBeVisible();
    expect(screen.getByRole(phase === "failed" ? "alert" : "status")).toBeVisible();
  });

  it("完成时调用父级 refresh，使候选立即出现", async () => {
    const onResearchCompleted = vi.fn().mockResolvedValue(undefined);
    setup({ bridge: makeBridge({ getResearchStatus: vi.fn().mockResolvedValue({ phase: "completed", ...timestamps }) }), onResearchCompleted });

    expect(await screen.findByText("Codex 候选已写入共同决定")).toBeVisible();
    await waitFor(() => expect(onResearchCompleted).toHaveBeenCalledTimes(1));
  });

  it("认证阻断不提供登录输入，恢复时 prepare 新 run 后继续旧 task", async () => {
    const calls: string[] = [];
    const blocked = { phase: "needs_owner_action", ...timestamps, blockedReason: "codex_auth_required" as const } satisfies ResearchStatus;
    const bridge = makeBridge({
      getResearchStatus: vi.fn().mockResolvedValue(blocked),
      prepare: vi.fn(async () => { calls.push("prepare"); return prepared; }),
      claim: vi.fn(async () => { calls.push("claim"); return { agentRunId: "agent-run-1", status: "claimed" as const }; }),
      resumeTravelResearch: vi.fn(async () => { calls.push("resume"); return researching; }),
    });
    const command = vi.fn(async (input) => { calls.push(input.action); return { ok: true, action: "createAgentRun" as const, data: { agentRunId: "agent-run-1", expiresAt: "2099-08-28T00:15:00.000Z" } }; });
    setup({ bridge, repository: makeRepository(command) });

    expect(await screen.findByRole("alert")).toHaveTextContent("请在 ChatGPT/Codex 中恢复登录");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByText("agent-run-1")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "已恢复登录，继续研究" }));

    await waitFor(() => expect(calls).toEqual(["prepare", "createAgentRun", "claim", "resume"]));
    expect(bridge.resumeTravelResearch).toHaveBeenCalledWith({ agentRunId: "agent-run-1", researchTaskId: "research-task-1", resumeAction: "retry_codex_auth" }, expect.anything());
  });

  it("外部来源阻断只显示净化 hostname 和固定跳过动作", async () => {
    setup({ bridge: makeBridge({ getResearchStatus: vi.fn().mockResolvedValue({ phase: "needs_owner_action", ...timestamps, blockedReason: "source_captcha", blockedHostname: "booking.example.com" }) }) });

    expect(await screen.findByRole("alert")).toHaveTextContent("booking.example.com");
    expect(screen.getByRole("button", { name: "跳过该来源并继续" })).toBeVisible();
    expect(document.body.textContent).not.toMatch(/https?:|Cookie|验证码输入|密码/);
  });

  it("已确认投影变化会立即清除确认并将旧任务标记为 superseded", async () => {
    const blocked = { phase: "needs_owner_action", ...timestamps, blockedReason: "codex_auth_required" as const } satisfies ResearchStatus;
    const bridge = makeBridge({ executeTravelResearch: vi.fn().mockResolvedValue(blocked) });
    const view = setup({ bridge });
    await prepareAndConfirm();
    await userEvent.click(screen.getByRole("button", { name: "开始研究酒店候选" }));
    expect(await screen.findByText(/请在 ChatGPT\/Codex 中恢复登录/)).toBeVisible();
    expect(screen.queryByText("agent-run-1")).not.toBeInTheDocument();

    view.rerender(<DecisionAgentPanel repository={view.repository} bridge={bridge} trip={trip} workspace={{ ...workspace, summary: { ...workspace.summary!, common: ["改成接近码头"] }, workspaceCursor: "8" }} onResearchCompleted={vi.fn()} newIdempotencyKey={() => "agent-request-002"} />);

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("将发送的内容已更新，请重新确认"));
    expect(await screen.findByRole("checkbox", { name: /我确认/ })).not.toBeChecked();
    expect(bridge.resumeTravelResearch).not.toHaveBeenCalled();
  });

  it("安全投影指纹未变时恢复原任务，不要求重复确认", async () => {
    const blocked = { phase: "needs_owner_action", ...timestamps, blockedReason: "codex_auth_required" as const } satisfies ResearchStatus;
    const bridge = makeBridge({ executeTravelResearch: vi.fn().mockResolvedValue(blocked) });
    const view = setup({ bridge });
    await prepareAndConfirm();
    await userEvent.click(screen.getByRole("button", { name: "开始研究酒店候选" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("请在 ChatGPT/Codex 中恢复登录");

    view.rerender(<DecisionAgentPanel
      repository={view.repository}
      bridge={bridge}
      trip={trip}
      workspace={{ ...workspace, workspaceCursor: "99", fetchedAt: "2026-08-28T01:00:00.000Z" }}
      onResearchCompleted={vi.fn()}
      newIdempotencyKey={() => "agent-request-002"}
    />);
    await userEvent.click(screen.getByRole("button", { name: "已恢复登录，继续研究" }));

    await waitFor(() => expect(bridge.resumeTravelResearch).toHaveBeenCalledWith({
      agentRunId: "agent-run-1",
      researchTaskId: "research-task-1",
      resumeAction: "retry_codex_auth",
    }, expect.anything()));
  });

  it("规范投影只是数组重排或等价净化 URL 时指纹不变，不 supersede 且仍可 resume", async () => {
    const blocked = { phase: "needs_owner_action", ...timestamps, blockedReason: "codex_auth_required" as const } satisfies ResearchStatus;
    const bridge = makeBridge({ executeTravelResearch: vi.fn().mockResolvedValue(blocked) });
    const view = setup({ bridge });
    await prepareAndConfirm();
    await userEvent.click(screen.getByRole("button", { name: "开始研究酒店候选" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("请在 ChatGPT/Codex 中恢复登录");

    view.rerender(<DecisionAgentPanel
      repository={view.repository}
      bridge={bridge}
      trip={trip}
      workspace={{
        ...workspace,
        preferences: [...workspace.preferences].reverse(),
        candidates: [...workspace.candidates].reverse(),
        evidence: [...workspace.evidence].reverse().map((item) => ({ ...item, sourceUrl: "https://other.example/ignored#fragment" })),
        feedback: [...workspace.feedback].reverse(),
      }}
      onResearchCompleted={vi.fn()}
      newIdempotencyKey={() => "agent-request-reordered"}
    />);

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("请在 ChatGPT/Codex 中恢复登录"));
    expect(screen.queryByText(/将发送的内容已更新/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "已恢复登录，继续研究" }));
    await waitFor(() => expect(bridge.resumeTravelResearch).toHaveBeenCalledTimes(1));
  });

  it("指纹变化的 blocker 必须先 cancel 并对账清除持久状态，才能创建新任务", async () => {
    const blocked = { phase: "needs_owner_action", ...timestamps, blockedReason: "codex_auth_required" as const } satisfies ResearchStatus;
    const nextResearching = { phase: "researching", ...timestamps, researchTaskId: "research-task-2", updatedAt: "2026-08-28T00:03:00.000Z" } satisfies ResearchStatus;
    let status: ResearchStatus = { phase: "idle" };
    let blockerPersisted = false;
    let executions = 0;
    const bridge = makeBridge({
      getResearchStatus: vi.fn(async () => status),
      prepare: vi.fn(async () => {
        if (blockerPersisted) throw new Error("BRIDGE_BUSY");
        return prepared;
      }),
      executeTravelResearch: vi.fn(async () => {
        executions += 1;
        status = executions === 1 ? blocked : nextResearching;
        blockerPersisted = executions === 1;
        return status;
      }),
      cancelResearch: vi.fn(async ({ researchTaskId }) => {
        expect(researchTaskId).toBe(blocked.researchTaskId);
        blockerPersisted = false;
        status = cancelled;
        return cancelled;
      }),
    });
    let run = 0;
    const command = vi.fn(async () => {
      run += 1;
      return { ok: true, action: "createAgentRun" as const, data: { agentRunId: `agent-run-${run}`, expiresAt: "2099-08-28T00:15:00.000Z" } };
    });
    const view = setup({ bridge, repository: makeRepository(command) });
    await prepareAndConfirm();
    await userEvent.click(screen.getByRole("button", { name: "开始研究酒店候选" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("请在 ChatGPT/Codex 中恢复登录");

    view.rerender(<DecisionAgentPanel repository={view.repository} bridge={bridge} trip={trip} workspace={{ ...workspace, summary: { ...workspace.summary!, common: ["改成靠近码头"] } }} onResearchCompleted={vi.fn()} newIdempotencyKey={() => `request-${run + 1}`} />);
    await userEvent.click(await screen.findByRole("button", { name: "重新选择研究范围" }));

    await waitFor(() => expect(bridge.cancelResearch).toHaveBeenCalledTimes(1));
    expect(bridge.resumeTravelResearch).not.toHaveBeenCalled();
    await prepareAndConfirm();
    await userEvent.click(screen.getByRole("button", { name: "开始研究酒店候选" }));
    expect(await screen.findByText("正在请 Codex 搜索候选与可核验来源")).toBeVisible();
    expect(command).toHaveBeenCalledTimes(2);
    expect(bridge.executeTravelResearch).toHaveBeenCalledTimes(2);
  });

  it("指纹变化 blocker 的 cancel 对账不确定时保持告警且绝不创建新 run", async () => {
    const blocked = { phase: "needs_owner_action", ...timestamps, blockedReason: "codex_auth_required" as const } satisfies ResearchStatus;
    let status: ResearchStatus = { phase: "idle" };
    const bridge = makeBridge({
      getResearchStatus: vi.fn(async () => status),
      executeTravelResearch: vi.fn(async () => {
        status = blocked;
        return blocked;
      }),
      cancelResearch: vi.fn().mockRejectedValue(new Error("cancel response lost")),
    });
    const repository = makeRepository();
    const view = setup({ bridge, repository });
    await prepareAndConfirm();
    await userEvent.click(screen.getByRole("button", { name: "开始研究酒店候选" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("恢复登录");
    view.rerender(<DecisionAgentPanel repository={repository} bridge={bridge} trip={trip} workspace={{ ...workspace, summary: { ...workspace.summary!, common: ["改成靠近码头"] } }} onResearchCompleted={vi.fn()} newIdempotencyKey={() => "request-2"} />);

    await userEvent.click(await screen.findByRole("button", { name: "重新选择研究范围" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/旧任务|对账|未确认/);
    expect(screen.getByRole("button", { name: "准备本机 Codex" })).toBeDisabled();
    expect(repository.command).toHaveBeenCalledTimes(1);
  });

  it("resume 的 prepare 在 attempt 创建前失败也会退出 busy 并提供可重试动作", async () => {
    const blocked = { phase: "needs_owner_action", ...timestamps, blockedReason: "codex_auth_required" as const } satisfies ResearchStatus;
    const bridge = makeBridge({
      getResearchStatus: vi.fn().mockResolvedValue(blocked),
      prepare: vi.fn().mockRejectedValue(new Error("BRIDGE_BUSY")),
    });
    setup({ bridge });

    await userEvent.click(await screen.findByRole("button", { name: "已恢复登录，继续研究" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/本机 Codex|继续研究/);
    expect(screen.getByRole("button", { name: "已恢复登录，继续研究" })).toBeEnabled();
  });

  it("初始 Bridge 状态未读取前严格禁止准备和创建，重试成功后才开放", async () => {
    const getResearchStatus = vi.fn()
      .mockRejectedValueOnce(new Error("status unavailable"))
      .mockResolvedValueOnce({ phase: "idle" });
    const bridge = makeBridge({ getResearchStatus });
    const repository = makeRepository();
    setup({ bridge, repository });

    const retry = await screen.findByRole("button", { name: "重新读取本机状态" });
    await waitFor(() => expect(retry).toHaveFocus());
    expect(screen.getByRole("button", { name: "准备本机 Codex" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "返回研究设置" })).not.toBeInTheDocument();
    expect(bridge.prepare).not.toHaveBeenCalled();
    expect(repository.command).not.toHaveBeenCalled();

    await userEvent.click(retry);

    await waitFor(() => expect(getResearchStatus).toHaveBeenCalledTimes(2));
    await chooseHotelResearch();
    await waitFor(() => expect(screen.getByRole("button", { name: "准备本机 Codex" })).toBeEnabled());
  });

  it("failed 不假定 Bridge 已 self-revoke，当前 attached run 必须经云端对账撤销", async () => {
    const failed = { phase: "failed", ...timestamps, errorCode: "AGENT_TRANSPORT_UNAVAILABLE" as const } satisfies ResearchStatus;
    const command = makeCreateAndRevokeCommand();
    const bridge = makeBridge({ executeTravelResearch: vi.fn().mockResolvedValue(failed) });
    setup({ bridge, repository: makeRepository(command) });
    await prepareAndConfirm();

    await userEvent.click(screen.getByRole("button", { name: "开始研究酒店候选" }));

    await waitFor(() => expect(command).toHaveBeenCalledTimes(2));
    expect(command.mock.calls.map(([input]) => input.action)).toEqual(["createAgentRun", "revokeAgentRun"]);
  });

  it("failed run 的 revoke 响应丢失时保留句柄和稳定 key，下次操作先对账", async () => {
    const failed = { phase: "failed", ...timestamps, errorCode: "AGENT_TRANSPORT_UNAVAILABLE" as const } satisfies ResearchStatus;
    const keys = ["create-key", "revoke-key", "unexpected-key"];
    const command = vi.fn()
      .mockResolvedValueOnce({ ok: true, action: "createAgentRun", data: { agentRunId: "agent-run-1", expiresAt: "2099-08-28T00:15:00.000Z" } })
      .mockRejectedValueOnce(new Error("revoke response lost"))
      .mockResolvedValueOnce({ ok: true, action: "revokeAgentRun", data: { agentRunId: "agent-run-1", revokedAt: "2026-08-28T00:05:00.000Z" } });
    const repository = makeRepository(command);
    setup({ bridge: makeBridge({ executeTravelResearch: vi.fn().mockResolvedValue(failed) }), repository, newIdempotencyKey: () => keys.shift() ?? "unexpected" });
    await prepareAndConfirm();
    await userEvent.click(screen.getByRole("button", { name: "开始研究酒店候选" }));

    const retry = await screen.findByRole("button", { name: "继续撤销云端授权" });
    expect(screen.getByRole("alert")).toHaveTextContent(/撤销尚未确认/);
    await userEvent.click(retry);

    await waitFor(() => expect(command).toHaveBeenCalledTimes(3));
    expect(command.mock.calls[1]![0].idempotencyKey).toBe("revoke-key");
    expect(command.mock.calls[2]![0].idempotencyKey).toBe("revoke-key");
    expect(repository.getAgentRunStatus).toHaveBeenCalledTimes(2);
  });

  it("活跃期发现云端 run 已外部撤销时，只发一次 local cancel 并对账 Bridge 终态", async () => {
    let finishExecute!: (status: ResearchStatus) => void;
    const bridge = makeBridge({
      executeTravelResearch: vi.fn(() => new Promise<ResearchStatus>((resolve) => { finishExecute = resolve; })),
      getResearchStatus: vi.fn().mockResolvedValueOnce({ phase: "idle" }).mockResolvedValue(cancelled),
      cancelResearch: vi.fn().mockResolvedValue(cancelled),
    });
    const repository = makeRepository();
    vi.mocked(repository.getAgentRunStatus!).mockResolvedValue({
      agentRunId: "agent-run-1", tripId: trip.id, status: "revoked", scope: ["submitProposalBatch"], revision: 3, nextSequence: 1,
      createdAt: "2026-08-28T00:00:00.000Z", claimedAt: "2026-08-28T00:01:00.000Z", expiresAt: "2099-08-28T00:15:00.000Z", revokedAt: "2026-08-28T00:02:00.000Z",
    });
    setup({ bridge, repository });
    await prepareAndConfirm();
    await userEvent.click(screen.getByRole("button", { name: "开始研究酒店候选" }));
    await waitFor(() => expect(bridge.executeTravelResearch).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();
    try {
      await act(async () => finishExecute(researching));
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(bridge.cancelResearch).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Codex 研究已停止")).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it("活跃云端 run 正常时只轮询状态且不 cancel", async () => {
    let finishExecute!: (status: ResearchStatus) => void;
    const bridge = makeBridge({ executeTravelResearch: vi.fn(() => new Promise<ResearchStatus>((resolve) => { finishExecute = resolve; })) });
    const repository = makeRepository();
    setup({ bridge, repository });
    await prepareAndConfirm();
    await userEvent.click(screen.getByRole("button", { name: "开始研究酒店候选" }));
    await waitFor(() => expect(bridge.executeTravelResearch).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();
    try {
      await act(async () => finishExecute(researching));
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(repository.getAgentRunStatus).toHaveBeenCalledTimes(1);
      expect(bridge.cancelResearch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("活跃轮询在云端状态读取 pending 时不启动重叠轮询", async () => {
    let finishExecute!: (status: ResearchStatus) => void;
    const repository = makeRepository();
    vi.mocked(repository.getAgentRunStatus!).mockImplementation(() => new Promise(() => undefined));
    const bridge = makeBridge({ executeTravelResearch: vi.fn(() => new Promise<ResearchStatus>((resolve) => { finishExecute = resolve; })) });
    setup({ bridge, repository });
    await prepareAndConfirm();
    await userEvent.click(screen.getByRole("button", { name: "开始研究酒店候选" }));
    await waitFor(() => expect(bridge.executeTravelResearch).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();
    try {
      await act(async () => finishExecute(researching));
      await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
      expect(repository.getAgentRunStatus).toHaveBeenCalledTimes(1);
      expect(bridge.cancelResearch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("等价 trip 对象换引用保持确认和 attached run，真实安全投影变化才 abort", async () => {
    const bridge = makeBridge();
    const repository = makeRepository();
    const view = setup({ bridge, repository });
    await prepareAndConfirm();
    await userEvent.click(screen.getByRole("button", { name: "开始研究酒店候选" }));
    expect(await screen.findByText("正在请 Codex 搜索候选与可核验来源")).toBeVisible();
    const executeSignal = vi.mocked(bridge.executeTravelResearch).mock.calls[0]![1]!.signal;
    const equivalentTrip = { ...trip, travelers: trip.travelers.map((item) => ({ ...item })), days: trip.days.map((day) => ({ ...day, itemIds: [...day.itemIds] })), orders: [...trip.orders] };

    view.rerender(<DecisionAgentPanel repository={repository} bridge={bridge} trip={equivalentTrip} workspace={workspace} onResearchCompleted={vi.fn()} newIdempotencyKey={() => "equivalent"} />);

    expect(screen.getByText("正在请 Codex 搜索候选与可核验来源")).toBeVisible();
    expect(executeSignal?.aborted).toBe(false);
    expect(bridge.getResearchStatus).toHaveBeenCalledTimes(1);
    expect(repository.command).toHaveBeenCalledTimes(1);

    view.rerender(<DecisionAgentPanel repository={repository} bridge={bridge} trip={{ ...equivalentTrip, days: equivalentTrip.days.map((day, index) => index === 0 ? { ...day, city: "九龙" } : day) }} workspace={workspace} onResearchCompleted={vi.fn()} newIdempotencyKey={() => "changed"} />);
    expect(executeSignal?.aborted).toBe(true);
  });

  it("响应丢失的首次对账读取使用 operation signal，unmount abort 后只保留 cleanup 独立读取", async () => {
    let operationSignal: AbortSignal | undefined;
    const getResearchStatus = vi.fn()
      .mockResolvedValueOnce({ phase: "idle" })
      .mockImplementationOnce((options?: { signal?: AbortSignal }) => new Promise<ResearchStatus>((_resolve, reject) => {
        operationSignal = options?.signal;
        operationSignal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }))
      .mockResolvedValueOnce({ phase: "idle" });
    const command = makeCreateAndRevokeCommand();
    const bridge = makeBridge({
      getResearchStatus,
      executeTravelResearch: vi.fn().mockRejectedValue(new Error("response lost")),
    });
    const view = setup({ bridge, repository: makeRepository(command) });
    await prepareAndConfirm();
    await userEvent.click(screen.getByRole("button", { name: "开始研究酒店候选" }));
    await waitFor(() => expect(getResearchStatus).toHaveBeenCalledTimes(2));

    await unmountAndFlush(view);

    await waitFor(() => expect(getResearchStatus).toHaveBeenCalledTimes(3));
    expect(operationSignal).toBeInstanceOf(AbortSignal);
    expect(operationSignal?.aborted).toBe(true);
    const cleanupSignal = getResearchStatus.mock.calls[2]?.[0]?.signal;
    expect(cleanupSignal).toBeInstanceOf(AbortSignal);
    expect(cleanupSignal).not.toBe(operationSignal);
  });

  it("停止严格按 local cancel → local status 对账 → cloud revoke", async () => {
    const calls: string[] = [];
    const bridge = makeBridge({
      executeTravelResearch: vi.fn().mockResolvedValue(researching),
      cancelResearch: vi.fn(async () => { calls.push("cancel"); return cancelled; }),
      getResearchStatus: vi.fn()
        .mockResolvedValueOnce({ phase: "idle" })
        .mockImplementation(async () => { calls.push("status"); return cancelled; }),
    });
    const command = vi.fn(async (input) => {
      calls.push(input.action === "revokeAgentRun" ? "revoke" : "create");
      return input.action === "createAgentRun"
        ? { ok: true, action: "createAgentRun" as const, data: { agentRunId: "agent-run-1", expiresAt: "2099-08-28T00:15:00.000Z" } }
        : { ok: true, action: "revokeAgentRun" as const, data: { agentRunId: "agent-run-1", revokedAt: "2026-08-28T00:05:00.000Z" } };
    });
    setup({ bridge, repository: makeRepository(command) });
    await prepareAndConfirm();
    await userEvent.click(screen.getByRole("button", { name: "开始研究酒店候选" }));
    await screen.findByText(/正在请 Codex 搜索/);
    calls.length = 0;

    await userEvent.click(screen.getByRole("button", { name: "停止搜索" }));

    expect(await screen.findByText("Codex 研究已停止")).toBeVisible();
    expect(calls).toEqual(["cancel", "status", "revoke"]);
  });

  it("写入期取消结果不确定时不宣称停止成功，也不提前撤销", async () => {
    const writing = { phase: "writing", ...timestamps } satisfies ResearchStatus;
    const bridge = makeBridge({
      executeTravelResearch: vi.fn().mockResolvedValue(writing),
      cancelResearch: vi.fn().mockRejectedValue(new Error("response lost")),
      getResearchStatus: vi.fn().mockResolvedValueOnce({ phase: "idle" }).mockResolvedValue(writing),
    });
    const repository = makeRepository();
    setup({ bridge, repository });
    await prepareAndConfirm();
    await userEvent.click(screen.getByRole("button", { name: "开始研究酒店候选" }));

    await userEvent.click(await screen.findByRole("button", { name: "停止搜索" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("写入结果尚未确认");
    expect(screen.queryByText("Codex 研究已停止")).not.toBeInTheDocument();
    expect(repository.command).toHaveBeenCalledTimes(1);
  });

  it("failed 和 superseded 会将焦点放到可操作的恢复按钮", async () => {
    const failed = { phase: "failed", ...timestamps, errorCode: "CODEX_RESEARCH_FAILED" as const } satisfies ResearchStatus;
    setup({ bridge: makeBridge({ getResearchStatus: vi.fn().mockResolvedValue(failed) }) });

    const recovery = await screen.findByRole("button", { name: "重新选择研究范围" });
    await waitFor(() => expect(recovery).toHaveFocus());
    expect(recovery).toBeEnabled();
  });

  it("operation error 会将焦点放到可操作的返回设置按钮", async () => {
    const bridge = makeBridge({ prepare: vi.fn().mockRejectedValue(new Error("offline")) });
    setup({ bridge });
    await chooseHotelResearch();
    await userEvent.click(screen.getByRole("button", { name: "准备本机 Codex" }));

    const recovery = await screen.findByRole("button", { name: "返回研究设置" });
    await waitFor(() => expect(recovery).toHaveFocus());
    expect(recovery).toBeEnabled();
  });
});
