import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Member } from "@travel/contracts";
import { useState } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthCallbackPage } from "./AuthCallbackPage";
import { BootstrapPage } from "./BootstrapPage";

const { bootstrapWithCode, recoverAuthenticatedMember, signInWithCustomTicket } = vi.hoisted(() => ({
  bootstrapWithCode: vi.fn(),
  recoverAuthenticatedMember: vi.fn(),
  signInWithCustomTicket: vi.fn(),
}));

vi.mock("../../infrastructure/authSession", () => ({
  authServiceUrl: () => "https://auth.example/api/auth",
  bootstrapWithCode,
  recoverAuthenticatedMember,
  signInWithCustomTicket,
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
    recoverAuthenticatedMember.mockReset();
    signInWithCustomTicket.mockReset().mockResolvedValue(undefined);
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

  it("skips bootstrap for an already-approved member on a stale callback", async () => {
    recoverAuthenticatedMember.mockResolvedValue(adminMember);

    render(
      <MemoryRouter initialEntries={["/?auth_callback=1&status=bootstrap&state=old-state"]}>
        <CallbackHarness />
      </MemoryRouter>,
    );

    expect(await screen.findByText("一鸣与美垚的旅行")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "初始化管理员" })).not.toBeInTheDocument();
  });
});
