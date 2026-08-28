import { describe, expect, it, vi } from "vitest";
import { authServiceUrl, bootstrapWithCode, exchangeAuthenticationCode, getCurrentCloudbaseMember, getCurrentProfile, logout, recoverAuthenticatedMember, requestCustomTicket, signInWithIssuedTicket } from "./authSession";

describe("auth session", () => {
  it("requires the standalone auth service URL", () => {
    expect(authServiceUrl({ VITE_AUTH_SERVICE_URL: " https://auth.example/ " })).toBe("https://auth.example");
    expect(() => authServiceUrl({ VITE_AUTH_SERVICE_URL: "" })).toThrow();
  });

  it("posts bootstrap code with credentials and does not retain it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ role: "admin" }), { status: 200 }));
    await bootstrapWithCode("https://auth.example", "one-time", "state", fetchMock);
    expect(fetchMock).toHaveBeenCalledWith("https://auth.example/api/auth/bootstrap", expect.objectContaining({ method: "POST", credentials: "include" }));
    expect(fetchMock.mock.calls[0]![1].body).toBe(JSON.stringify({ code: "one-time", oauthState: "state" }));
  });

  it("does not duplicate the configured CloudBase gateway path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ role: "admin" }), { status: 200 }));
    await bootstrapWithCode("https://auth.example/api/auth", "one-time", "state", fetchMock);
    expect(fetchMock).toHaveBeenCalledWith("https://auth.example/api/auth/bootstrap", expect.anything());
  });

  it("returns a custom ticket from the standalone auth service", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ticket: "ticket" }), { status: 200 }));
    await expect(requestCustomTicket("https://auth.example", fetchMock)).resolves.toBe("ticket");
    expect(fetchMock).toHaveBeenCalledWith("https://auth.example/api/auth/ticket", expect.objectContaining({ method: "POST", credentials: "include" }));
  });

  it("loads the authenticated member profile with credentials", async () => {
    const member = { uid: "fs_member", displayName: "成员", role: "member", version: 0, createdAt: "2026-08-27T00:00:00.000Z" } as const;
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ member }), { status: 200 }));
    await expect(getCurrentProfile("https://auth.example", fetchMock)).resolves.toEqual(member);
    expect(fetchMock).toHaveBeenCalledWith("https://auth.example/api/auth/profile", expect.objectContaining({ method: "GET", credentials: "include" }));
  });

  it("exchanges a callback code without relying on browser cookies", async () => {
    const member = { uid: "fs_admin", displayName: "一鸣", role: "admin", version: 1, createdAt: "2026-08-27T00:00:00.000Z" } as const;
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ member, ticket: "custom-ticket" }), { status: 200 }));

    await expect(exchangeAuthenticationCode("https://auth.example/api/auth", "one-time", fetchMock)).resolves.toEqual({ member, ticket: "custom-ticket" });
    expect(fetchMock).toHaveBeenCalledWith("https://auth.example/api/auth/exchange", expect.objectContaining({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "one-time" }),
    }));
  });

  it("replaces stale CloudBase state with the exchanged ticket and verifies the resulting user", async () => {
    const order: string[] = [];
    const auth = {
      signOut: vi.fn(async () => { order.push("sign-out"); }),
      signInWithCustomTicket: vi.fn(async (getTicket: () => Promise<string>) => { order.push(await getTicket()); }),
      getCurrentUser: vi.fn(async () => ({ uid: "fs_admin" })),
    };

    await signInWithIssuedTicket("custom-ticket", "fs_admin", auth);

    expect(order).toEqual(["sign-out", "custom-ticket"]);
    expect(auth.getCurrentUser).toHaveBeenCalledTimes(1);
  });

  it("loads the current member through the authenticated trip function", async () => {
    const member = { uid: "fs_admin", displayName: "一鸣", role: "admin", version: 1, createdAt: "2026-08-27T00:00:00.000Z" } as const;
    const callFunction = vi.fn().mockResolvedValue({ result: { member } });

    await expect(getCurrentCloudbaseMember(callFunction)).resolves.toEqual(member);
    expect(callFunction).toHaveBeenCalledWith({ name: "trip-api", data: { action: "getCurrentMember" } });
  });

  it("recovers only from an existing CloudBase user session", async () => {
    const member = { uid: "fs_admin", displayName: "一鸣", role: "admin", version: 1, createdAt: "2026-08-27T00:00:00.000Z" } as const;
    const getMember = vi.fn().mockResolvedValue(member);

    await expect(recoverAuthenticatedMember({
      getCurrentUser: vi.fn().mockResolvedValue({ uid: member.uid }),
      getMember,
    })).resolves.toEqual(member);

    expect(getMember).toHaveBeenCalledTimes(1);
    await expect(recoverAuthenticatedMember({
      getCurrentUser: vi.fn().mockResolvedValue(null),
      getMember,
    })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });

    expect(getMember).toHaveBeenCalledTimes(1);
  });

  it("always clears the local CloudBase session when server logout is unavailable", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    const auth = { signOut: vi.fn().mockResolvedValue(undefined) };

    await expect(logout("https://auth.example", fetchMock, auth)).resolves.toBeUndefined();

    expect(auth.signOut).toHaveBeenCalledTimes(1);
  });
});
