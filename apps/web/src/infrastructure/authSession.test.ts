import { describe, expect, it, vi } from "vitest";
import { authServiceUrl, bootstrapWithCode, getCurrentProfile, requestCustomTicket } from "./authSession";

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
});
