// @ts-expect-error Vitest executes this loopback transport test in Node; the Web build intentionally omits Node globals.
import { createServer } from "node:http";
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
  agentRunId: "agent-run-1",
  operationId: "operation-1",
  reconciliationState: "active" as const,
  startedAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:01:00.000Z",
};

const executeInput = {
  agentRunId: "agent-run-1",
  operationId: "operation-1",
  targetCategory: "hotel" as const,
  targetScopeId: `scope_${"a".repeat(64)}`,
  disclosureFingerprint: "b".repeat(64),
};

const resumeInput = {
  agentRunId: "agent-run-2",
  operationId: "operation-2",
  researchTaskId: "research-task-1",
  resumeAction: "skip_blocked_source" as const,
};

const cancelInput = {
  researchTaskId: "research-task-1",
  agentRunId: "agent-run-1",
  operationId: "operation-1",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function assertSafeRequest(init: RequestInit | undefined) {
  expect(init).toMatchObject({
    credentials: "omit",
    cache: "no-store",
    mode: "cors",
    redirect: "error",
  });
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

  it("sends no scope while honoring the prepare abort signal", async () => {
    let requestSignal: AbortSignal | undefined;
    const fetch = vi.fn((_url: string, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    });
    const controller = new AbortController();
    const client = new LocalAgentBridgeClient("http://127.0.0.1:43120", {
      fetch: fetch as typeof globalThis.fetch,
      timeoutMs: 50,
    });

    const request = client.prepare({ signal: controller.signal });
    controller.abort(new Error("caller stopped"));
    const outcome = await Promise.race([
      request.then(() => "resolved", (error: LocalAgentBridgeError) => error.code),
      new Promise<string>((resolve) => globalThis.setTimeout(() => resolve("still-pending"), 20)),
    ]);

    expect(outcome).toBe("BRIDGE_UNAVAILABLE");
    expect(requestSignal?.aborted).toBe(true);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({});
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
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: {
        ...researchStatus,
        agentRunId: resumeInput.agentRunId,
        operationId: resumeInput.operationId,
      } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: cancelledStatus }));
    const client = new LocalAgentBridgeClient("http://127.0.0.1:43120", { fetch });

    await expect(client.executeTravelResearch(executeInput)).resolves.toEqual(researchStatus);
    await expect(client.getResearchStatus()).resolves.toEqual(researchStatus);
    await expect(client.resumeTravelResearch(resumeInput)).resolves.toEqual({
      ...researchStatus,
      agentRunId: resumeInput.agentRunId,
      operationId: resumeInput.operationId,
    });
    await expect(client.cancelResearch(cancelInput)).resolves.toEqual(cancelledStatus);

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
    expect(JSON.parse(String(calls[3]?.[1]?.body))).toEqual(cancelInput);
    for (const [, init] of calls) assertSafeRequest(init);
  });

  it.each(["resume", "cancel"])("rejects a non-idle %s status for another research task", async (method) => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({
      ok: true,
      data: { ...researchStatus, researchTaskId: "other-research-task" },
    }));
    const client = new LocalAgentBridgeClient("http://127.0.0.1:43120", { fetch });

    const operation = method === "resume"
      ? client.resumeTravelResearch(resumeInput)
      : client.cancelResearch(cancelInput);

    await expect(operation).rejects.toMatchObject({ code: "INVALID_BRIDGE_RESPONSE" });
  });

  it.each(["resume", "cancel"])("rejects an idle %s response because it cannot identify the requested task", async (method) => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ ok: true, data: { phase: "idle" } }));
    const client = new LocalAgentBridgeClient("http://127.0.0.1:43120", { fetch });

    const operation = method === "resume"
      ? client.resumeTravelResearch(resumeInput)
      : client.cancelResearch(cancelInput);

    await expect(operation).rejects.toMatchObject({ code: "INVALID_BRIDGE_RESPONSE" });
  });

  it.each([
    ["prepare", () => ({ ok: true, data: { ...prepared, pairingCode: "plaintext-secret" } })],
    ["execute", () => ({ ok: true, data: { ...researchStatus, log: "Bearer private-token" } })],
    ["status", () => ({ ok: true, data: researchStatus, url: "https://user:pass@example.org/private" })],
    ["resume", () => ({ ok: true, data: {
      ...researchStatus,
      agentRunId: resumeInput.agentRunId,
      operationId: resumeInput.operationId,
      credentials: "private",
    } })],
    ["cancel", () => ({ ok: true, data: { ...researchStatus, prompt: "private" } })],
  ])("strictly rejects extra secret-capable fields in a successful %s response", async (method, body) => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(body()));
    const client = new LocalAgentBridgeClient("http://127.0.0.1:43120", { fetch });
    const operation = method === "prepare" ? client.prepare()
      : method === "execute" ? client.executeTravelResearch(executeInput)
        : method === "status" ? client.getResearchStatus()
          : method === "resume" ? client.resumeTravelResearch(resumeInput)
            : client.cancelResearch(cancelInput);

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

  it.each([
    [201, "application/json"],
    [200, "text/plain"],
    [200, null],
  ])("rejects success-shaped data with HTTP %s and content-type %s", async (status, contentType) => {
    const headers = contentType === null ? undefined : { "content-type": contentType };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data: researchStatus }), {
      status,
      headers,
    }));
    const client = new LocalAgentBridgeClient("http://127.0.0.1:43120", { fetch });

    await expect(client.getResearchStatus()).rejects.toMatchObject({ code: "INVALID_BRIDGE_RESPONSE" });
  });

  it.each([
    "{\"ok\":true,\"data\":{\"phase\":\"idle\"},\"__proto__\":{\"log\":\"secret\"}}",
    "{\"ok\":false,\"error\":\"CODEX_NOT_AVAILABLE\",\"constructor\":{\"token\":\"secret\"}}",
  ])("rejects own prototype-related fields instead of allowing a schema bypass", async (source) => {
    const status = source.includes("\"ok\":true") ? 200 : 409;
    const fetch = vi.fn().mockResolvedValue(new Response(source, {
      status,
      headers: { "content-type": "application/json" },
    }));
    const client = new LocalAgentBridgeClient("http://127.0.0.1:43120", { fetch });

    await expect(client.getResearchStatus()).rejects.toMatchObject({ code: "INVALID_BRIDGE_RESPONSE" });
  });

  it("rejects a declared oversized response before acquiring its body reader", async () => {
    let readerAcquired = false;
    let cancelCount = 0;
    const response = {
      status: 200,
      headers: new Headers({
        "content-type": "application/json",
        "content-length": String(64 * 1_024 + 1),
      }),
      body: {
        cancel: async () => { cancelCount += 1; },
        getReader() {
          readerAcquired = true;
          throw new Error("body must not be read");
        },
      },
      json: async () => ({ ok: true, data: researchStatus }),
    } as unknown as Response;
    const fetch = vi.fn().mockResolvedValue(response);
    const client = new LocalAgentBridgeClient("http://127.0.0.1:43120", { fetch });

    await expect(client.getResearchStatus()).rejects.toMatchObject({ code: "INVALID_BRIDGE_RESPONSE" });
    expect(readerAcquired).toBe(false);
    expect(cancelCount).toBe(1);
  });

  it.each(["mime", "reader"])("awaits body cancellation on an early %s rejection", async (failure) => {
    const events: string[] = [];
    const body = {
      cancel: async () => {
        events.push("cancel-start");
        await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 10));
        events.push("cancel-end");
      },
      getReader() {
        events.push("reader");
        throw new Error("reader unavailable");
      },
    };
    const response = {
      status: 200,
      headers: new Headers({ "content-type": failure === "mime" ? "text/plain" : "application/json" }),
      body,
      json: async () => ({ ok: true, data: researchStatus }),
    } as unknown as Response;
    const fetch = vi.fn().mockResolvedValue(response);
    const client = new LocalAgentBridgeClient("http://127.0.0.1:43120", { fetch, timeoutMs: 1_000 });

    await expect(client.getResearchStatus()).rejects.toMatchObject({ code: "INVALID_BRIDGE_RESPONSE" });
    expect(events).toEqual(failure === "mime"
      ? ["cancel-start", "cancel-end"]
      : ["reader", "cancel-start", "cancel-end"]);
  });

  it.each(["mime", "length"])("times out an early %s rejection when body cancellation never settles", async (failure) => {
    let cancelCount = 0;
    let readerAcquired = false;
    const response = {
      status: 200,
      headers: new Headers({
        "content-type": failure === "mime" ? "text/plain" : "application/json",
        ...(failure === "length" ? { "content-length": String(64 * 1_024 + 1) } : {}),
      }),
      body: {
        cancel: () => {
          cancelCount += 1;
          return new Promise<void>(() => undefined);
        },
        getReader: () => {
          readerAcquired = true;
          throw new Error("body must not be read");
        },
      },
    } as unknown as Response;
    const fetch = vi.fn().mockResolvedValue(response);
    const client = new LocalAgentBridgeClient("http://127.0.0.1:43120", { fetch, timeoutMs: 5 });

    const outcome = await Promise.race([
      client.getResearchStatus().then(() => "resolved", (error: LocalAgentBridgeError) => error.code),
      new Promise<string>((resolve) => globalThis.setTimeout(() => resolve("still-pending"), 30)),
    ]);

    expect(outcome).toBe("BRIDGE_UNAVAILABLE");
    expect(cancelCount).toBe(1);
    expect(readerAcquired).toBe(false);
  });

  it("cancels streamed response reading as soon as the 64 KiB accumulation limit is exceeded", async () => {
    let readCount = 0;
    let cancelCount = 0;
    const chunks = [new Uint8Array(40 * 1_024), new Uint8Array(40 * 1_024)];
    const response = {
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      body: {
        getReader() {
          return {
            read: async () => ({ done: false as const, value: chunks[readCount++] }),
            cancel: async () => { cancelCount += 1; },
            releaseLock: () => undefined,
          };
        },
      },
      json: async () => ({ ok: true, data: researchStatus }),
    } as unknown as Response;
    const fetch = vi.fn().mockResolvedValue(response);
    const client = new LocalAgentBridgeClient("http://127.0.0.1:43120", { fetch });

    await expect(client.getResearchStatus()).rejects.toMatchObject({ code: "INVALID_BRIDGE_RESPONSE" });
    expect(readCount).toBe(2);
    expect(cancelCount).toBe(1);
  });

  it("rejects a zero-length unfinished chunk and awaits cancel before releasing the reader lock", async () => {
    const events: string[] = [];
    let readCount = 0;
    const response = {
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      body: {
        getReader() {
          return {
            read: async () => {
              readCount += 1;
              return readCount === 1
                ? { done: false as const, value: new Uint8Array() }
                : { done: true as const, value: undefined };
            },
            cancel: async () => {
              events.push("cancel-start");
              await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 10));
              events.push("cancel-end");
            },
            releaseLock: () => { events.push("release"); },
          };
        },
      },
    } as unknown as Response;
    const fetch = vi.fn().mockResolvedValue(response);
    const client = new LocalAgentBridgeClient("http://127.0.0.1:43120", { fetch, timeoutMs: 1_000 });

    await expect(client.getResearchStatus()).rejects.toMatchObject({ code: "INVALID_BRIDGE_RESPONSE" });
    expect(readCount).toBe(1);
    expect(events).toEqual(["cancel-start", "cancel-end", "release"]);
  });

  it("times out a response error when reader cancellation never settles and still releases the lock", async () => {
    let cancelCount = 0;
    let releaseCount = 0;
    const response = {
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      body: {
        getReader() {
          return {
            read: async () => ({ done: false as const, value: new Uint8Array() }),
            cancel: () => {
              cancelCount += 1;
              return new Promise<void>(() => undefined);
            },
            releaseLock: () => { releaseCount += 1; },
          };
        },
      },
    } as unknown as Response;
    const fetch = vi.fn().mockResolvedValue(response);
    const client = new LocalAgentBridgeClient("http://127.0.0.1:43120", { fetch, timeoutMs: 5 });

    const outcome = await Promise.race([
      client.getResearchStatus().then(() => "resolved", (error: LocalAgentBridgeError) => error.code),
      new Promise<string>((resolve) => globalThis.setTimeout(() => resolve("still-pending"), 30)),
    ]);

    expect(outcome).toBe("BRIDGE_UNAVAILABLE");
    expect(cancelCount).toBe(1);
    expect(releaseCount).toBe(1);
  });

  it("lets a 1 ms timeout interrupt a pathological stream of one-byte microtask chunks", async () => {
    let readCount = 0;
    let cancelCount = 0;
    const response = {
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      body: {
        getReader() {
          return {
            read: async () => {
              readCount += 1;
              return readCount <= 5_000
                ? { done: false as const, value: new Uint8Array([0x20]) }
                : { done: true as const, value: undefined };
            },
            cancel: async () => { cancelCount += 1; },
            releaseLock: () => undefined,
          };
        },
      },
    } as unknown as Response;
    const fetch = vi.fn().mockResolvedValue(response);
    const client = new LocalAgentBridgeClient("http://127.0.0.1:43120", { fetch, timeoutMs: 1 });

    const error = await client.getResearchStatus().then(() => undefined, (value: unknown) => value);

    expect(error).toMatchObject({ code: "BRIDGE_UNAVAILABLE" });
    expect(readCount).toBeLessThan(5_000);
    expect(cancelCount).toBe(1);
  });

  it("preserves the original response error when cancel and release also fail", async () => {
    const response = {
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      body: {
        getReader() {
          let first = true;
          return {
            read: async () => {
              if (first) {
                first = false;
                return { done: false as const, value: new Uint8Array() };
              }
              return { done: true as const, value: undefined };
            },
            cancel: async () => { throw new Error("cancel detail"); },
            releaseLock: () => { throw new Error("release detail"); },
          };
        },
      },
    } as unknown as Response;
    const fetch = vi.fn().mockResolvedValue(response);
    const client = new LocalAgentBridgeClient("http://127.0.0.1:43120", { fetch });

    await expect(client.getResearchStatus()).rejects.toMatchObject({ code: "INVALID_BRIDGE_RESPONSE" });
  });

  it("cancels the body of a fetch response that arrives after the caller has already aborted", async () => {
    let resolveFetch!: (response: Response) => void;
    let bodyCancelled!: () => void;
    const cancelled = new Promise<void>((resolve) => { bodyCancelled = resolve; });
    let cancelCount = 0;
    const response = {
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      body: {
        cancel: async () => {
          cancelCount += 1;
          bodyCancelled();
        },
      },
    } as unknown as Response;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    const controller = new AbortController();
    const client = new LocalAgentBridgeClient("http://127.0.0.1:43120", { fetch, timeoutMs: 1_000 });

    const request = client.getResearchStatus({ signal: controller.signal });
    controller.abort(new Error("caller stopped"));
    await expect(request).rejects.toMatchObject({ code: "BRIDGE_UNAVAILABLE" });
    resolveFetch(response);
    const cleanup = await Promise.race([
      cancelled.then(() => "cancelled"),
      new Promise<string>((resolve) => globalThis.setTimeout(() => resolve("still-open"), 30)),
    ]);

    expect(cleanup).toBe("cancelled");
    expect(cancelCount).toBe(1);
  });

  it("closes a real loopback response socket when body reading times out", async () => {
    let socketClosed!: () => void;
    const closed = new Promise<void>((resolve) => { socketClosed = resolve; });
    const server = createServer((_request: unknown, response: {
      on(event: "close", listener: () => void): void;
      writeHead(status: number, headers: Record<string, string>): void;
      write(chunk: string): void;
    }) => {
      response.on("close", socketClosed);
      response.writeHead(200, { "content-type": "application/json" });
      response.write("{\"ok\":true,\"data\":");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("loopback test server did not bind");
    const client = new LocalAgentBridgeClient(`http://127.0.0.1:${address.port}`, { timeoutMs: 10 });

    try {
      await expect(client.getResearchStatus()).rejects.toMatchObject({ code: "BRIDGE_UNAVAILABLE" });
      const outcome = await Promise.race([
        closed.then(() => "closed"),
        new Promise<string>((resolve) => globalThis.setTimeout(() => resolve("still-open"), 500)),
      ]);
      expect(outcome).toBe("closed");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects a pre-aborted request without invoking fetch", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ ok: true, data: researchStatus }));
    const controller = new AbortController();
    controller.abort(new Error("already stopped"));
    const client = new LocalAgentBridgeClient("http://127.0.0.1:43120", { fetch });

    await expect(client.getResearchStatus({ signal: controller.signal })).rejects.toMatchObject({
      code: "BRIDGE_UNAVAILABLE",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("times out even when the fetch implementation ignores AbortSignal", async () => {
    const fetch = vi.fn(() => new Promise<Response>(() => undefined));
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

  it("times out even when the response body reader ignores AbortSignal", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const fetch = vi.fn().mockResolvedValue(response);
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
    const response = new Response(new ReadableStream<Uint8Array>({
      pull: () => {
        bodyStarted();
        return new Promise<void>(() => undefined);
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const fetch = vi.fn((_url: string, init?: RequestInit) => {
      responseSignal = init?.signal ?? undefined;
      return Promise.resolve(response);
    });
    const controller = new AbortController();
    const client = new LocalAgentBridgeClient("http://127.0.0.1:43120", {
      fetch: fetch as typeof globalThis.fetch,
      timeoutMs: 1_000,
    });

    const request = client.getResearchStatus({ signal: controller.signal });
    await readingBody;
    controller.abort(new Error("caller stopped waiting"));

    const outcome = await Promise.race([
      request.then(() => "resolved", (error: LocalAgentBridgeError) => error.code),
      new Promise<string>((resolve) => globalThis.setTimeout(() => resolve("still-pending"), 30)),
    ]);
    expect(outcome).toBe("BRIDGE_UNAVAILABLE");
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
