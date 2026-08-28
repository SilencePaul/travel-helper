import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TripSchema, type TripRepository } from "@travel/contracts";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import seed from "../../../../content/trip.seed.json";
import { TripApp } from "../App";
import { browserDataMode, ProductionAuthGate } from "./BrowserRoot";

const seededTrip = TripSchema.parse(seed);

describe("browserDataMode", () => {
  it("fails closed instead of using local seed data in a misconfigured production build", () => {
    expect(browserDataMode(false, "local")).toBe("invalid");
    expect(browserDataMode(false, undefined)).toBe("invalid");
    expect(browserDataMode(false, "cloudbase")).toBe("cloudbase");
    expect(browserDataMode(true, "local")).toBe("local");
  });
});

const { exchangeAuthenticationCode, getCurrentUser, recoverAuthenticatedMember, signInWithIssuedTicket } = vi.hoisted(() => ({
  exchangeAuthenticationCode: vi.fn(),
  getCurrentUser: vi.fn(),
  recoverAuthenticatedMember: vi.fn(),
  signInWithIssuedTicket: vi.fn(),
}));

vi.mock("../infrastructure/cloudbaseClient", () => ({
  getCloudbaseAuth: () => ({ getCurrentUser }),
  getCloudbaseClient: () => ({
    database: () => ({ collection: () => ({ doc: () => ({ get: () => new Promise(() => undefined) }) }) }),
    callFunction: vi.fn(),
  }),
}));

vi.mock("../infrastructure/authSession", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infrastructure/authSession")>()),
  exchangeAuthenticationCode,
  recoverAuthenticatedMember,
  signInWithIssuedTicket,
}));

describe("ProductionAuthGate", () => {
  beforeEach(() => {
    getCurrentUser.mockResolvedValue(null);
    exchangeAuthenticationCode.mockResolvedValue({
      member: { uid: "fs_pending", displayName: "待审批", role: "pending", version: 0, createdAt: "2026-08-27T00:00:00.000Z" },
      ticket: "custom-ticket",
    });
    signInWithIssuedTicket.mockResolvedValue(undefined);
    recoverAuthenticatedMember.mockRejectedValue(Object.assign(new Error("AUTH_REQUIRED"), { code: "AUTH_REQUIRED" }));
    window.history.replaceState({}, "", "/");
  });

  it("does not mount trip content or a local repository before CloudBase auth", async () => {
    render(<ProductionAuthGate />);
    expect(await screen.findByRole("button", { name: "使用飞书继续" })).toBeInTheDocument();
    expect(screen.queryByText("正在加载旅行计划")).not.toBeInTheDocument();
  });

  it("opens the trip from a valid server session even while the CloudBase user is empty", async () => {
    recoverAuthenticatedMember.mockResolvedValue({ uid: "fs_admin", displayName: "一鸣", role: "admin", version: 1, createdAt: "2026-08-27T00:00:00.000Z" });

    render(<ProductionAuthGate />);

    expect(await screen.findByText("正在加载旅行计划")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "使用飞书继续" })).not.toBeInTheDocument();
  });

  it("handles an OAuth callback marker from the hosting root", async () => {
    window.history.replaceState({}, "", "/?auth_callback=1&status=bootstrap&state=test-state&exchange_code=one-time");

    render(<ProductionAuthGate />);

    expect(await screen.findByRole("heading", { name: "完成管理员初始化" })).toBeInTheDocument();
  });

  it("does not mount the member-management route for an authenticated non-admin", async () => {
    const repository: TripRepository = {
      syncMode: "cloudbase",
      load: async () => ({ ...structuredClone(seededTrip), orders: [] }),
      save: async (trip) => trip,
      subscribe: () => () => undefined,
    };

    render(
      <MemoryRouter initialEntries={["/admin/members"]}>
        <TripApp repository={repository} member={{ uid: "fs_member", displayName: "成员", role: "member", version: 0, createdAt: "2026-08-27T00:00:00.000Z" }} />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("无权访问");
    expect(screen.queryByRole("heading", { name: "成员管理" })).not.toBeInTheDocument();
  });

  it("keeps a recoverable session-check outage visible and lets the user retry", async () => {
    recoverAuthenticatedMember
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce({ uid: "fs_admin", displayName: "一鸣", role: "admin", version: 1, createdAt: "2026-08-27T00:00:00.000Z" });

    render(<ProductionAuthGate />);

    expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法确认登录状态");
    await userEvent.click(screen.getByRole("button", { name: "重新检查登录状态" }));
    expect(await screen.findByText("旅行计划暂时无法加载")).toBeInTheDocument();
    expect(recoverAuthenticatedMember.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByRole("button", { name: "使用飞书继续" })).not.toBeInTheDocument();
  });

  it("gives an administrator visible member management, back, and logout controls", async () => {
    const onLogout = vi.fn().mockResolvedValue(undefined);
    const repository: TripRepository = {
      syncMode: "cloudbase",
      load: async () => structuredClone(seededTrip),
      save: async (trip) => trip,
      subscribe: () => () => undefined,
    };

    render(
      <MemoryRouter>
        <TripApp
          repository={repository}
          member={{ uid: "fs_admin", displayName: "一鸣", role: "admin", version: 1, createdAt: "2026-08-27T00:00:00.000Z" }}
          onLogout={onLogout}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText("已登录：一鸣")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "成员管理" }));
    expect(await screen.findByRole("heading", { name: "成员管理" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "返回行程总览" }));
    expect(await screen.findByRole("heading", { name: "两个人，一条向南的路线。" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "退出登录" }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });
});
