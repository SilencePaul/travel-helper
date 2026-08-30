import { render, screen, waitFor } from "@testing-library/react";
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
    await userEvent.click(screen.getByRole("button", { name: "确认移除已被撤销" }));

    expect(onUnauthorized).toHaveBeenCalledWith(unauthorized);
    expect(screen.queryByText("已被撤销")).not.toBeInTheDocument();
    expect(screen.queryByText("操作失败，请稍后重试")).not.toBeInTheDocument();
  });

  it("confirms a named destructive action and focuses the next equivalent action after removal", async () => {
    const user = userEvent.setup();
    const command = vi.fn().mockResolvedValue({});
    render(<MemberManagementPage command={command} initialMembers={[
      { uid: "member-one", displayName: "同行甲", role: "member", version: 1, createdAt: "2026-08-27T00:00:00.000Z" },
      { uid: "member-two", displayName: "同行乙", role: "member", version: 1, createdAt: "2026-08-27T00:00:00.000Z" },
    ]} />);

    await user.click(screen.getAllByRole("button", { name: "移除" })[0]!);
    const dialog = screen.getByRole("alertdialog", { name: "确认移除同行甲" });
    expect(dialog).toBeVisible();
    expect(screen.getByRole("button", { name: "取消" })).toHaveFocus();
    expect(command).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "确认移除同行甲" }));
    expect(command).toHaveBeenCalledWith({ action: "removeMember", uid: "member-one" });
    expect(await screen.findByText("已移除同行甲")).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button", { name: "移除" })).toHaveFocus());
  });

  it("cancels a rejection without mutating membership", async () => {
    const user = userEvent.setup();
    const command = vi.fn();
    render(<MemberManagementPage command={command} initialMembers={[
      { uid: "pending", displayName: "待审批同行", role: "pending", version: 0, createdAt: "2026-08-27T00:00:00.000Z" },
    ]} />);

    const trigger = screen.getByRole("button", { name: "拒绝" });
    await user.click(trigger);
    expect(screen.getByRole("alertdialog", { name: "确认拒绝待审批同行" })).toBeVisible();
    expect(screen.getByRole("button", { name: "取消" })).toHaveFocus();
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(command).not.toHaveBeenCalled();
  });

  it("announces a successful approval and focuses the active-members heading", async () => {
    const pendingUid = "approval-focus";
    const command = vi.fn().mockResolvedValue({
      member: { uid: pendingUid, displayName: "待审批同行", role: "member", version: 1, createdAt: "2026-08-27T00:00:00.000Z" },
    });
    const user = userEvent.setup();
    render(<MemberManagementPage command={command} initialMembers={[
      { uid: pendingUid, displayName: "待审批同行", role: "pending", version: 0, createdAt: "2026-08-27T00:00:00.000Z" },
    ]} />);

    await user.type(screen.getByRole("textbox", { name: "输入待审批同行的身份校验码" }), memberVerificationCode(pendingUid));
    await user.click(screen.getByRole("button", { name: "核对后批准" }));

    expect(await screen.findByRole("status")).toHaveTextContent("已批准待审批同行");
    await waitFor(() => expect(screen.getByRole("heading", { name: "已加入" })).toHaveFocus());
  });

  it("focuses the next available approval after approving a pending member", async () => {
    const firstUid = "approval-first";
    const secondUid = "approval-second";
    const command = vi.fn(async ({ uid }: { uid?: string }) => ({
      member: { uid: uid!, displayName: uid === firstUid ? "待审批甲" : "待审批乙", role: "member" as const, version: 1, createdAt: "2026-08-27T00:00:00.000Z" },
    }));
    const user = userEvent.setup();
    render(<MemberManagementPage command={command} initialMembers={[
      { uid: firstUid, displayName: "待审批甲", role: "pending", version: 0, createdAt: "2026-08-27T00:00:00.000Z" },
      { uid: secondUid, displayName: "待审批乙", role: "pending", version: 0, createdAt: "2026-08-27T00:00:00.000Z" },
    ]} />);

    await user.type(screen.getByRole("textbox", { name: "输入待审批甲的身份校验码" }), memberVerificationCode(firstUid));
    await user.type(screen.getByRole("textbox", { name: "输入待审批乙的身份校验码" }), memberVerificationCode(secondUid));
    await user.click(screen.getAllByRole("button", { name: "核对后批准" })[0]!);

    expect(await screen.findByRole("status")).toHaveTextContent("已批准待审批甲");
    await waitFor(() => expect(screen.getByRole("button", { name: "核对后批准" })).toHaveFocus());
  });

  it("keeps focus in the pending workflow when the next approval still needs verification", async () => {
    const firstUid = "verification-first";
    const secondUid = "verification-second";
    const command = vi.fn(async ({ uid }: { uid?: string }) => ({
      member: { uid: uid!, displayName: "待审批甲", role: "member" as const, version: 1, createdAt: "2026-08-27T00:00:00.000Z" },
    }));
    const user = userEvent.setup();
    render(<MemberManagementPage command={command} initialMembers={[
      { uid: firstUid, displayName: "待审批甲", role: "pending", version: 0, createdAt: "2026-08-27T00:00:00.000Z" },
      { uid: secondUid, displayName: "待审批乙", role: "pending", version: 0, createdAt: "2026-08-27T00:00:00.000Z" },
    ]} />);

    await user.type(screen.getByRole("textbox", { name: "输入待审批甲的身份校验码" }), memberVerificationCode(firstUid));
    await user.click(screen.getAllByRole("button", { name: "核对后批准" })[0]!);

    await waitFor(() => expect(screen.getByRole("textbox", { name: "输入待审批乙的身份校验码" })).toHaveFocus());
    expect(screen.getByRole("heading", { name: "已加入" })).not.toHaveFocus();
  });

  it("focuses the dialog container while a destructive request disables its actions", async () => {
    let finish!: (value: {}) => void;
    const command = vi.fn().mockReturnValue(new Promise<{}>((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    render(<MemberManagementPage command={command} initialMembers={[
      { uid: "member", displayName: "同行", role: "member", version: 1, createdAt: "2026-08-27T00:00:00.000Z" },
    ]} />);

    await user.click(screen.getByRole("button", { name: "移除" }));
    const dialog = screen.getByRole("alertdialog", { name: "确认移除同行" });
    await user.click(screen.getByRole("button", { name: "确认移除同行" }));

    expect(dialog).toHaveAttribute("tabindex", "-1");
    expect(dialog).toHaveFocus();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "正在处理" })).toBeDisabled();

    finish({});
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("clears a stale action error before opening a new confirmation", async () => {
    const command = vi.fn().mockRejectedValueOnce(new Error("first failure")).mockResolvedValueOnce({});
    const user = userEvent.setup();
    render(<MemberManagementPage command={command} initialMembers={[
      { uid: "member-one", displayName: "同行甲", role: "member", version: 1, createdAt: "2026-08-27T00:00:00.000Z" },
      { uid: "member-two", displayName: "同行乙", role: "member", version: 1, createdAt: "2026-08-27T00:00:00.000Z" },
    ]} />);

    await user.click(screen.getAllByRole("button", { name: "移除" })[0]!);
    await user.click(screen.getByRole("button", { name: "确认移除同行甲" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("操作失败");
    await user.keyboard("{Escape}");
    await user.click(screen.getAllByRole("button", { name: "移除" })[1]!);

    expect(screen.getByRole("alertdialog", { name: "确认移除同行乙" })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("falls back to the matching section heading after the last destructive action", async () => {
    const command = vi.fn().mockResolvedValue({});
    const user = userEvent.setup();
    render(<MemberManagementPage command={command} initialMembers={[
      { uid: "pending", displayName: "最后待审批", role: "pending", version: 0, createdAt: "2026-08-27T00:00:00.000Z" },
      { uid: "member", displayName: "最后已加入", role: "member", version: 1, createdAt: "2026-08-27T00:00:00.000Z" },
    ]} />);

    await user.click(screen.getByRole("button", { name: "拒绝" }));
    await user.click(screen.getByRole("button", { name: "确认拒绝最后待审批" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "待批准" })).toHaveFocus());

    await user.click(screen.getByRole("button", { name: "移除" }));
    await user.click(screen.getByRole("button", { name: "确认移除最后已加入" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "已加入" })).toHaveFocus());
  });

  it("skips disabled destructive actions when restoring focus after removal", async () => {
    const user = userEvent.setup();
    const command = vi.fn().mockResolvedValue({});
    render(<MemberManagementPage command={command} initialMembers={[
      { uid: "admin", displayName: "管理员", role: "admin", version: 1, createdAt: "2026-08-27T00:00:00.000Z" },
      { uid: "member", displayName: "最后的同行", role: "member", version: 1, createdAt: "2026-08-27T00:00:00.000Z" },
    ]} />);

    await user.click(screen.getAllByRole("button", { name: "移除" })[1]!);
    await user.click(screen.getByRole("button", { name: "确认移除最后的同行" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "已加入" })).toHaveFocus());
    expect(screen.getByRole("button", { name: "移除" })).toBeDisabled();
  });
});
