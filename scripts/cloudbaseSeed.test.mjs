import assert from "node:assert/strict";
import test from "node:test";
import { cloudBaseCollectionNames, seedCloudBase } from "./cloudbaseSeed.mjs";

function createDb(initial = {}) {
  const data = new Map(Object.entries(initial).map(([name, values]) => [name, new Map(Object.entries(values))]));
  const collection = (name) => ({
    doc(id) {
      const records = data.get(name) ?? new Map();
      data.set(name, records);
      return {
        async get() { const value = records.get(id); return { data: value ? [structuredClone(value)] : [] }; },
        async set(value) { records.set(id, structuredClone(value)); },
      };
    },
  });
  return { data, async runTransaction(callback) { return callback({ collection }); } };
}

test("seeds an unclaimed trip and bootstrap indexes exactly once", async () => {
  const db = createDb();
  const trip = { id: "trip-2026-gba", title: "旅行", version: 0 };

  await seedCloudBase({ db, trip, bootstrapCode: "correct" });
  await seedCloudBase({ db, trip: { ...trip, title: "不覆盖" }, bootstrapCode: "different" });

  assert.deepEqual(db.data.get("trips").get(trip.id), { ...trip, memberUids: [] });
  assert.deepEqual(db.data.get("membership_index").get("admins"), { adminUids: [] });
  assert.deepEqual(db.data.get("membership_index").get("members"), { memberUids: [] });
  assert.equal(db.data.get("auth_bootstrap").get("singleton").consumed, false);
});

test("declares every authentication exchange collection needed before bootstrap", () => {
  assert.equal(cloudBaseCollectionNames.includes("auth_exchange_codes"), true);
});
