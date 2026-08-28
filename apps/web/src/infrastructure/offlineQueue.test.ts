import "fake-indexeddb/auto";
import { TripSchema } from "@travel/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import seed from "../../../../content/trip.seed.json";
import {
  clearOfflineData,
  getTripSnapshot,
  getUnassignedOfflineRecordCount,
  openOfflineDatabase,
  saveTripSnapshot,
} from "./offlineStore";
import {
  enqueuePendingCommand,
  listPendingCommands,
  replayPendingCommands,
} from "./offlineQueue";

const actorUid = "fs_actor";
const validatedSeed = TripSchema.parse(seed);

beforeEach(async () => {
  await clearOfflineData();
});

describe("offline snapshot and command storage", () => {
  it("isolates snapshots and pending edits by authenticated member", async () => {
    const command = {
      actorUid: "fs_first",
      tripId: seed.id,
      expectedVersion: 0,
      patch: { ...structuredClone(seed), title: "第一位成员的离线修改", version: 1 },
      createdAt: "2026-08-27T09:00:00.000Z",
      idempotencyKey: "actor-scoped-command",
    };
    await enqueuePendingCommand(command);
    await saveTripSnapshot("fs_first", validatedSeed);

    await expect(listPendingCommands("fs_second", seed.id)).resolves.toEqual([]);
    await expect(listPendingCommands("fs_first", seed.id)).resolves.toEqual([command]);
    await expect(getTripSnapshot("fs_second", seed.id)).resolves.toBeUndefined();
    await expect(getTripSnapshot("fs_first", seed.id)).resolves.toMatchObject(seed);

    const send = vi.fn();
    await expect(replayPendingCommands(send, "fs_second", seed.id)).resolves.toMatchObject({ status: "completed", replayed: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it("quarantines legacy offline records without replaying or silently deleting them", async () => {
    const database = await openOfflineDatabase();
    const legacyCommand = {
      tripId: seed.id,
      expectedVersion: 0,
      patch: { ...structuredClone(seed), title: "旧版未同步修改", version: 1 },
      createdAt: "2026-08-27T09:00:00.000Z",
      idempotencyKey: "legacy-command",
    };
    await database.put("pendingCommands", legacyCommand, legacyCommand.idempotencyKey);
    await database.put("tripSnapshots", structuredClone(validatedSeed), seed.id);

    await expect(listPendingCommands(actorUid, seed.id)).resolves.toEqual([]);
    await expect(getTripSnapshot(actorUid, seed.id)).resolves.toBeUndefined();
    await expect(getUnassignedOfflineRecordCount()).resolves.toBe(2);
    await expect(database.get("pendingCommands", legacyCommand.idempotencyKey)).resolves.toBeUndefined();
  });

  it("stores only a validated trip snapshot", async () => {
    await expect(saveTripSnapshot(actorUid, validatedSeed)).resolves.toMatchObject({ id: seed.id, version: 0 });
    const stored = await getTripSnapshot(actorUid, seed.id);
    expect(stored).toMatchObject(seed);

    await expect(saveTripSnapshot(actorUid, { ...seed, title: "" })).rejects.toThrow();
    await expect(getTripSnapshot(actorUid, seed.id)).resolves.toMatchObject(seed);
  });

  it("deduplicates commands by idempotency key", async () => {
    const command = {
      actorUid,
      tripId: seed.id,
      expectedVersion: 0,
      patch: { ...structuredClone(seed), title: "离线修改", version: 1 },
      createdAt: "2026-08-27T09:00:00.000Z",
      idempotencyKey: "cmd-1",
    };
    await enqueuePendingCommand(command);
    await enqueuePendingCommand({ ...command, patch: { ...structuredClone(seed), title: "重复提交", version: 1 } });

    await expect(listPendingCommands(actorUid, seed.id)).resolves.toEqual([command]);
  });

  it("rejects secret-bearing command payloads", async () => {
    await expect(enqueuePendingCommand({
      actorUid,
      tripId: seed.id,
      expectedVersion: 0,
      patch: { ...structuredClone(seed), title: "safe", accessToken: "should-not-persist", version: 1 },
      createdAt: "2026-08-27T09:00:00.000Z",
      idempotencyKey: "cmd-secret",
    })).rejects.toThrow(/secret/i);
  });

  it("rejects partial or malformed nested trip saves", async () => {
    await expect(enqueuePendingCommand({
      actorUid,
      tripId: seed.id,
      expectedVersion: 0,
      patch: { title: "partial" },
      createdAt: "2026-08-27T09:00:00.000Z",
      idempotencyKey: "cmd-partial",
    })).rejects.toThrow();

    await expect(enqueuePendingCommand({
      actorUid,
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
      actorUid,
      tripId: seed.id,
      expectedVersion: 0,
      patch: { title: "partial" },
      createdAt: "2026-08-27T09:00:00.000Z",
      idempotencyKey: "cmd-hostile-partial",
    }, "cmd-hostile-partial");
    await database.put("pendingCommands", {
      actorUid,
      tripId: seed.id,
      expectedVersion: 0,
      patch: { ...structuredClone(seed), days: [{ id: "day", date: 42, city: "x", itemIds: [] }], version: 1 },
      createdAt: "2026-08-27T09:00:00.000Z",
      idempotencyKey: "cmd-hostile-nested",
    }, "cmd-hostile-nested");

    await expect(listPendingCommands(actorUid, seed.id)).resolves.toEqual([]);
    await expect(database.get("pendingCommands", "cmd-hostile-partial")).resolves.toBeUndefined();
    await expect(database.get("pendingCommands", "cmd-hostile-nested")).resolves.toBeUndefined();
  });
});

describe("offline command replay", () => {
  it("replays commands in creation order and removes acknowledged commands", async () => {
    await enqueuePendingCommand({ actorUid, tripId: seed.id, expectedVersion: 0, patch: { ...structuredClone(seed), title: "first", version: 1 }, createdAt: "2026-08-27T09:00:01.000Z", idempotencyKey: "cmd-2" });
    await enqueuePendingCommand({ actorUid, tripId: seed.id, expectedVersion: 1, patch: { ...structuredClone(seed), title: "second", version: 2 }, createdAt: "2026-08-27T09:00:02.000Z", idempotencyKey: "cmd-3" });
    const sent: string[] = [];

    await expect(replayPendingCommands(async (command) => {
      sent.push(command.idempotencyKey);
      return { trip: { ...seed, version: command.expectedVersion + 1 } };
    }, actorUid)).resolves.toMatchObject({ status: "completed", replayed: 2 });

    expect(sent).toEqual(["cmd-2", "cmd-3"]);
    await expect(listPendingCommands(actorUid, seed.id)).resolves.toEqual([]);
  });

  it("pauses at a version conflict and leaves that command and later work queued", async () => {
    await enqueuePendingCommand({ actorUid, tripId: seed.id, expectedVersion: 0, patch: { ...structuredClone(seed), title: "conflict", version: 1 }, createdAt: "2026-08-27T09:00:01.000Z", idempotencyKey: "cmd-conflict" });
    await enqueuePendingCommand({ actorUid, tripId: seed.id, expectedVersion: 1, patch: { ...structuredClone(seed), title: "must-wait", version: 2 }, createdAt: "2026-08-27T09:00:02.000Z", idempotencyKey: "cmd-after" });
    const send = vi.fn().mockRejectedValue(Object.assign(new Error("stale"), { code: "VERSION_CONFLICT" }));

    await expect(replayPendingCommands(send, actorUid)).resolves.toMatchObject({ status: "paused-conflict", replayed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    await expect(listPendingCommands(actorUid, seed.id)).resolves.toHaveLength(2);
  });

  it("does not remove a command until the sender acknowledges it", async () => {
    const command = { actorUid, tripId: seed.id, expectedVersion: 0, patch: { ...structuredClone(seed), title: "retry", version: 1 }, createdAt: "2026-08-27T09:00:01.000Z", idempotencyKey: "cmd-retry" };
    await enqueuePendingCommand(command);
    const send = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ ok: true });

    await expect(replayPendingCommands(send, actorUid)).resolves.toMatchObject({ status: "failed", replayed: 0 });
    await expect(listPendingCommands(actorUid, seed.id)).resolves.toEqual([command]);
    await expect(replayPendingCommands(send, actorUid)).resolves.toMatchObject({ status: "completed", replayed: 1 });
    await expect(listPendingCommands(actorUid, seed.id)).resolves.toEqual([]);
  });
});
