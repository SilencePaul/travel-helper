const assert = require("node:assert/strict");
const test = require("node:test");

const { createCloudBaseAuthStore } = require("./authStore.js");
const { createCloudBaseMemberStore, sha256, uidForOpenId } = require("./members.js");

function createDb(initial = {}) {
  const data = new Map(Object.entries(initial).map(([name, records]) => [name, new Map(Object.entries(records))]));
  let mutation = Promise.resolve();
  let transactionCalls = 0;
  const collection = (name, allowQueries = true) => ({
    doc(id) {
      const store = data.get(name) || new Map();
      data.set(name, store);
      return {
        async get() { const value = store.get(id); return { data: value ? [structuredClone(value)] : [] }; },
        async set(value) { store.set(id, structuredClone(value)); },
      };
    },
    where() {
      if (!allowQueries) throw new Error("CloudBase transactions do not support where queries");
      return { limit() { return this; }, async get() { return { data: [] }; } };
    },
    async add() {},
  });
  return {
    data,
    get transactionCalls() { return transactionCalls; },
    collection,
    async runTransaction(callback) {
      transactionCalls += 1;
      const result = mutation.then(() => callback({ collection: (name) => collection(name, false) }));
      mutation = result.catch(() => undefined);
      return result;
    },
  };
}

test("CloudBase bootstrap uses direct membership index reads without transaction queries", async () => {
  const db = createDb({
    auth_bootstrap: { singleton: { codeHash: sha256("correct"), consumed: false } },
    membership_index: { admins: { adminUids: [] }, members: { memberUids: [] } },
    trips: { "trip-2026-gba": { id: "trip-2026-gba", memberUids: [], version: 0 } },
  });
  const store = createCloudBaseMemberStore({ db, bootstrapCode: "correct", bootstrapTripId: "trip-2026-gba", now: () => new Date("2026-08-27T12:00:00.000Z") });

  const identity = { openId: "ou_admin", displayName: "一鸣" };
  await store.upsertPending(identity);
  const admin = await store.consumeBootstrap({ identity, code: "correct" });

  assert.equal(admin.role, "admin");
  assert.deepEqual(db.data.get("membership_index").get("admins").adminUids, [uidForOpenId("ou_admin")]);
  assert.deepEqual(db.data.get("members").get(uidForOpenId("ou_admin")).tripIds, ["trip-2026-gba"]);
  assert.deepEqual(db.data.get("trips").get("trip-2026-gba").memberUids, [uidForOpenId("ou_admin")]);
});

test("CloudBase bootstrap fails closed when the administrator index is missing or stale", async () => {
  const uid = uidForOpenId("ou_admin");
  for (const membershipIndex of [undefined, { admins: { adminUids: ["fs_missing"] } }]) {
    const db = createDb({
      auth_bootstrap: { singleton: { codeHash: sha256("correct"), consumed: false } },
      ...(membershipIndex ? { membership_index: { ...membershipIndex, members: { memberUids: [uid] } } } : {}),
      members: { [uid]: { uid, role: "pending", tripIds: [], sessionIds: [] } },
    });
    const store = createCloudBaseMemberStore({ db, bootstrapCode: "correct" });

    await assert.rejects(() => store.consumeBootstrap({ identity: { openId: "ou_admin", displayName: "一鸣" }, code: "correct" }), { code: "MEMBERSHIP_INDEX_UNAVAILABLE" });
    assert.equal(db.data.get("members").get(uid).role, "pending");
    assert.equal(db.data.get("auth_bootstrap").get("singleton").consumed, false);
  }
});

test("CloudBase pending upsert fails closed before writing a member when membership indexes are malformed", async () => {
  const uid = uidForOpenId("ou_pending");
  for (const membershipIndex of [undefined, { admins: { adminUids: [] }, members: {} }, { admins: { adminUids: [] }, members: { memberUids: ["fs_missing"] } }]) {
    const db = createDb({
      ...(membershipIndex ? { membership_index: membershipIndex } : {}),
      members: {},
    });
    const store = createCloudBaseMemberStore({ db });

    await assert.rejects(() => store.upsertPending({ openId: "ou_pending", displayName: "待审核" }), { code: "MEMBERSHIP_INDEX_UNAVAILABLE" });
    assert.equal(db.data.get("members").has(uid), false);
  }
});

