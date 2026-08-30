import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentRun, DecisionWorkspaceRepository } from "@travel/contracts";
import { describe, expect, it, vi } from "vitest";
import type { LocalAgentBridge } from "../../infrastructure/localAgentBridgeClient";
import { DecisionAgentPanel } from "./DecisionAgentPanel";

const prepared = {
  publicKeyJwk: { kty: "EC" as const, crv: "P-256" as const, x: "x-coordinate", y: "y-coordinate" },
  pairingCodeHash: "2g8DdGhJvqg00hyxT13Po40J6lVT92CRPLHZfoW3szI",
  pairingCodeFingerprint: "9A4F · 20C1",
};
const activeRun: AgentRun = {
  agentRunId: "agent-run-1",
  tripId: "trip-1",
  status: "claimed" as const,
  scope: ["submitProposalBatch", "appendEvidenceSnapshot", "reportVerificationBlocked"],
  revision: 2,
  nextSequence: 1,
  createdAt: "2026-08-28T00:00:00.000Z",
  claimedAt: "2026-08-28T00:01:00.000Z",
  expiresAt: "2099-08-28T00:15:00.000Z",
};

function setup(options: {
  bridge?: LocalAgentBridge;
  command?: ReturnType<typeof vi.fn>;
  getAgentRunStatus?: ReturnType<typeof vi.fn>;
} = {}) {
  const command = options.command ?? vi.fn()
    .mockResolvedValueOnce({ ok: true, action: "createAgentRun", data: { agentRunId: "agent-run-1", expiresAt: activeRun.expiresAt } });
  const getAgentRunStatus = options.getAgentRunStatus ?? vi.fn().mockResolvedValue(activeRun);
  const repository = { command, getAgentRunStatus } as unknown as DecisionWorkspaceRepository;
  const bridge = options.bridge ?? {
    prepare: vi.fn().mockResolvedValue(prepared),
    claim: vi.fn().mockResolvedValue({ agentRunId: "agent-run-1", status: "claimed" }),
  };
  const view = render(<DecisionAgentPanel repository={repository} bridge={bridge} tripId="trip-1" newIdempotencyKey={() => "agent-request-001"} />);
  return { ...view, bridge, command, getAgentRunStatus };
}

async function startAgent() {
  await userEvent.click(screen.getByRole("button", { name: "准备本机 Agent" }));
  await screen.findByText("9A4F · 20C1");
  await userEvent.click(screen.getByRole("checkbox", { name: "我确认以上授权范围" }));
  await userEvent.click(screen.getByRole("button", { name: "授权并连接" }));
}

