import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import seed from "../../../../content/trip.seed.json";
import {
  clearOfflineData,
  getTripSnapshot,
  openOfflineDatabase,
  saveTripSnapshot,
} from "./offlineStore";
import {
  enqueuePendingCommand,
  listPendingCommands,
  replayPendingCommands,
} from "./offlineQueue";

beforeEach(async () => {
  await clearOfflineData();
});

describe("offline snapshot and command storage", () => {
  it("stores only a validated trip snapshot", async () => {
    await expect(saveTripSnapshot(seed)).resolves.toMatchObject({ id: seed.id, version: 0 });
    const stored = await getTripSnapshot(seed.id);
    expect(stored).toMatchObject(seed);

    await expect(saveTripSnapshot({ ...seed, title: "" })).rejects.toThrow();
    await expect(getTripSnapshot(seed.id)).resolves.toMatchObject(seed);
  });

  it("deduplicates commands by idempotency key", async () => {
    const command = {
      tripId: seed.id,
      expectedVersion: 0,
      patch: { ...structuredClone(seed), title: "离线修改", version: 1 },
      createdAt: "2026-08-27T09:00:00.000Z",
      idempotencyKey: "cmd-1",
    };
    await enqueuePendingCommand(command);
    await enqueuePendingCommand({ ...command, patch: { ...structuredClone(seed), title: "重复提交", version: 1 } });

    await expect(listPendingCommands(seed.id)).resolves.toEqual([command]);
  });

  it("rejects secret-bearing command payloads", async () => {
    await expect(enqueuePendingCommand({
      tripId: seed.id,
      expectedVersion: 0,
      patch: { ...structuredClone(seed), title: "safe", accessToken: "should-not-persist", version: 1 },
      createdAt: "2026-08-27T09:00:00.000Z",
      idempotencyKey: "cmd-secret",
    })).rejects.toThrow(/secret/i);
  });

  it("rejects partial or malformed nested trip saves", async () => {
    await expect(enqueuePendingCommand({
      tripId: seed.id,
      expectedVersion: 0,
      patch: { title: "partial" },
      createdAt: "2026-08-27T09:00:00.000Z",
      idempotencyKey: "cmd-partial",
    })).rejects.toThrow();

    await expect(enqueuePendingCommand({
      tripId: seed.id,
      expectedVersion: 0,
      patch: { ...structuredClone(seed), days: [{ ...seed.days[0], itemIds: "not-an-array" }], version: 1 },
      createdAt: "2026-08-27T09:00:00.000Z",
      idempotencyKey: "cmd-nested",
    })).rejects.toThrow();
  });

  it("discards hostile commands already persisted in IndexedDB", async () => {
    const database = await openOfflineDatabase();
    await database.put("pendingCommands", {
      tripId: seed.id,
      expectedVersion: 0,
      patch: { title: "partial" },
      createdAt: "2026-08-27T09:00:00.000Z",
      idempotencyKey: "cmd-hostile-partial",
    }, "cmd-hostile-partial");
    await database.put("pendingCommands", {
      tripId: seed.id,
      expectedVersion: 0,
      patch: { ...structuredClone(seed), days: [{ id: "day", date: 42, city: "x", itemIds: [] }], version: 1 },
      createdAt: "2026-08-27T09:00:00.000Z",
      idempotencyKey: "cmd-hostile-nested",
    }, "cmd-hostile-nested");

    await expect(listPendingCommands(seed.id)).resolves.toEqual([]);
    await expect(database.get("pendingCommands", "cmd-hostile-partial")).resolves.toBeUndefined();
    await expect(database.get("pendingCommands", "cmd-hostile-nested")).resolves.toBeUndefined();
  });
});

describe("offline command replay", () => {
  it("replays commands in creation order and removes acknowledged commands", async () => {
    await enqueuePendingCommand({ tripId: seed.id, expectedVersion: 0, patch: { ...structuredClone(seed), title: "first", version: 1 }, createdAt: "2026-08-27T09:00:01.000Z", idempotencyKey: "cmd-2" });
    await enqueuePendingCommand({ tripId: seed.id, expectedVersion: 1, patch: { ...structuredClone(seed), title: "second", version: 2 }, createdAt: "2026-08-27T09:00:02.000Z", idempotencyKey: "cmd-3" });
    const sent: string[] = [];

    await expect(replayPendingCommands(async (command) => {
      sent.push(command.idempotencyKey);
      return { trip: { ...seed, version: command.expectedVersion + 1 } };
    })).resolves.toMatchObject({ status: "completed", replayed: 2 });

    expect(sent).toEqual(["cmd-2", "cmd-3"]);
    await expect(listPendingCommands(seed.id)).resolves.toEqual([]);
  });

  it("pauses at a version conflict and leaves that command and later work queued", async () => {
    await enqueuePendingCommand({ tripId: seed.id, expectedVersion: 0, patch: { ...structuredClone(seed), title: "conflict", version: 1 }, createdAt: "2026-08-27T09:00:01.000Z", idempotencyKey: "cmd-conflict" });
    await enqueuePendingCommand({ tripId: seed.id, expectedVersion: 1, patch: { ...structuredClone(seed), title: "must-wait", version: 2 }, createdAt: "2026-08-27T09:00:02.000Z", idempotencyKey: "cmd-after" });
    const send = vi.fn().mockRejectedValue(Object.assign(new Error("stale"), { code: "VERSION_CONFLICT" }));

    await expect(replayPendingCommands(send)).resolves.toMatchObject({ status: "paused-conflict", replayed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    await expect(listPendingCommands(seed.id)).resolves.toHaveLength(2);
  });

  it("does not remove a command until the sender acknowledges it", async () => {
    const command = { tripId: seed.id, expectedVersion: 0, patch: { ...structuredClone(seed), title: "retry", version: 1 }, createdAt: "2026-08-27T09:00:01.000Z", idempotencyKey: "cmd-retry" };
    await enqueuePendingCommand(command);
    const send = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ ok: true });

    await expect(replayPendingCommands(send)).resolves.toMatchObject({ status: "failed", replayed: 0 });
    await expect(listPendingCommands(seed.id)).resolves.toEqual([command]);
    await expect(replayPendingCommands(send)).resolves.toMatchObject({ status: "completed", replayed: 1 });
    await expect(listPendingCommands(seed.id)).resolves.toEqual([]);
  });
});