test("CloudBase pending upserts atomically preserve concurrent member associations", async () => {
  const db = createDb({ membership_index: { admins: { adminUids: [] }, members: { memberUids: [] } } });
  const store = createCloudBaseMemberStore({ db });

  await Promise.all([
    store.upsertPending({ openId: "ou_first", displayName: "第一位" }),
    store.upsertPending({ openId: "ou_second", displayName: "第二位" }),
  ]);

  assert.equal(db.transactionCalls, 2);
  assert.deepEqual(db.data.get("membership_index").get("members").memberUids.sort(), [uidForOpenId("ou_first"), uidForOpenId("ou_second")].sort());
  assert.equal(db.data.get("members").has(uidForOpenId("ou_first")), true);
  assert.equal(db.data.get("members").has(uidForOpenId("ou_second")), true);
});

test("CloudBase setRole fails closed for missing or inconsistent administrator indexes", async () => {
  const uid = "fs_member";
  for (const membershipIndex of [undefined, { admins: { adminUids: [uid] } }, { admins: {} }]) {
    const db = createDb({
      members: { [uid]: { uid, role: "pending", tripIds: [], sessionIds: [], version: 0 } },
      ...(membershipIndex ? { membership_index: { ...membershipIndex, members: { memberUids: [uid] } } } : {}),
    });
    const store = createCloudBaseMemberStore({ db });

    await assert.rejects(() => store.setRole(uid, "admin"), { code: "MEMBERSHIP_INDEX_UNAVAILABLE" });
    assert.equal(db.data.get("members").get(uid).role, "pending");
  }
});

test("CloudBase setRole rejects an administrator omitted from the index", async () => {
  const uid = "fs_admin";
  const db = createDb({
    members: { [uid]: { uid, role: "admin", tripIds: [], sessionIds: [], version: 1 } },
    membership_index: { admins: { adminUids: [] }, members: { memberUids: [uid] } },
  });
  const store = createCloudBaseMemberStore({ db });

  await assert.rejects(() => store.setRole(uid, "member"), { code: "MEMBERSHIP_INDEX_UNAVAILABLE" });
  assert.equal(db.data.get("members").get(uid).role, "admin");
});

test("CloudBase setRole rejects an unrelated administrator omitted from the index", async () => {
  const uid = "fs_member";
  const otherAdmin = "fs_other_admin";
  const db = createDb({
    members: {
      [uid]: { uid, role: "pending", tripIds: [], sessionIds: [], version: 0 },
      [otherAdmin]: { uid: otherAdmin, role: "admin", tripIds: [], sessionIds: [], version: 1 },
    },
    membership_index: { admins: { adminUids: [] }, members: { memberUids: [uid, otherAdmin] } },
  });
  const store = createCloudBaseMemberStore({ db });

  await assert.rejects(() => store.setRole(uid, "admin"), { code: "MEMBERSHIP_INDEX_UNAVAILABLE" });
  assert.equal(db.data.get("members").get(uid).role, "pending");
});

test("CloudBase session creation records the session ID on the member document", async () => {
  const uid = "fs_member";
  const db = createDb({ members: { [uid]: { uid, role: "member", sessionIds: [], tripIds: [] } } });
  const sessions = createCloudBaseAuthStore({ db, now: () => 1000, randomBytes: () => Buffer.alloc(32, 1) });

  const sessionId = await sessions.createSession({ uid, oauthState: "state" });

  assert.deepEqual(db.data.get("members").get(uid).sessionIds, [sessionId]);
  assert.equal(db.data.get("auth_sessions").get(sessionId).uid, uid);
});

test("CloudBase session creation does not write a member _id back to the database", async () => {
  const uid = "fs_member";
  const db = createDb({ members: { [uid]: { _id: uid, uid, role: "member", sessionIds: [], tripIds: [] } } });
  const sessions = createCloudBaseAuthStore({ db, now: () => 1000, randomBytes: () => Buffer.alloc(32, 2) });

  await sessions.createSession({ uid, oauthState: "state" });

  assert.equal(Object.hasOwn(db.data.get("members").get(uid), "_id"), false);
});

test("CloudBase auth records never write the reserved _id field", async () => {
  const db = createDb();
  const sessions = createCloudBaseAuthStore({ db, now: () => 1000, randomBytes: () => Buffer.alloc(32, 7) });

  const state = await sessions.createState();

  assert.equal(Object.hasOwn(db.data.get("auth_oauth_states").get(state), "_id"), false);
});
