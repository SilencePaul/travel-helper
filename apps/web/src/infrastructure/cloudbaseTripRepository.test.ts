import { describe, expect, it, vi } from "vitest";
import type { Trip } from "@travel/contracts";
import seed from "../../../../content/trip.seed.json";
import { CloudBaseTripRepository, ForbiddenError, UnauthorizedError, VersionConflictError } from "./cloudbaseTripRepository";

function makeTrip(version: number): Trip {
  return { ...structuredClone(seed), orders: [], version };
}

function fakeCloudbase() {
  const get = vi.fn();
  const watch = vi.fn();
  const close = vi.fn();
  const callFunction = vi.fn();
  const doc = vi.fn(() => ({ get, watch }));
  return { db: { collection: vi.fn(() => ({ doc })) }, functions: { callFunction }, get, watch, close, callFunction };
}

describe("CloudBaseTripRepository", () => {
  it("loads a trip and sends versioned saves with an idempotency key", async () => {
    const cloud = fakeCloudbase();
    const trip = makeTrip(2);
    cloud.get.mockResolvedValue({ data: [trip] });
    cloud.callFunction.mockResolvedValue({ result: { trip: makeTrip(3) } });
    const repository = new CloudBaseTripRepository({ database: cloud.db, functions: cloud });

    await expect(repository.load(trip.id)).resolves.toEqual(trip);
    await repository.save({ ...trip, title: "更新" }, 2);

    expect(cloud.callFunction).toHaveBeenCalledWith(expect.objectContaining({
      name: "trip-api",
      data: expect.objectContaining({ action: "saveTrip", tripId: trip.id, expectedVersion: 2, idempotencyKey: expect.any(String) }),
    }));
  });

  it("maps only stable service errors", async () => {
    const cloud = fakeCloudbase();
    cloud.callFunction.mockResolvedValue({ result: { error: "VERSION_CONFLICT" } });
    const repository = new CloudBaseTripRepository({ database: cloud.db, functions: cloud });
    await expect(repository.save(makeTrip(1), 0)).rejects.toBeInstanceOf(VersionConflictError);

    cloud.callFunction.mockRejectedValue(Object.assign(new Error("provider leaked detail"), { code: "FORBIDDEN" }));
    await expect(repository.save(makeTrip(1), 0)).rejects.toBeInstanceOf(ForbiddenError);
    cloud.callFunction.mockRejectedValue(new Error("provider leaked detail"));
    await expect(repository.save(makeTrip(1), 0)).rejects.toMatchObject({ code: "REPOSITORY_UNAVAILABLE" });
    expect(() => { throw new ForbiddenError(); }).toThrow();
  });

  it("exposes authorization loss as a stable repository error", async () => {
    const cloud = fakeCloudbase();
    cloud.get.mockRejectedValue(Object.assign(new Error("provider detail"), { code: "PERMISSION_DENIED" }));
    const repository = new CloudBaseTripRepository({ database: cloud.db, functions: cloud });
    await expect(repository.load(makeTrip(0).id)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("owns one watcher and ignores stale or duplicate snapshots", () => {
    const cloud = fakeCloudbase();
    let callbacks!: { onChange: (snapshot: unknown) => void; onError: (error: unknown) => void };
    cloud.watch.mockImplementation((options) => { callbacks = options; return { close: cloud.close }; });
    const repository = new CloudBaseTripRepository({ database: cloud.db, functions: cloud });
    const changes: Trip[] = [];
    const unsubscribe = repository.subscribe(makeTrip(0).id, (change) => changes.push(change.trip));
    callbacks.onChange({ type: "init", docs: [makeTrip(2)], docChanges: [] });
    callbacks.onChange({ docs: [makeTrip(1)], docChanges: [] });
    callbacks.onChange({ docs: [makeTrip(2)], docChanges: [] });
    callbacks.onChange({ docs: [makeTrip(3)], docChanges: [] });
    callbacks.onChange({ docs: [], docChanges: [{ dataType: "remove", doc: makeTrip(4) }] });
    expect(changes.map((trip) => trip.version)).toEqual([2, 3]);
    unsubscribe();
    expect(cloud.close).toHaveBeenCalledTimes(1);
  });

  it("ignores watcher snapshots older than a load that completed after subscription", async () => {
    const cloud = fakeCloudbase();
    let callbacks!: { onChange: (snapshot: unknown) => void; onError: (error: unknown) => void };
    cloud.watch.mockImplementation((options) => { callbacks = options; return { close: cloud.close }; });
    cloud.get.mockResolvedValue({ data: [makeTrip(2)] });
    const repository = new CloudBaseTripRepository({ database: cloud.db, functions: cloud });
    const changes: Trip[] = [];
    repository.subscribe(makeTrip(0).id, (change) => changes.push(change.trip));

    await expect(repository.load(makeTrip(0).id)).resolves.toMatchObject({ version: 2 });
    callbacks.onChange({ docs: [makeTrip(1)], docChanges: [] });

    expect(changes).toEqual([]);
  });
});
