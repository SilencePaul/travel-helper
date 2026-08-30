import { describe, expect, it, vi } from "vitest";
import { RepositoryUnavailableError } from "./cloudbaseTripRepository";
import { CloudBaseDecisionWorkspaceRepository } from "./cloudbaseDecisionWorkspaceRepository";

const workspace = {
  tripId: "trip-1",
  preferences: [],
  candidates: [],
  placements: [],
  evidence: [],
  feedback: [],
  confirmations: [],
  workspaceCursor: "0",
  fetchedAt: "2026-08-28T00:00:00.000Z",
};

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("CloudBaseDecisionWorkspaceRepository", () => {
  it("loads a server-owned workspace and saves an offline snapshot", async () => {
    const storage = memoryStorage();
    const callFunction = vi.fn().mockResolvedValue({ result: workspace });
    const repository = new CloudBaseDecisionWorkspaceRepository({ callFunction, storage });

    await expect(repository.load("trip-1")).resolves.toEqual(workspace);
    expect(callFunction).toHaveBeenCalledWith({ name: "trip-api", data: { action: "getDecisionWorkspace", tripId: "trip-1" } });
    expect(JSON.parse(storage.getItem("travel-decision-workspace:trip-1")!)).toEqual(workspace);
  });

  it("returns the last valid snapshot when the service is offline", async () => {
    const storage = memoryStorage();
    storage.setItem("travel-decision-workspace:trip-1", JSON.stringify(workspace));
    const repository = new CloudBaseDecisionWorkspaceRepository({ callFunction: vi.fn().mockRejectedValue(new Error("offline")), storage });

    await expect(repository.load("trip-1")).resolves.toEqual(workspace);
  });

  it("rejects a strict refresh when the service is offline instead of returning the cache", async () => {
    const storage = memoryStorage();
    storage.setItem("travel-decision-workspace:trip-1", JSON.stringify(workspace));
    const repository = new CloudBaseDecisionWorkspaceRepository({ callFunction: vi.fn().mockRejectedValue(new Error("offline")), storage });

    await expect(repository.refresh("trip-1")).rejects.toBeInstanceOf(RepositoryUnavailableError);
  });

  it("does not let a late lower decimal cursor replace the latest snapshot or cache", async () => {
    const storage = memoryStorage();
    const latest = { ...workspace, workspaceCursor: "10", fetchedAt: "2026-08-28T00:00:10.000Z" };
    const late = { ...workspace, workspaceCursor: "9", fetchedAt: "2026-08-28T00:00:09.000Z" };
    const callFunction = vi.fn()
      .mockResolvedValueOnce({ result: latest })
      .mockResolvedValueOnce({ result: late });
    const repository = new CloudBaseDecisionWorkspaceRepository({ callFunction, storage });

    await expect(repository.load("trip-1")).resolves.toEqual(latest);
    await expect(repository.load("trip-1")).resolves.toEqual(latest);
    expect(JSON.parse(storage.getItem("travel-decision-workspace:trip-1")!)).toEqual(latest);
  });

  it("rejects a non-decimal workspace cursor instead of caching an incomparable snapshot", async () => {
    const repository = new CloudBaseDecisionWorkspaceRepository({
      callFunction: vi.fn().mockResolvedValue({ result: { ...workspace, workspaceCursor: "not-a-cursor" } }),
      storage: memoryStorage(),
    });

    await expect(repository.refresh("trip-1")).rejects.toBeInstanceOf(RepositoryUnavailableError);
  });

  it("rejects a remote workspace that belongs to another trip", async () => {
    const storage = memoryStorage();
    const repository = new CloudBaseDecisionWorkspaceRepository({
      callFunction: vi.fn().mockResolvedValue({ result: { ...workspace, tripId: "trip-2" } }),
      storage,
    });

    await expect(repository.refresh("trip-1")).rejects.toBeInstanceOf(RepositoryUnavailableError);
    expect(storage.getItem("travel-decision-workspace:trip-1")).toBeNull();
    expect(storage.getItem("travel-decision-workspace:trip-2")).toBeNull();
  });

  it.each([
    ["another trip", { ...workspace, tripId: "trip-2" }],
    ["a negative cursor", { ...workspace, workspaceCursor: "-1" }],
    ["a non-decimal cursor", { ...workspace, workspaceCursor: "invalid" }],
    ["a cursor above Number.MAX_SAFE_INTEGER", { ...workspace, workspaceCursor: String(Number.MAX_SAFE_INTEGER + 1) }],
  ])("ignores a cached workspace with %s", async (_label, cached) => {
    const storage = memoryStorage();
    storage.setItem("travel-decision-workspace:trip-1", JSON.stringify(cached));
    const repository = new CloudBaseDecisionWorkspaceRepository({ callFunction: vi.fn().mockRejectedValue(new Error("offline")), storage });

    await expect(repository.load("trip-1")).rejects.toBeInstanceOf(RepositoryUnavailableError);
  });

  it("sends typed commands through trip-api and preserves conflict facts", async () => {
    const conflict = { ok: false as const, error: "VERSION_CONFLICT" as const, latest: { ...workspace, id: "preference-1", revision: 2, updatedAt: workspace.fetchedAt, ownerUid: "fs_member", answers: {}, status: "editing", updatedBy: "fs_member" } };
    const callFunction = vi.fn().mockResolvedValue({ result: conflict });
    const repository = new CloudBaseDecisionWorkspaceRepository({ callFunction, storage: memoryStorage() });
    const command = { action: "upsertPreference" as const, tripId: "trip-1", expectedRevision: 1, idempotencyKey: "request-001", answers: { pace: "slow" } };

    await expect(repository.command(command)).resolves.toEqual(conflict);
    expect(callFunction).toHaveBeenCalledWith({ name: "trip-api", data: command });
  });

  it("loads a safe AgentRun status through the member-authenticated trip API", async () => {
    const status = {
      agentRunId: "agent-run-1",
      tripId: "trip-1",
      status: "claimed",
      scope: ["submitProposalBatch"],
      revision: 2,
      nextSequence: 1,
      createdAt: "2026-08-28T00:00:00.000Z",
      claimedAt: "2026-08-28T00:01:00.000Z",
      expiresAt: "2026-08-28T00:15:00.000Z",
    };
    const callFunction = vi.fn().mockResolvedValue({ result: status });
    const repository = new CloudBaseDecisionWorkspaceRepository({ callFunction, storage: memoryStorage() });

    await expect(repository.getAgentRunStatus("trip-1", "agent-run-1")).resolves.toEqual(status);
    expect(callFunction).toHaveBeenCalledWith({ name: "trip-api", data: { action: "getAgentRunStatus", tripId: "trip-1", agentRunId: "agent-run-1" } });
  });

  it("reads strictly newer decision events from the supplied cursor", async () => {
    const response = { events: [], cursor: 7 };
    const callFunction = vi.fn().mockResolvedValue({ result: response });
    const repository = new CloudBaseDecisionWorkspaceRepository({ callFunction, storage: memoryStorage() });

    await expect(repository.events("trip-1", 4)).resolves.toEqual(response);
    expect(callFunction).toHaveBeenCalledWith({ name: "trip-api", data: { action: "getDecisionEvents", tripId: "trip-1", afterCursor: 4 } });
  });

  it.each([
    ["negative", -1, 0],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1, 0],
    ["behind afterCursor", 3, 4],
  ])("rejects a %s event response cursor", async (_label, cursor, afterCursor) => {
    const repository = new CloudBaseDecisionWorkspaceRepository({
      callFunction: vi.fn().mockResolvedValue({ result: { events: [], cursor } }),
      storage: memoryStorage(),
    });

    await expect(repository.events("trip-1", afterCursor)).rejects.toBeInstanceOf(RepositoryUnavailableError);
  });

  it("uses a snapshot cached after subscription setup as the first polling cursor", async () => {
    vi.useFakeTimers();
    const afterCursors: number[] = [];
    const loaded = { ...workspace, workspaceCursor: "5" };
    const callFunction = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      if (data.action === "getDecisionWorkspace") return { result: loaded };
      afterCursors.push(data.afterCursor as number);
      return { result: { events: [], cursor: data.afterCursor } };
    });
    const repository = new CloudBaseDecisionWorkspaceRepository({ callFunction, storage: memoryStorage(), pollIntervalMs: 100 });
    const unsubscribe = repository.subscribe("trip-1", vi.fn());

    try {
      await repository.load("trip-1");
      await vi.advanceTimersByTimeAsync(100);
      expect(afterCursors).toEqual([5]);
    } finally {
      unsubscribe();
      vi.useRealTimers();
    }
  });

  it("advances a subscription cursor only after the matching strict refresh succeeds", async () => {
    vi.useFakeTimers();
    const event = {
      tripId: "trip-1",
      sequence: 1,
      resourceType: "preference",
      resourceId: "preference-1",
      revision: 1,
      operation: "upsert",
      occurredAt: "2026-08-28T00:00:01.000Z",
      resource: {
        id: "preference-1",
        tripId: "trip-1",
        revision: 1,
        updatedAt: "2026-08-28T00:00:01.000Z",
        ownerUid: "fs_admin",
        answers: {},
        status: "editing",
        updatedBy: "fs_admin",
      },
    };
    const refreshed = { ...workspace, preferences: [event.resource], workspaceCursor: "1" };
    const afterCursors: number[] = [];
    let refreshAttempts = 0;
    const callFunction = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      if (data.action === "getDecisionEvents") {
        afterCursors.push(data.afterCursor as number);
        return { result: { events: [event], cursor: 1 } };
      }
      refreshAttempts += 1;
      if (refreshAttempts === 1) throw new Error("offline");
      return { result: refreshed };
    });
    const repository = new CloudBaseDecisionWorkspaceRepository({ callFunction, storage: memoryStorage(), pollIntervalMs: 100 });
    const onChange = vi.fn();
    const unsubscribe = repository.subscribe("trip-1", onChange);

    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(onChange).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      expect(afterCursors).toEqual([0, 0]);
      expect(onChange).toHaveBeenCalledWith(refreshed);
      await vi.advanceTimersByTimeAsync(100);
      expect(afterCursors).toEqual([0, 0, 1]);
    } finally {
      unsubscribe();
      vi.useRealTimers();
    }
  });

  it("keeps subscription polls single-flight while an event request is slow", async () => {
    vi.useFakeTimers();
    let resolveEvents!: (value: { result: { events: never[]; cursor: number } }) => void;
    const callFunction = vi.fn(() => new Promise<{ result: { events: never[]; cursor: number } }>((resolve) => { resolveEvents = resolve; }));
    const repository = new CloudBaseDecisionWorkspaceRepository({ callFunction, storage: memoryStorage(), pollIntervalMs: 100 });
    const unsubscribe = repository.subscribe("trip-1", vi.fn());

    try {
      await vi.advanceTimersByTimeAsync(300);
      expect(callFunction).toHaveBeenCalledTimes(1);
      resolveEvents({ result: { events: [], cursor: 0 } });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(100);
      expect(callFunction).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
      vi.useRealTimers();
    }
  });

  it("does not publish a refreshed snapshot after the subscription is cancelled", async () => {
    vi.useFakeTimers();
    let resolveRefresh!: (value: { result: typeof workspace }) => void;
    const event = {
      tripId: "trip-1", sequence: 1, resourceType: "preference", resourceId: "preference-1", revision: 1,
      operation: "upsert", occurredAt: "2026-08-28T00:00:01.000Z",
      resource: { id: "preference-1", tripId: "trip-1", revision: 1, updatedAt: "2026-08-28T00:00:01.000Z", ownerUid: "fs_admin", answers: {}, status: "editing", updatedBy: "fs_admin" },
    };
    const callFunction = vi.fn(({ data }: { data: Record<string, unknown> }) => data.action === "getDecisionEvents"
      ? Promise.resolve({ result: { events: [event], cursor: 1 } })
      : new Promise<{ result: typeof workspace }>((resolve) => { resolveRefresh = resolve; }));
    const repository = new CloudBaseDecisionWorkspaceRepository({ callFunction, storage: memoryStorage(), pollIntervalMs: 100 });
    const onChange = vi.fn();
    const unsubscribe = repository.subscribe("trip-1", onChange);

    await vi.advanceTimersByTimeAsync(100);
    expect(callFunction).toHaveBeenCalledTimes(2);
    unsubscribe();
    resolveRefresh({ result: { ...workspace, workspaceCursor: "1" } });
    await Promise.resolve();
    await Promise.resolve();

    expect(onChange).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("recovers an expired subscription cursor with a strict refresh", async () => {
    vi.useFakeTimers();
    const afterCursors: number[] = [];
    const refreshed = { ...workspace, workspaceCursor: "7" };
    let expired = true;
    const callFunction = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      if (data.action === "getDecisionWorkspace") return { result: refreshed };
      afterCursors.push(data.afterCursor as number);
      if (expired) {
        expired = false;
        return { result: { error: "CURSOR_EXPIRED" } };
      }
      return { result: { events: [], cursor: 7 } };
    });
    const repository = new CloudBaseDecisionWorkspaceRepository({ callFunction, storage: memoryStorage(), pollIntervalMs: 100 });
    const onChange = vi.fn();
    const unsubscribe = repository.subscribe("trip-1", onChange);

    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(onChange).toHaveBeenCalledWith(refreshed);
      await vi.advanceTimersByTimeAsync(100);
      expect(afterCursors).toEqual([0, 7]);
    } finally {
      unsubscribe();
      vi.useRealTimers();
    }
  });

  it("does not publish an expired-cursor recovery after cancellation", async () => {
    vi.useFakeTimers();
    let resolveRefresh!: (value: { result: typeof workspace }) => void;
    const callFunction = vi.fn(({ data }: { data: Record<string, unknown> }) => data.action === "getDecisionEvents"
      ? Promise.resolve({ result: { error: "CURSOR_EXPIRED" } })
      : new Promise<{ result: typeof workspace }>((resolve) => { resolveRefresh = resolve; }));
    const repository = new CloudBaseDecisionWorkspaceRepository({ callFunction, storage: memoryStorage(), pollIntervalMs: 100 });
    const onChange = vi.fn();
    const unsubscribe = repository.subscribe("trip-1", onChange);

    await vi.advanceTimersByTimeAsync(100);
    expect(callFunction).toHaveBeenCalledTimes(2);
    unsubscribe();
    resolveRefresh({ result: { ...workspace, workspaceCursor: "8" } });
    await Promise.resolve();
    await Promise.resolve();

    expect(onChange).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("clears a revoked member cache and stops polling", async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    storage.setItem("travel-decision-workspace:trip-1", JSON.stringify(workspace));
    const callFunction = vi.fn().mockResolvedValue({ result: { error: "MEMBERSHIP_REQUIRED" } });
    const repository = new CloudBaseDecisionWorkspaceRepository({ callFunction, storage, pollIntervalMs: 100 });
    const unsubscribe = repository.subscribe("trip-1", vi.fn());

    try {
      await vi.advanceTimersByTimeAsync(200);
      expect(callFunction).toHaveBeenCalledTimes(1);
      expect(storage.getItem("travel-decision-workspace:trip-1")).toBeNull();
    } finally {
      unsubscribe();
      vi.useRealTimers();
    }
  });
});
