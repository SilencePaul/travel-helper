import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MemberManagementPage } from "./MemberManagementPage";
import { memberVerificationCode } from "./memberVerification";
import { UnauthorizedError } from "../../infrastructure/cloudbaseTripRepository";

describe("MemberManagementPage", () => {
  it("shows useful loading and empty states", async () => {
    const command = vi.fn().mockResolvedValue({ members: [] });
    render(<MemberManagementPage command={command} />);

    expect(screen.getByRole("status")).toHaveTextContent("正在加载成员");
    expect(await screen.findByText("暂无待批准成员")).toBeInTheDocument();
    expect(screen.getByText("暂无其他已加入成员")).toBeInTheDocument();
  });

  it("allows a failed member list to be retried", async () => {
    const command = vi.fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce({ members: [] });
    render(<MemberManagementPage command={command} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("成员列表加载失败");
    await userEvent.click(screen.getByRole("button", { name: "重新加载成员" }));
    expect(await screen.findByText("暂无待批准成员")).toBeInTheDocument();
    expect(command).toHaveBeenCalledTimes(2);
  });

  it("provides a way back to the trip", async () => {
    const onBack = vi.fn();
    render(<MemberManagementPage onBack={onBack} initialMembers={[]} />);

    await userEvent.click(screen.getByRole("button", { name: "返回行程总览" }));

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("requires the pending traveler verification code before approval", async () => {
    let resolve!: (value: { member: { uid: string; displayName: string; role: "member"; version: number; createdAt: string } }) => void;
    const command = vi.fn().mockReturnValue(new Promise((done) => { resolve = done; }));
    const pendingUid = "fs_0123456789abcdef0123456789abc";
    render(<MemberManagementPage command={command} initialMembers={[
      { uid: pendingUid, displayName: "美垚", role: "pending", version: 0, createdAt: "2026-08-27T00:00:00.000Z" },
    ]} />);
    expect(screen.getByText("美垚")).toBeInTheDocument();
    expect(screen.queryByText(memberVerificationCode(pendingUid))).not.toBeInTheDocument();
    const button = screen.getByRole("button", { name: "核对后批准" });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox", { name: "输入美垚的身份校验码" }), memberVerificationCode(pendingUid));
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(button).toBeDisabled();
    expect(command).toHaveBeenCalledWith({ action: "approveMember", uid: pendingUid });
    resolve({ member: { uid: pendingUid, displayName: "美垚", role: "member", version: 1, createdAt: "2026-08-27T00:00:00.000Z" } });
  });

  it("uses a generic message when an action fails", async () => {
    const command = vi.fn().mockRejectedValue(new Error("provider secret"));
    render(<MemberManagementPage command={command} initialMembers={[
      { uid: "hidden", displayName: "美垚", role: "pending", version: 0, createdAt: "2026-08-27T00:00:00.000Z" },
    ]} />);
    await userEvent.type(screen.getByRole("textbox", { name: "输入美垚的身份校验码" }), memberVerificationCode("hidden"));
    await userEvent.click(screen.getByRole("button", { name: "核对后批准" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("操作失败，请稍后重试");
    expect(screen.queryByText("provider secret")).not.toBeInTheDocument();
  });

  it("explains when the private two-person member limit is reached", async () => {
    const command = vi.fn().mockRejectedValue(Object.assign(new Error("MEMBER_LIMIT_REACHED"), { code: "MEMBER_LIMIT_REACHED" }));
    render(<MemberManagementPage command={command} initialMembers={[
      { uid: "hidden", displayName: "待审批", role: "pending", version: 0, createdAt: "2026-08-27T00:00:00.000Z" },
    ]} />);

    await userEvent.type(screen.getByRole("textbox", { name: "输入待审批的身份校验码" }), memberVerificationCode("hidden"));
    await userEvent.click(screen.getByRole("button", { name: "核对后批准" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("这趟私人行程最多允许两位成员");
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
