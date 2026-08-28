import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Member } from "@travel/contracts";
import { useState } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthCallbackPage } from "./AuthCallbackPage";
import { BootstrapPage } from "./BootstrapPage";
import { PendingApprovalPage } from "./PendingApprovalPage";
import { memberVerificationCode } from "../members/memberVerification";

const { bootstrapWithCode, exchangeAuthenticationCode, recoverAuthenticatedMember, signInWithIssuedTicket, startLogin } = vi.hoisted(() => ({
  bootstrapWithCode: vi.fn(),
  exchangeAuthenticationCode: vi.fn(),
  recoverAuthenticatedMember: vi.fn(),
  signInWithIssuedTicket: vi.fn(),
  startLogin: vi.fn(),
}));

vi.mock("../../infrastructure/authSession", () => ({
  authServiceUrl: () => "https://auth.example/api/auth",
  bootstrapWithCode,
  exchangeAuthenticationCode,
  recoverAuthenticatedMember,
  signInWithIssuedTicket,
  startLogin,
}));

const adminMember: Member = { uid: "fs_admin", displayName: "一鸣", role: "admin", version: 1, createdAt: "2026-08-27T00:00:00.000Z" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function CallbackHarness() {
  const [member, setMember] = useState<Member>();
  if (member) return <h1>一鸣与美垚的旅行</h1>;
  return (
    <Routes>
      <Route path="/" element={<AuthCallbackPage onAuthenticated={setMember} />} />
      <Route path="/auth/bootstrap" element={<h1>初始化管理员</h1>} />
    </Routes>
  );
}

describe("authentication screen flow", () => {
  beforeEach(() => {
    bootstrapWithCode.mockReset().mockResolvedValue({ role: "admin" });
    exchangeAuthenticationCode.mockReset().mockResolvedValue({ member: adminMember, ticket: "custom-ticket" });
    recoverAuthenticatedMember.mockReset();
    signInWithIssuedTicket.mockReset().mockResolvedValue(undefined);
    startLogin.mockReset();
  });

  it("waits for member recovery before leaving bootstrap", async () => {
    const recovery = deferred<Member>();
    recoverAuthenticatedMember.mockReturnValue(recovery.promise);
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={["/auth/bootstrap?state=test-state"]}>
        <Routes>
          <Route path="/auth/bootstrap" element={<BootstrapPage onAuthenticated={() => undefined} />} />
          <Route path="/" element={<h1>一鸣与美垚的旅行</h1>} />
        </Routes>
      </MemoryRouter>,
    );

    await user.type(screen.getByLabelText("管理员口令"), "correct");
    await user.click(screen.getByRole("button", { name: "完成并进入行程" }));

    expect(screen.queryByText("一鸣与美垚的旅行")).not.toBeInTheDocument();
    recovery.resolve(adminMember);
    expect(await screen.findByText("一鸣与美垚的旅行")).toBeInTheDocument();
  });

  it("exchanges the one-time callback code and skips bootstrap for an approved member", async () => {
    render(
      <MemoryRouter initialEntries={["/?auth_callback=1&status=bootstrap&state=old-state&exchange_code=one-time"]}>
        <CallbackHarness />
      </MemoryRouter>,
    );

    expect(await screen.findByText("一鸣与美垚的旅行")).toBeInTheDocument();
    expect(exchangeAuthenticationCode).toHaveBeenCalledWith("https://auth.example/api/auth", "one-time");
    expect(signInWithIssuedTicket).toHaveBeenCalledWith("custom-ticket", "fs_admin");
    expect(screen.queryByRole("heading", { name: "初始化管理员" })).not.toBeInTheDocument();
  });

  it("offers retry and a fresh Feishu login when callback exchange is temporarily unavailable", async () => {
    exchangeAuthenticationCode
      .mockRejectedValueOnce(Object.assign(new Error("AUTH_SERVICE_UNAVAILABLE"), { code: "AUTH_SERVICE_UNAVAILABLE" }))
      .mockResolvedValueOnce({ member: adminMember, ticket: "custom-ticket" });
    render(
      <MemoryRouter initialEntries={["/?auth_callback=1&status=approved&state=state&exchange_code=retryable"]}>
        <CallbackHarness />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("登录服务暂时不可用");
    expect(screen.getByRole("button", { name: "重新使用飞书登录" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重试完成登录" }));

    expect(await screen.findByText("一鸣与美垚的旅行")).toBeInTheDocument();
    expect(exchangeAuthenticationCode).toHaveBeenCalledTimes(2);
  });

  it("lets a pending member leave the waiting session", async () => {
    const onLogout = vi.fn().mockResolvedValue(undefined);
    recoverAuthenticatedMember.mockResolvedValue({ ...adminMember, role: "pending" });
    render(
      <MemoryRouter>
        <PendingApprovalPage onLogout={onLogout} />
      </MemoryRouter>,
    );

    expect(await screen.findByText(memberVerificationCode(adminMember.uid))).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "退出登录" }));

    expect(onLogout).toHaveBeenCalledTimes(1);
  });
});
