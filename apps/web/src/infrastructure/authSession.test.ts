import { describe, expect, it, vi } from "vitest";
import { authServiceUrl, bootstrapWithCode, requestCustomTicket } from "./authSession";

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

  it("returns a custom ticket from the standalone auth service", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ticket: "ticket" }), { status: 200 }));
    await expect(requestCustomTicket("https://auth.example", fetchMock)).resolves.toBe("ticket");
    expect(fetchMock).toHaveBeenCalledWith("https://auth.example/api/auth/ticket", expect.objectContaining({ method: "POST", credentials: "include" }));
  });
});
