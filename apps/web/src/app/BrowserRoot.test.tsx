import { render, screen } from "@testing-library/react";
import type { TripRepository } from "@travel/contracts";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import seed from "../../../../content/trip.seed.json";
import { TripApp } from "../App";
import { ProductionAuthGate } from "./BrowserRoot";

const { getCurrentUser, recoverAuthenticatedMember } = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  recoverAuthenticatedMember: vi.fn(),
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
  recoverAuthenticatedMember,
}));

describe("ProductionAuthGate", () => {
  beforeEach(() => {
    getCurrentUser.mockResolvedValue(null);
    recoverAuthenticatedMember.mockRejectedValue(Object.assign(new Error("AUTH_REQUIRED"), { code: "AUTH_REQUIRED" }));
    window.history.replaceState({}, "", "/");
  });

  it("does not mount trip content or a local repository before CloudBase auth", async () => {
    render(<ProductionAuthGate />);
    expect(await screen.findByRole("button", { name: "使用飞书登录" })).toBeInTheDocument();
    expect(screen.queryByText("正在加载旅行计划")).not.toBeInTheDocument();
  });

  it("opens the trip from a valid server session even while the CloudBase user is empty", async () => {
    recoverAuthenticatedMember.mockResolvedValue({ uid: "fs_admin", displayName: "一鸣", role: "admin", version: 1, createdAt: "2026-08-27T00:00:00.000Z" });

    render(<ProductionAuthGate />);

    expect(await screen.findByText("正在加载旅行计划")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "使用飞书登录" })).not.toBeInTheDocument();
  });

  it("handles an OAuth callback marker from the hosting root", async () => {
    window.history.replaceState({}, "", "/?auth_callback=1&status=bootstrap&state=test-state");

    render(<ProductionAuthGate />);

    expect(await screen.findByRole("heading", { name: "初始化管理员" })).toBeInTheDocument();
  });

  it("does not mount the member-management route for an authenticated non-admin", async () => {
    const repository: TripRepository = {
      syncMode: "cloudbase",
      load: async () => ({ ...structuredClone(seed), orders: [] }),
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
});
