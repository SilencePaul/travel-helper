const assert = require("node:assert/strict");
const test = require("node:test");

const { createTripCommands } = require("./commands.js");

function member(uid, role, displayName = uid) {
  return { uid, role, displayName, version: 0, createdAt: "2026-08-27T00:00:00.000Z" };
}

function trip(version = 0) {
  return {
    id: "trip-2026-autumn", title: "秋日旅行", startDate: "2026-10-01", endDate: "2026-10-01",
    travelers: [{ id: "ym", name: "一鸣" }], days: [{ id: "day-1", date: "2026-10-01", city: "香港", itemIds: [] }],
    unscheduledItemIds: [], orders: [], version,
  };
}

function createDb({ members = [], trips = [trip()] } = {}) {
  const data = {
    members: new Map(members.map((item) => [item.uid, structuredClone(item)])),
    trips: new Map(trips.map((item) => [item.id, structuredClone(item)])),
    audits: [],
    idempotency: new Map(),
  };
  const collection = (name) => {
    const store = name === "trip_idempotency" ? data.idempotency : name === "trip_audits" ? undefined : data[name];
    return {
    doc(id) {
      return {
        async get() { const value = store?.get(id); return { data: value ? [structuredClone(value)] : [] }; },
        async set(value) { store?.set(id, structuredClone(value)); },
      };
    },
    where(query) {
      return {
        async get() { return { data: [...(store?.values() || [])].filter((value) => Object.entries(query).every(([key, expected]) => value[key] === expected)).map((value) => structuredClone(value)) }; },
        limit() { return this; },
      };
    },
      async add(value) { data.audits.push(structuredClone(value)); },
    };
  };
  return { data, collection, async runTransaction(callback) { return callback({ collection }); } };
}

test("only an administrator can approve a pending member", async () => {
  const db = createDb({ members: [member("fs_admin", "admin", "一鸣"), member("fs_pending", "pending", "美垚")] });
  const commands = createTripCommands({ db, now: () => new Date("2026-08-27T12:00:00.000Z") });

  await assert.rejects(() => commands.execute({ action: "approveMember", uid: "fs_pending" }, "fs_pending"), { code: "MEMBERSHIP_REQUIRED" });
  const result = await commands.execute({ action: "approveMember", uid: "fs_pending" }, "fs_admin");

  assert.deepEqual(result.member, expectMember("fs_pending", "member", "美垚"));
  assert.equal(db.data.members.get("fs_pending").role, "member");
  assert.equal(db.data.audits[0].action, "approveMember");
  assert.equal("openId" in db.data.audits[0], false);
});

test("removing the final administrator is rejected", async () => {
  const db = createDb({ members: [member("fs_admin", "admin", "一鸣")] });
  const commands = createTripCommands({ db });

  await assert.rejects(() => commands.execute({ action: "removeMember", uid: "fs_admin" }, "fs_admin"), { code: "LAST_ADMIN" });
});

test("saveTrip writes once per idempotency key and rejects stale versions", async () => {
  const db = createDb({ members: [member("fs_admin", "admin", "一鸣")] });
  const commands = createTripCommands({ db, now: () => new Date("2026-08-27T12:00:00.000Z") });
  const event = { action: "saveTrip", trip: { ...trip(), title: "更新后的旅行" }, expectedVersion: 0, idempotencyKey: "save-001" };

  const saved = await commands.execute(event, "fs_admin");
  assert.deepEqual(db.data.idempotency.get("save-001"), { actorUid: "fs_admin", tripId: "trip-2026-autumn", trip: saved.trip, createdAt: "2026-08-27T12:00:00.000Z" });
  const replay = await commands.execute(event, "fs_admin");

  assert.equal(saved.trip.version, 1);
  assert.deepEqual(replay, saved);
  assert.equal(db.data.trips.get("trip-2026-autumn").version, 1);
  await assert.rejects(() => commands.execute({ ...event, idempotencyKey: "save-002" }, "fs_admin"), { code: "VERSION_CONFLICT" });
});

test("saveTrip requires the actor to belong to the trip", async () => {
  const db = createDb({
    members: [member("fs_member", "member")],
    trips: [{ ...trip(), memberUids: ["fs_other"] }],
  });
  const commands = createTripCommands({ db });

  await assert.rejects(
    () => commands.execute({ action: "saveTrip", trip: { ...trip(), memberUids: ["fs_other"], title: "越权" }, expectedVersion: 0, idempotencyKey: "write-unauthorized" }, "fs_member"),
    { code: "FORBIDDEN" },
  );
  assert.equal(db.data.trips.get("trip-2026-autumn").title, "秋日旅行");
});

test("audit records include actor UID and safe changed fields only", async () => {
  const db = createDb({ members: [member("fs_admin", "admin", "一鸣"), member("fs_pending", "pending", "美垚")] });
  const commands = createTripCommands({ db, now: () => new Date("2026-08-27T12:00:00.000Z") });

  await commands.execute({ action: "approveMember", uid: "fs_pending" }, "fs_admin");

  assert.deepEqual(db.data.audits[0], {
    actorUid: "fs_admin",
    actorName: "一鸣",
    action: "approveMember",
    targetName: "美垚",
    changedFields: ["role", "version", "approvedAt"],
    createdAt: "2026-08-27T12:00:00.000Z",
  });
  assert.equal("openId" in db.data.audits[0], false);
  assert.equal("openIdHash" in db.data.audits[0], false);
});

function expectMember(uid, role, displayName) {
  return { uid, role, displayName, version: 1, createdAt: "2026-08-27T00:00:00.000Z", approvedAt: "2026-08-27T12:00:00.000Z" };
}
