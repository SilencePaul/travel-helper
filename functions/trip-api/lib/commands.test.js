const assert = require("node:assert/strict");
const test = require("node:test");

const { createTripCommands } = require("./commands.js");

function member(uid, role, displayName = uid) {
  return { uid, role, displayName, version: 0, createdAt: "2026-08-27T00:00:00.000Z", tripIds: [], sessionIds: [] };
}

function trip(version = 0) {
  return {
    id: "trip-2026-autumn", title: "秋日旅行", startDate: "2026-10-01", endDate: "2026-10-01",
    travelers: [{ id: "ym", name: "一鸣" }], days: [{ id: "day-1", date: "2026-10-01", city: "香港", itemIds: [] }],
    unscheduledItemIds: [], orders: [], version,
  };
}

function createDb({ members = [], trips = [trip()], authSessions = [] } = {}) {
  const data = {
    members: new Map(members.map((item) => [item.uid, structuredClone(item)])),
    trips: new Map(trips.map((item) => [item.id, structuredClone(item)])),
    auth_sessions: new Map(authSessions.map((item) => [item._id, structuredClone(item)])),
    membership_index: new Map([["admins", { uids: members.filter((item) => item.role === "admin").map((item) => item.uid) }]]),
    audits: [],
    idempotency: new Map(),
  };
  const collection = (name, allowQueries = true) => {
    const store = name === "trip_idempotency" ? data.idempotency : name === "trip_audits" ? undefined : data[name];
    return {
    doc(id) {
      return {
        async get() { const value = store?.get(id); return { data: value ? [structuredClone(value)] : [] }; },
        async set(value) { store?.set(id, structuredClone(value)); },
      };
    },
    where(query) {
      if (!allowQueries) throw new Error("CloudBase transactions do not support where queries");
      return {
        async get() { return { data: [...(store?.values() || [])].filter((value) => Object.entries(query).every(([key, expected]) => value[key] === expected)).map((value) => structuredClone(value)) }; },
        limit() { return this; },
      };
    },
      async add(value) { data.audits.push(structuredClone(value)); },
    };
  };
  return { data, collection, async runTransaction(callback) { return callback({ collection: (name) => collection(name, false) }); } };
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
  const db = createDb({ members: [member("fs_admin", "admin", "一鸣")], trips: [{ ...trip(), memberUids: ["fs_admin"] }] });
  const commands = createTripCommands({ db, now: () => new Date("2026-08-27T12:00:00.000Z") });
  const event = { action: "saveTrip", trip: { ...trip(), title: "更新后的旅行" }, expectedVersion: 0, idempotencyKey: "save-001" };

  const saved = await commands.execute(event, "fs_admin");
  assert.deepEqual(db.data.idempotency.get("save-001"), { actorUid: "fs_admin", tripId: "trip-2026-autumn", expectedVersion: 0, trip: saved.trip, createdAt: "2026-08-27T12:00:00.000Z" });
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

test("saveTrip rejects a stored trip without a server-owned membership list", async () => {
  const db = createDb({ members: [member("fs_admin", "admin")] });
  const commands = createTripCommands({ db });

  await assert.rejects(
    () => commands.execute({ action: "saveTrip", trip: trip(), expectedVersion: 0, idempotencyKey: "missing-members" }, "fs_admin"),
    { code: "INVALID_TRIP" },
  );
  assert.equal(db.data.trips.get("trip-2026-autumn").version, 0);
});

test("saveTrip rejects malformed stored membership instead of claiming the trip", async () => {
  const db = createDb({
    members: [member("fs_admin", "admin")],
    trips: [{ ...trip(), memberUids: ["x"] }],
  });
  const commands = createTripCommands({ db });

  await assert.rejects(
    () => commands.execute({ action: "saveTrip", trip: trip(), expectedVersion: 0, idempotencyKey: "malformed-members" }, "fs_admin"),
    { code: "INVALID_TRIP" },
  );
});

test("a member cannot alter the server-owned trip membership list", async () => {
  const db = createDb({
    members: [member("fs_member", "member")],
    trips: [{ ...trip(), memberUids: ["fs_member"] }],
  });
  const commands = createTripCommands({ db });

  const result = await commands.execute({
    action: "saveTrip",
    trip: { ...trip(), memberUids: ["fs_attacker"], title: "越权加入" },
    expectedVersion: 0,
    idempotencyKey: "member-membership",
  }, "fs_member");

  assert.deepEqual(result.trip.memberUids, ["fs_member"]);
  assert.deepEqual(db.data.trips.get("trip-2026-autumn").memberUids, ["fs_member"]);
});

test("saveTrip validates orders with the TripSchema contract", async () => {
  const db = createDb({ members: [member("fs_admin", "admin")] });
  const commands = createTripCommands({ db });

  await assert.rejects(
    () => commands.execute({
      action: "saveTrip",
      trip: { ...trip(), orders: [{ id: "flight-1", name: "机票" }] },
      expectedVersion: 0,
      idempotencyKey: "invalid-order",
    }, "fs_admin"),
    { code: "INVALID_REQUEST" },
  );
  assert.equal(db.data.trips.get("trip-2026-autumn").version, 0);
});

test("idempotency keys are bound to the original expected version", async () => {
  const db = createDb({ members: [member("fs_admin", "admin")], trips: [{ ...trip(), memberUids: ["fs_admin"] }] });
  const commands = createTripCommands({ db });
  const event = { action: "saveTrip", trip: trip(), expectedVersion: 0, idempotencyKey: "save-bound" };

  await commands.execute(event, "fs_admin");
  await assert.rejects(
    () => commands.execute({ ...event, expectedVersion: 1 }, "fs_admin"),
    { code: "IDEMPOTENCY_KEY_REUSED" },
  );
});

test("idempotency replay treats omitted TripSchema defaults as the same request", async () => {
  const db = createDb({ members: [member("fs_admin", "admin")], trips: [{ ...trip(), memberUids: ["fs_admin"] }] });
  const commands = createTripCommands({ db });
  db.data.idempotency.set("defaults-replay", {
    actorUid: "fs_admin",
    tripId: "trip-2026-autumn",
    expectedVersion: 0,
    trip: { ...trip(1), memberUids: ["fs_admin"], orders: undefined },
    createdAt: "2026-08-27T12:00:00.000Z",
  });
  const event = { action: "saveTrip", trip: trip(), expectedVersion: 0, idempotencyKey: "defaults-replay" };

  assert.deepEqual(await commands.execute(event, "fs_admin"), { trip: { ...trip(1), memberUids: ["fs_admin"], orders: undefined } });
});

test("removeMember revokes trip membership and sessions in the same transaction", async () => {
  const db = createDb({
    members: [member("fs_admin", "admin"), member("fs_member", "member")],
    trips: [
      { ...trip(), memberUids: ["fs_admin", "fs_member"] },
      { ...trip(), id: "other-trip", memberUids: ["fs_member"] },
    ],
    authSessions: [
      { _id: "session-1", uid: "fs_member", oauthState: "state-1", expiresAt: 9999999999999, revoked: false },
      { _id: "session-2", uid: "fs_other", oauthState: "state-2", expiresAt: 9999999999999, revoked: false },
    ],
  });
  db.data.members.get("fs_member").tripIds = ["trip-2026-autumn", "other-trip"];
  db.data.members.get("fs_member").sessionIds = ["session-1"];
  const commands = createTripCommands({ db, now: () => new Date("2026-08-27T12:00:00.000Z") });

  await commands.execute({ action: "removeMember", uid: "fs_member" }, "fs_admin");

  assert.deepEqual(db.data.trips.get("trip-2026-autumn").memberUids, ["fs_admin"]);
  assert.deepEqual(db.data.trips.get("other-trip").memberUids, []);
  assert.equal(db.data.auth_sessions.get("session-1").revoked, true);
  assert.equal(db.data.auth_sessions.get("session-1").expiresAt, Date.parse("2026-08-27T12:00:00.000Z"));
  assert.equal(db.data.auth_sessions.get("session-2").revoked, false);
});

test("removeMember fails closed when server-owned associations are missing", async () => {
  const db = createDb({
    members: [member("fs_admin", "admin"), { ...member("fs_member", "member"), tripIds: undefined }],
    trips: [{ ...trip(), memberUids: ["fs_admin", "fs_member"] }],
  });
  const commands = createTripCommands({ db });

  await assert.rejects(() => commands.execute({ action: "removeMember", uid: "fs_member" }, "fs_admin"), { code: "MEMBERSHIP_ASSOCIATIONS_UNAVAILABLE" });
  assert.equal(db.data.members.get("fs_member").role, "member");
  assert.deepEqual(db.data.trips.get("trip-2026-autumn").memberUids, ["fs_admin", "fs_member"]);
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
