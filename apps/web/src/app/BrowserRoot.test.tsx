import { render, screen } from "@testing-library/react";
import type { TripRepository } from "@travel/contracts";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import seed from "../../../../content/trip.seed.json";
import { TripApp } from "../App";
import { ProductionAuthGate } from "./BrowserRoot";

const getCurrentUser = vi.fn();

vi.mock("../infrastructure/cloudbaseClient", () => ({
  getCloudbaseAuth: () => ({ getCurrentUser }),
}));

describe("ProductionAuthGate", () => {
  beforeEach(() => {
    getCurrentUser.mockResolvedValue(null);
    window.history.replaceState({}, "", "/");
  });

  it("does not mount trip content or a local repository before CloudBase auth", async () => {
    render(<ProductionAuthGate />);
    expect(await screen.findByRole("button", { name: "使用飞书登录" })).toBeInTheDocument();
    expect(screen.queryByText("正在加载旅行计划")).not.toBeInTheDocument();
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