describe("DecisionAgentPanel", () => {
  it("discloses decision-context reads and tells the member to compare the fingerprint", async () => {
    setup();

    await userEvent.click(screen.getByRole("button", { name: "准备本机 Agent" }));

    expect(await screen.findByText("读取当前行程共享决策上下文")).toBeVisible();
    expect(screen.getByText("请与 Desktop Agent 显示的配对指纹逐字核对。")).toBeVisible();
  });

  it("runs prepare, create and claim in order without rendering secret material", async () => {
    const calls: string[] = [];
    const bridge = {
      prepare: vi.fn(async () => { calls.push("prepare"); return prepared; }),
      claim: vi.fn(async () => { calls.push("claim"); return { agentRunId: "agent-run-1", status: "claimed" as const }; }),
    };
    const command = vi.fn(async (input) => {
      calls.push(input.action);
      return { ok: true, action: "createAgentRun" as const, data: { agentRunId: "agent-run-1", expiresAt: activeRun.expiresAt } };
    });
    const { container } = setup({ bridge, command });

    await startAgent();

    expect(await screen.findByText("Agent 正在运行")).toBeVisible();
    expect(calls).toEqual(["prepare", "createAgentRun", "claim"]);
    expect(command).toHaveBeenCalledWith(expect.objectContaining({
      action: "createAgentRun",
      tripId: "trip-1",
      publicKeyJwk: prepared.publicKeyJwk,
      pairingCodeHash: prepared.pairingCodeHash,
    }));
    expect(container.textContent).not.toContain(prepared.pairingCodeHash);
    expect(container.textContent).not.toContain("x-coordinate");
    expect(container.textContent).not.toContain("pairingCode");
  });

  it("retries a lost claim response with the same AgentRun instead of creating another", async () => {
    const bridge = {
      prepare: vi.fn().mockResolvedValue(prepared),
      claim: vi.fn()
        .mockRejectedValueOnce(new Error("response lost"))
        .mockResolvedValueOnce({ agentRunId: "agent-run-1", status: "claimed" as const }),
    };
    const { command } = setup({ bridge });

    await startAgent();
    expect(await screen.findByText("Agent 已创建，连接响应丢失，可安全重试。")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "重试连接" }));

    expect(await screen.findByText("Agent 正在运行")).toBeVisible();
    expect(command).toHaveBeenCalledTimes(1);
    expect(bridge.claim).toHaveBeenCalledTimes(2);
    expect(bridge.claim).toHaveBeenNthCalledWith(1, "agent-run-1", expect.anything());
    expect(bridge.claim).toHaveBeenNthCalledWith(2, "agent-run-1", expect.anything());
  });

  it("shows a recoverable offline state and moves focus to retry", async () => {
    const bridge = { prepare: vi.fn().mockRejectedValue(new Error("offline")), claim: vi.fn() };
    setup({ bridge });

    await userEvent.click(screen.getByRole("button", { name: "准备本机 Agent" }));

    const retry = await screen.findByRole("button", { name: "重试准备" });
    expect(screen.getByText("Desktop Bridge 未在线，已保存的共同决定仍可使用。")).toBeVisible();
    await waitFor(() => expect(retry).toHaveFocus());
  });

  it("shows an expired run without offering another Agent write", async () => {
    const expiredRun = { ...activeRun, status: "expired" as const };
    setup({ getAgentRunStatus: vi.fn().mockResolvedValue(expiredRun) });

    await startAgent();

    expect(await screen.findByText("Agent 已过期")).toBeVisible();
    expect(screen.getByText("Agent 运行已过期，可重新准备一个新的运行。")).toBeVisible();
    expect(screen.queryByRole("button", { name: "停止 Agent" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "授权并连接" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "准备新 Agent" }));
    expect(await screen.findByText("9A4F · 20C1")).toBeVisible();
  });

  it("does not present a pending claim as an active Agent", async () => {
    setup({ getAgentRunStatus: vi.fn().mockResolvedValue({ ...activeRun, status: "pending_claim" as const, claimedAt: undefined }) });

    await startAgent();

    expect(await screen.findByText("等待 Agent 领取")).toBeVisible();
    expect(screen.queryByText("Agent 正在运行")).not.toBeInTheDocument();
  });

  it("reads the safe revision before revoking and rejects later writes through the run status", async () => {
    const command = vi.fn()
      .mockResolvedValueOnce({ ok: true, action: "createAgentRun", data: { agentRunId: "agent-run-1", expiresAt: activeRun.expiresAt } })
      .mockResolvedValueOnce({ ok: true, action: "revokeAgentRun", data: { agentRunId: "agent-run-1", revokedAt: "2026-08-28T00:05:00.000Z" } });
    const getAgentRunStatus = vi.fn().mockResolvedValue(activeRun);
    setup({ command, getAgentRunStatus });
    await startAgent();
    await screen.findByText("Agent 正在运行");

    await userEvent.click(screen.getByRole("button", { name: "停止 Agent" }));

    expect(await screen.findByText("Agent 已停止")).toBeVisible();
    expect(getAgentRunStatus).toHaveBeenCalledTimes(2);
    expect(command).toHaveBeenLastCalledWith({
      action: "revokeAgentRun",
      tripId: "trip-1",
      agentRunId: "agent-run-1",
      expectedRevision: 2,
      idempotencyKey: "agent-request-001",
    });
  });

  it("keeps the latest safe status after a revoke CAS conflict and allows explicit retry", async () => {
    const latest = { ...activeRun, revision: 3, nextSequence: 2 } satisfies AgentRun;
    const command = vi.fn()
      .mockResolvedValueOnce({ ok: true, action: "createAgentRun", data: { agentRunId: "agent-run-1", expiresAt: activeRun.expiresAt } })
      .mockResolvedValueOnce({ ok: false, error: "VERSION_CONFLICT", latest })
      .mockResolvedValueOnce({ ok: true, action: "revokeAgentRun", data: { agentRunId: "agent-run-1", revokedAt: "2026-08-28T00:06:00.000Z" } });
    const getAgentRunStatus = vi.fn()
      .mockResolvedValueOnce(activeRun)
      .mockResolvedValueOnce(activeRun)
      .mockResolvedValueOnce(latest);
    setup({ command, getAgentRunStatus });
    await startAgent();
    await screen.findByText("Agent 正在运行");

    await userEvent.click(screen.getByRole("button", { name: "停止 Agent" }));
    expect(await screen.findByText("Agent 状态已变化，请确认后重试停止。")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "再次停止 Agent" }));

    expect(await screen.findByText("Agent 已停止")).toBeVisible();
    expect(command).toHaveBeenLastCalledWith(expect.objectContaining({ expectedRevision: 3 }));
  });

  it("disables duplicate revoke submission and retries revoke rather than claim after failure", async () => {
    let rejectRevoke!: (error: Error) => void;
    const pendingRevoke = new Promise((_resolve, reject) => { rejectRevoke = reject; });
    const command = vi.fn()
      .mockResolvedValueOnce({ ok: true, action: "createAgentRun", data: { agentRunId: "agent-run-1", expiresAt: activeRun.expiresAt } })
      .mockReturnValueOnce(pendingRevoke)
      .mockResolvedValueOnce({ ok: true, action: "revokeAgentRun", data: { agentRunId: "agent-run-1", revokedAt: "2026-08-28T00:06:00.000Z" } });
    const { bridge } = setup({ command });
    await startAgent();
    await screen.findByText("Agent 正在运行");

    await userEvent.click(screen.getByRole("button", { name: "停止 Agent" }));
    const busyButton = await screen.findByRole("button", { name: "正在停止…" });
    expect(busyButton).toBeDisabled();
    await userEvent.click(busyButton);
    expect(command).toHaveBeenCalledTimes(2);
    rejectRevoke(new Error("network lost"));

    const retry = await screen.findByRole("button", { name: "重试停止 Agent" });
    await userEvent.click(retry);
    expect(await screen.findByText("Agent 已停止")).toBeVisible();
    expect(command).toHaveBeenCalledTimes(3);
    expect(bridge.claim).toHaveBeenCalledTimes(1);
  });

  it("rejects an untrusted conflict latest projection", async () => {
    const command = vi.fn()
      .mockResolvedValueOnce({ ok: true, action: "createAgentRun", data: { agentRunId: "agent-run-1", expiresAt: activeRun.expiresAt } })
      .mockResolvedValueOnce({ ok: false, error: "VERSION_CONFLICT", latest: { ...activeRun, tripId: "trip-other" } });
    setup({ command });
    await startAgent();
    await screen.findByText("Agent 正在运行");

    await userEvent.click(screen.getByRole("button", { name: "停止 Agent" }));

    expect(await screen.findByText("停止失败，请读取最新状态后重试。")).toBeVisible();
    expect(screen.getByRole("button", { name: "重试停止 Agent" })).toBeVisible();
  });

  it("blocks creation when safe AgentRun status reads are unavailable", async () => {
    const command = vi.fn();
    const repository = { command } as unknown as DecisionWorkspaceRepository;
    const bridge = { prepare: vi.fn().mockResolvedValue(prepared), claim: vi.fn() };
    render(<DecisionAgentPanel repository={repository} bridge={bridge} tripId="trip-1" newIdempotencyKey={() => "agent-request-001"} />);

    await startAgent();

    expect(await screen.findByText("当前无法读取 Agent 安全状态，未创建授权。请稍后重试。")).toBeVisible();
    expect(command).not.toHaveBeenCalled();
    expect(bridge.claim).not.toHaveBeenCalled();
  });

  it("clears old run state when the trip, repository or bridge changes", async () => {
    const repository = { command: vi.fn().mockResolvedValue({ ok: true, action: "createAgentRun", data: { agentRunId: "agent-run-1", expiresAt: activeRun.expiresAt } }), getAgentRunStatus: vi.fn().mockResolvedValue(activeRun) } as unknown as DecisionWorkspaceRepository;
    const bridge = { prepare: vi.fn().mockResolvedValue(prepared), claim: vi.fn().mockResolvedValue({ agentRunId: "agent-run-1", status: "claimed" as const }) };
    const view = render(<DecisionAgentPanel repository={repository} bridge={bridge} tripId="trip-1" newIdempotencyKey={() => "agent-request-001"} />);
    await startAgent();
    expect(await screen.findByText("agent-run-1")).toBeVisible();

    const nextRepository = { command: vi.fn(), getAgentRunStatus: vi.fn() } as unknown as DecisionWorkspaceRepository;
    const nextBridge = { prepare: vi.fn().mockResolvedValue(prepared), claim: vi.fn() };
    view.rerender(<DecisionAgentPanel repository={nextRepository} bridge={nextBridge} tripId="trip-2" newIdempotencyKey={() => "agent-request-002"} />);

    expect(await screen.findByText("Agent 尚未启动")).toBeVisible();
    expect(screen.queryByText("agent-run-1")).not.toBeInTheDocument();
  });

  it("automatically expires an active run at expiresAt", async () => {
    const shortRun = { ...activeRun, expiresAt: new Date(Date.now() + 40).toISOString() };
    setup({ getAgentRunStatus: vi.fn().mockResolvedValue(shortRun) });
    await startAgent();
    expect(await screen.findByText("Agent 正在运行")).toBeVisible();

    expect(await screen.findByText("Agent 已过期", {}, { timeout: 1_000 })).toBeVisible();
  });

  it("lightly refreshes active status and observes a remote revoke", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const getAgentRunStatus = vi.fn()
      .mockResolvedValueOnce(activeRun)
      .mockResolvedValueOnce({ ...activeRun, status: "revoked" as const, revision: 3, revokedAt: "2026-08-28T00:05:00.000Z" });
    try {
      setup({ getAgentRunStatus });
      await startAgent();
      expect(await screen.findByText("Agent 正在运行")).toBeVisible();

      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });

      expect(await screen.findByText("Agent 已停止")).toBeVisible();
      expect(getAgentRunStatus).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconciles a create submitted remotely when the member cancels", async () => {
    let resolveCreate!: (value: unknown) => void;
    const command = vi.fn().mockReturnValue(new Promise((resolve) => { resolveCreate = resolve; }));
    const getAgentRunStatus = vi.fn().mockResolvedValue({ ...activeRun, status: "pending_claim" as const, claimedAt: undefined });
    const { bridge } = setup({ command, getAgentRunStatus });

    await userEvent.click(screen.getByRole("button", { name: "准备本机 Agent" }));
    await screen.findByText("9A4F · 20C1");
    await userEvent.click(screen.getByRole("checkbox", { name: "我确认以上授权范围" }));
    await userEvent.click(screen.getByRole("button", { name: "授权并连接" }));
    await userEvent.click(await screen.findByRole("button", { name: "取消连接" }));
    await act(async () => {
      resolveCreate({ ok: true, action: "createAgentRun", data: { agentRunId: "agent-run-1", expiresAt: activeRun.expiresAt } });
    });

    expect(await screen.findByText("取消时授权可能已提交；已恢复远端状态，请确认是否停止 Agent。")).toBeVisible();
    expect(screen.getByText("agent-run-1")).toBeVisible();
    expect(bridge.claim).not.toHaveBeenCalled();
    expect(getAgentRunStatus).toHaveBeenCalledWith("trip-1", "agent-run-1");
  });

  it("leaves the rest of the decision workspace usable when no Bridge is injected", () => {
    const repository = { command: vi.fn(), getAgentRunStatus: vi.fn() } as unknown as DecisionWorkspaceRepository;
    render(<DecisionAgentPanel repository={repository} tripId="trip-1" newIdempotencyKey={() => "agent-request-001"} />);

    expect(screen.getByText("Desktop Bridge 未连接")).toBeVisible();
    expect(screen.getByText("共同决定与已保存行程仍可正常使用。")).toBeVisible();
  });
});
