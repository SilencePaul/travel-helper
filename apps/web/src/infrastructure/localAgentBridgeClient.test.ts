import { describe, expect, it, vi } from "vitest";
import { LocalAgentBridgeClient } from "./localAgentBridgeClient";

const prepared = {
  publicKeyJwk: { kty: "EC" as const, crv: "P-256" as const, x: "x-coordinate", y: "y-coordinate" },
  pairingCodeHash: "2g8DdGhJvqg00hyxT13Po40J6lVT92CRPLHZfoW3szI",
  pairingCodeFingerprint: "9A4F · 20C1",
};

describe("LocalAgentBridgeClient", () => {
  it.each([
    "https://127.0.0.1:43120",
    "http://localhost:43120",
    "http://127.0.0.1",
    "http://user:password@127.0.0.1:43120",
    "http://127.0.0.1:43120/bridge",
  ])("rejects a non-strict loopback address: %s", (address) => {
    expect(() => new LocalAgentBridgeClient(address)).toThrow("INVALID_BRIDGE_URL");
  });

  it("prepares only non-secret pairing material with credential-free no-store fetch", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data: prepared }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const client = new LocalAgentBridgeClient("http://127.0.0.1:43120", { fetch });

    await expect(client.prepare(["submitProposalBatch", "reportVerificationBlocked"])).resolves.toEqual(prepared);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:43120/v1/agent-runs/prepare");
    expect(init).toMatchObject({ method: "POST", credentials: "omit", cache: "no-store" });
    expect(JSON.parse(String(init.body))).toEqual({ scope: ["submitProposalBatch", "reportVerificationBlocked"] });
    expect(String(init.body)).not.toContain("pairingCode\"");
    expect(String(init.body)).not.toContain("privateKey");
  });

  it("claims by sending only the AgentRun id to the local bridge", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { agentRunId: "agent-run-1", status: "claimed" } }), { status: 200 }));
    const client = new LocalAgentBridgeClient("http://127.0.0.1:43120", { fetch });

    await expect(client.claim("agent-run-1")).resolves.toEqual({ agentRunId: "agent-run-1", status: "claimed" });
    const [, init] = fetch.mock.calls[0]!;
    expect(JSON.parse(String(init.body))).toEqual({ agentRunId: "agent-run-1" });
  });

  it("rejects malformed bridge responses instead of trusting extra secret fields", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      data: { ...prepared, pairingCode: "plaintext-secret" },
    }), { status: 200 }));
    const client = new LocalAgentBridgeClient("http://127.0.0.1:43120", { fetch });

    await expect(client.prepare(["submitProposalBatch"])).rejects.toThrow("INVALID_BRIDGE_RESPONSE");
  });

  it("aborts a bridge request when its timeout elapses", async () => {
    const fetch = vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    }));
    const client = new LocalAgentBridgeClient("http://127.0.0.1:43120", { fetch: fetch as typeof globalThis.fetch, timeoutMs: 5 });

    await expect(client.prepare(["submitProposalBatch"])).rejects.toThrow("BRIDGE_UNAVAILABLE");
  });

  it("keeps the timeout active while the response body is being read", async () => {
    let responseSignal: AbortSignal | undefined;
    const fetch = vi.fn((_url: string, init?: RequestInit) => {
      responseSignal = init?.signal ?? undefined;
      return Promise.resolve({
        ok: true,
        json: () => new Promise((_resolve, reject) => {
          responseSignal?.addEventListener("abort", () => reject(responseSignal?.reason), { once: true });
        }),
      } as Response);
    });
    const client = new LocalAgentBridgeClient("http://127.0.0.1:43120", { fetch: fetch as typeof globalThis.fetch, timeoutMs: 5 });

    const outcome = await Promise.race([
      client.prepare(["submitProposalBatch"]).then(() => "resolved", (error: Error) => error.message),
      new Promise<string>((resolve) => globalThis.setTimeout(() => resolve("still-pending"), 30)),
    ]);
    expect(outcome).toBe("BRIDGE_UNAVAILABLE");
  });
});
