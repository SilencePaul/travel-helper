import { ResearchErrorCodeSchema, type ResearchStatus } from "@travel/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  consumeLocalAgentBridgeFromFragment,
  LocalAgentBridgeClient,
  LocalAgentBridgeError,
} from "./localAgentBridgeClient";

const prepared = {
  publicKeyJwk: { kty: "EC" as const, crv: "P-256" as const, x: "x-coordinate", y: "y-coordinate" },
  pairingCodeHash: "2g8DdGhJvqg00hyxT13Po40J6lVT92CRPLHZfoW3szI",
  pairingCodeFingerprint: "9A4F · 20C1",
};

const researchStatus = {
  phase: "researching" as const,
  researchTaskId: "research-task-1",
  startedAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:01:00.000Z",
};

const executeInput = {
  agentRunId: "agent-run-1",
  targetCategory: "hotel" as const,
  targetScopeId: `scope_${"a".repeat(64)}`,
  disclosureFingerprint: "b".repeat(64),
};

const resumeInput = {
  agentRunId: "agent-run-2",
  researchTaskId: "research-task-1",
  resumeAction: "skip_blocked_source" as const,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function assertSafeRequest(init: RequestInit | undefined) {
  expect(init).toMatchObject({ credentials: "omit", cache: "no-store", mode: "cors" });
  expect(init?.signal).toBeInstanceOf(AbortSignal);
}

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

  it("prepares with an exact empty body and credential-free no-store fetch", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ ok: true, data: prepared }));
    const client = new LocalAgentBridgeClient("http://127.0.0.1:43120", { fetch });

    await expect(client.prepare()).resolves.toEqual(prepared);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:43120/v1/agent-runs/prepare");
    expect(init).toMatchObject({ method: "POST", headers: { "content-type": "application/json" } });
    assertSafeRequest(init);
    expect(String(init.body)).toBe("{}");
    expect(String(init.body)).not.toContain("scope");
    expect(String(init.body)).not.toContain("pairingCode\"");
    expect(String(init.body)).not.toContain("privateKey");
  });

  it("claims by sending only the AgentRun id to the local bridge", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({
      ok: true,
      data: { agentRunId: "agent-run-1", status: "claimed" },
    }));
    const client = new LocalAgentBridgeClient("http://127.0.0.1:43120", { fetch });

    await expect(client.claim("agent-run-1")).resolves.toEqual({ agentRunId: "agent-run-1", status: "claimed" });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:43120/v1/agent-runs/claim");
    expect(init).toMatchObject({ method: "POST" });
    assertSafeRequest(init);
    expect(JSON.parse(String(init.body))).toEqual({ agentRunId: "agent-run-1" });
  });

  it("calls each fixed travel research route with its exact method, path, and body", async () => {
    const cancelledStatus: ResearchStatus = {
      ...researchStatus,
      phase: "cancelled",
      errorCode: "CODEX_RESEARCH_CANCELLED",
    };
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: researchStatus }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: researchStatus }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: researchStatus }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: cancelledStatus }));
    const client = new LocalAgentBridgeClient("http://127.0.0.1:43120", { fetch });

    await expect(client.executeTravelResearch(executeInput)).resolves.toEqual(researchStatus);
    await expect(client.getResearchStatus()).resolves.toEqual(researchStatus);
    await expect(client.resumeTravelResearch(resumeInput)).resolves.toEqual(researchStatus);
    await expect(client.cancelResearch({ researchTaskId: "research-task-1" })).resolves.toEqual(cancelledStatus);

    const calls = fetch.mock.calls;
    expect(calls).toHaveLength(4);
    expect(calls[0]?.[0]).toBe("http://127.0.0.1:43120/v1/agent-runs/execute-travel-research");
    expect(calls[0]?.[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(calls[0]?.[1]?.body))).toEqual(executeInput);
    expect(calls[1]?.[0]).toBe("http://127.0.0.1:43120/v1/agent-runs/research-status");
    expect(calls[1]?.[1]).toMatchObject({ method: "GET" });
    expect(Object.hasOwn(calls[1]?.[1] ?? {}, "body")).toBe(false);
    expect(Object.hasOwn(calls[1]?.[1]?.headers ?? {}, "content-type")).toBe(false);
    expect(calls[2]?.[0]).toBe("http://127.0.0.1:43120/v1/agent-runs/resume-travel-research");
    expect(calls[2]?.[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(calls[2]?.[1]?.body))).toEqual(resumeInput);
    expect(calls[3]?.[0]).toBe("http://127.0.0.1:43120/v1/agent-runs/cancel-research");
    expect(calls[3]?.[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(calls[3]?.[1]?.body))).toEqual({ researchTaskId: "research-task-1" });
    for (const [, init] of calls) assertSafeRequest(init);
  });

  it.each([
    ["prepare", () => ({ ok: true, data: { ...prepared, pairingCode: "plaintext-secret" } })],
    ["execute", () => ({ ok: true, data: { ...researchStatus, log: "Bearer private-token" } })],
    ["status", () => ({ ok: true, data: researchStatus, url: "https://user:pass@example.org/private" })],
    ["resume", () => ({ ok: true, data: { ...researchStatus, credentials: "private" } })],
    ["cancel", () => ({ ok: true, data: { ...researchStatus, prompt: "private" } })],
  ])("strictly rejects extra secret-capable fields in a successful %s response", async (method, body) => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(body()));
    const client = new LocalAgentBridgeClient("http://127.0.0.1:43120", { fetch });
    const operation = method === "prepare" ? client.prepare()
      : method === "execute" ? client.executeTravelResearch(executeInput)
        : method === "status" ? client.getResearchStatus()
          : method === "resume" ? client.resumeTravelResearch(resumeInput)
            : client.cancelResearch({ researchTaskId: "research-task-1" });

    await expect(operation).rejects.toMatchObject({
      name: "LocalAgentBridgeError",
      code: "INVALID_BRIDGE_RESPONSE",
      message: "INVALID_BRIDGE_RESPONSE",
    });
  });

  it.each(ResearchErrorCodeSchema.options)("preserves the stable non-2xx bridge error code %s", async (code) => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ ok: false, error: code }, 409));
    const client = new LocalAgentBridgeClient("http://127.0.0.1:43120", { fetch });

    const error = await client.getResearchStatus().then(() => undefined, (value: unknown) => value);

    expect(error).toBeInstanceOf(LocalAgentBridgeError);
    expect(error).toMatchObject({ name: "LocalAgentBridgeError", code, message: code });
  });

  it.each([
    { ok: false, error: "CODEX_NOT_AVAILABLE", detail: "private stack" },
    { ok: false, error: "INVALID_REQUEST" },
    { ok: false, error: "UNKNOWN_ERROR" },
  ])("rejects a non-strict or non-contract bridge error: $error", async (body) => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(body, 500));
    const client = new LocalAgentBridgeClient("http://127.0.0.1:43120", { fetch });

    await expect(client.getResearchStatus()).rejects.toMatchObject({ code: "INVALID_BRIDGE_RESPONSE" });
  });

  it("rejects malformed JSON as an invalid bridge response", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("not-json", { status: 200 }));
    const client = new LocalAgentBridgeClient("http://127.0.0.1:43120", { fetch });

    await expect(client.getResearchStatus()).rejects.toMatchObject({ code: "INVALID_BRIDGE_RESPONSE" });
  });

  it("aborts a bridge fetch when its timeout elapses", async () => {
    const fetch = vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    }));
    const client = new LocalAgentBridgeClient("http://127.0.0.1:43120", {
      fetch: fetch as typeof globalThis.fetch,
      timeoutMs: 5,
    });

    await expect(client.getResearchStatus()).rejects.toMatchObject({ code: "BRIDGE_UNAVAILABLE" });
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
    const client = new LocalAgentBridgeClient("http://127.0.0.1:43120", {
      fetch: fetch as typeof globalThis.fetch,
      timeoutMs: 5,
    });

    const outcome = await Promise.race([
      client.getResearchStatus().then(() => "resolved", (error: LocalAgentBridgeError) => error.code),
      new Promise<string>((resolve) => globalThis.setTimeout(() => resolve("still-pending"), 30)),
    ]);
    expect(outcome).toBe("BRIDGE_UNAVAILABLE");
  });

  it("keeps an external abort signal active while the response body is being read", async () => {
    let responseSignal: AbortSignal | undefined;
    let bodyStarted!: () => void;
    const readingBody = new Promise<void>((resolve) => { bodyStarted = resolve; });
    const fetch = vi.fn((_url: string, init?: RequestInit) => {
      responseSignal = init?.signal ?? undefined;
      return Promise.resolve({
        ok: true,
        json: () => new Promise((_resolve, reject) => {
          bodyStarted();
          responseSignal?.addEventListener("abort", () => reject(responseSignal?.reason), { once: true });
        }),
      } as Response);
    });
    const controller = new AbortController();
    const client = new LocalAgentBridgeClient("http://127.0.0.1:43120", {
      fetch: fetch as typeof globalThis.fetch,
      timeoutMs: 1_000,
    });

    const request = client.getResearchStatus({ signal: controller.signal });
    await readingBody;
    controller.abort(new Error("caller stopped waiting"));

    await expect(request).rejects.toMatchObject({ code: "BRIDGE_UNAVAILABLE" });
    expect(responseSignal?.aborted).toBe(true);
  });

  it("consumes a loopback origin from the fragment and clears it immediately", () => {
    const replaceState = vi.fn();
    const location = { href: "https://trip.example/decisions?tab=agent#agentBridge=http%3A%2F%2F127.0.0.1%3A43120" };

    const bridge = consumeLocalAgentBridgeFromFragment(location, { state: { keep: true }, replaceState });

    expect(bridge).toBeInstanceOf(LocalAgentBridgeClient);
    expect(replaceState).toHaveBeenCalledWith({ keep: true }, "", "https://trip.example/decisions?tab=agent");
  });

  it("clears an invalid bridge fragment without connecting or storing it", () => {
    const replaceState = vi.fn();
    const location = { href: "https://trip.example/#agentBridge=https%3A%2F%2Fevil.example" };

    expect(consumeLocalAgentBridgeFromFragment(location, { state: null, replaceState })).toBeUndefined();
    expect(replaceState).toHaveBeenCalledWith(null, "", "https://trip.example/");
  });

  it("keeps App initialization alive and clears the fragment when replaceState throws", () => {
    const location = {
      href: "https://trip.example/#agentBridge=http%3A%2F%2F127.0.0.1%3A43120",
      hash: "#agentBridge=http%3A%2F%2F127.0.0.1%3A43120",
    };
    const history = { state: null, replaceState: vi.fn(() => { throw new Error("history unavailable"); }) };
    let bridge: LocalAgentBridgeClient | undefined;

    expect(() => { bridge = consumeLocalAgentBridgeFromFragment(location, history); }).not.toThrow();
    expect(bridge).toBeInstanceOf(LocalAgentBridgeClient);
    expect(location.hash).toBe("");
  });
});
