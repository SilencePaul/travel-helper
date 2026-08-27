import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MemberManagementPage } from "./MemberManagementPage";
import { UnauthorizedError } from "../../infrastructure/cloudbaseTripRepository";

describe("MemberManagementPage", () => {
  it("shows names and disables a member action while it is pending", async () => {
    let resolve!: (value: { member: { uid: string; displayName: string; role: "member"; version: number; createdAt: string } }) => void;
    const command = vi.fn().mockReturnValue(new Promise((done) => { resolve = done; }));
    render(<MemberManagementPage command={command} initialMembers={[
      { uid: "hidden-pending", displayName: "美垚", role: "pending", version: 0, createdAt: "2026-08-27T00:00:00.000Z" },
    ]} />);
    expect(screen.getByText("美垚")).toBeInTheDocument();
    expect(screen.queryByText("hidden-pending")).not.toBeInTheDocument();
    const button = screen.getByRole("button", { name: "批准" });
    await userEvent.click(button);
    expect(button).toBeDisabled();
    expect(command).toHaveBeenCalledWith({ action: "approveMember", uid: "hidden-pending" });
    resolve({ member: { uid: "hidden-pending", displayName: "美垚", role: "member", version: 1, createdAt: "2026-08-27T00:00:00.000Z" } });
  });

  it("uses a generic message when an action fails", async () => {
    const command = vi.fn().mockRejectedValue(new Error("provider secret"));
    render(<MemberManagementPage command={command} initialMembers={[
      { uid: "hidden", displayName: "美垚", role: "pending", version: 0, createdAt: "2026-08-27T00:00:00.000Z" },
    ]} />);
    await userEvent.click(screen.getByRole("button", { name: "批准" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("操作失败，请稍后重试");
    expect(screen.queryByText("provider secret")).not.toBeInTheDocument();
  });

  it("clears stale members and delegates authorization loss to the shared session handler", async () => {
    const unauthorized = new UnauthorizedError();
    const command = vi.fn().mockRejectedValue(unauthorized);
    const onUnauthorized = vi.fn();
    render(<MemberManagementPage command={command} onUnauthorized={onUnauthorized} initialMembers={[
      { uid: "revoked", displayName: "已被撤销", role: "member", version: 1, createdAt: "2026-08-27T00:00:00.000Z" },
    ]} />);

    await userEvent.click(screen.getByRole("button", { name: "移除" }));

    expect(onUnauthorized).toHaveBeenCalledWith(unauthorized);
    expect(screen.queryByText("已被撤销")).not.toBeInTheDocument();
    expect(screen.queryByText("操作失败，请稍后重试")).not.toBeInTheDocument();
  });
});
