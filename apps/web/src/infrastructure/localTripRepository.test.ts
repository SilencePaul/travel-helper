import { expect, test } from "vitest";
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
