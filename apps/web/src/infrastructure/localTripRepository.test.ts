import { expect, test, vi } from "vitest";
import { LocalTripRepository } from "./localTripRepository";
import seed from "../../../../content/trip.seed.json";

test("rejects stale writes", async () => {
  const repository = new LocalTripRepository(seed);
  const trip = await repository.load(seed.id);

  await repository.save({ ...trip, title: "first" }, trip.version);

  await expect(repository.save({ ...trip, title: "stale" }, trip.version)).rejects.toThrow(
    "VERSION_CONFLICT",
  );
});

test("returns a clone from load", async () => {
  const repository = new LocalTripRepository(seed);
  const trip = await repository.load(seed.id);
  trip.title = "mutated";
  trip.days[0]!.city = "mutated";

  const reloaded = await repository.load(seed.id);
  expect(reloaded.title).toBe(seed.title);
  expect(reloaded.days[0]!.city).toBe(seed.days[0]!.city);
});

test("increments the version and notifies subscribers once after a save", async () => {
  const repository = new LocalTripRepository(seed);
  const changes: unknown[] = [];
  repository.subscribe(seed.id, (change) => changes.push(change));
  const trip = await repository.load(seed.id);

  const saved = await repository.save({ ...trip, title: "updated" }, trip.version);

  expect(saved.version).toBe(trip.version + 1);
  expect(changes).toHaveLength(1);
  expect(changes[0]).toMatchObject({
    trip: saved,
    actorName: "本地用户",
  });
  expect(new Date((changes[0] as { changedAt: string }).changedAt).toISOString()).toBe(
    (changes[0] as { changedAt: string }).changedAt,
  );
});

test("stops notifications after unsubscribe", async () => {
  const repository = new LocalTripRepository(seed);
  const listener = () => {
    throw new Error("listener should have been removed");
  };
  const unsubscribe = repository.subscribe(seed.id, listener);
  unsubscribe();
  unsubscribe();
  const trip = await repository.load(seed.id);

  await expect(repository.save({ ...trip, title: "updated" }, trip.version)).resolves.toMatchObject({
    version: 1,
  });
});

test("rejects invalid seeds with TripSchema", () => {
  expect(() => new LocalTripRepository({ ...seed, title: "" })).toThrow();
});

test("validates saved trips with TripSchema", async () => {
  const repository = new LocalTripRepository(seed);
  const trip = await repository.load(seed.id);

  await expect(repository.save({ ...trip, title: "" }, trip.version)).rejects.toThrow();
  await expect(repository.load(seed.id)).resolves.toMatchObject({ title: seed.title, version: 0 });
});

test("rejects operations for another trip", async () => {
  const repository = new LocalTripRepository(seed);

  await expect(repository.load("other-trip")).rejects.toThrow("TRIP_NOT_FOUND");
  expect(() => repository.subscribe("other-trip", () => undefined)).toThrow("TRIP_NOT_FOUND");
  const trip = await repository.load(seed.id);
  await expect(repository.save({ ...trip, id: "other-trip" }, trip.version)).rejects.toThrow(
    "TRIP_NOT_FOUND",
  );
});

test("returns the outer snapshot and notifies reentrant saves in version order", async () => {
  const repository = new LocalTripRepository(seed);
  const observed: Array<{ title: string; version: number; changedAt: string }> = [];
  let nestedSave: Promise<unknown> | undefined;

  repository.subscribe(seed.id, (change) => {
    if (change.trip.version === 1) {
      nestedSave = repository.save({ ...change.trip, title: "second" }, change.trip.version);
    }
  });
  repository.subscribe(seed.id, (change) => {
    observed.push({
      title: change.trip.title,
      version: change.trip.version,
      changedAt: change.changedAt,
    });
  });
  const trip = await repository.load(seed.id);

  const outerSave = await repository.save({ ...trip, title: "first" }, trip.version);
  await nestedSave;

  expect(outerSave).toMatchObject({ title: "first", version: 1 });
  expect(observed).toMatchObject([
    { title: "first", version: 1 },
    { title: "second", version: 2 },
  ]);
  expect(new Date(observed[0]!.changedAt).toISOString()).toBe(observed[0]!.changedAt);
  expect(new Date(observed[1]!.changedAt).toISOString()).toBe(observed[1]!.changedAt);
});

test("isolates throwing listeners without skipping later listeners", async () => {
  const repository = new LocalTripRepository(seed);
  const reportError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const received: number[] = [];
  repository.subscribe(seed.id, () => {
    throw new Error("listener failure");
  });
  repository.subscribe(seed.id, (change) => received.push(change.trip.version));
  const trip = await repository.load(seed.id);

  try {
    await expect(repository.save({ ...trip, title: "updated" }, trip.version)).resolves.toMatchObject({
      version: 1,
    });

    expect(received).toEqual([1]);
    expect(reportError).toHaveBeenCalledOnce();
  } finally {
    reportError.mockRestore();
  }
});

test("isolates listener payload mutations", async () => {
  const repository = new LocalTripRepository(seed);
  const observedTitles: string[] = [];
  repository.subscribe(seed.id, (change) => {
    change.trip.title = "mutated";
  });
  repository.subscribe(seed.id, (change) => observedTitles.push(change.trip.title));
  const trip = await repository.load(seed.id);

  const saved = await repository.save({ ...trip, title: "updated" }, trip.version);

  expect(saved.title).toBe("updated");
  expect(observedTitles).toEqual(["updated"]);
  await expect(repository.load(seed.id)).resolves.toMatchObject({ title: "updated" });
});
