const assert = require("node:assert/strict");
const test = require("node:test");
const { cleanupExpiredAuthRecords, createMemoryAuthStore, EXCHANGE_TTL_MS } = require("./authStore.js");

test("authentication exchange codes are single-use and expire after five minutes", async () => {
  let now = 1_000;
  const store = createMemoryAuthStore({ now: () => now, randomBytes: () => Buffer.alloc(32, 11) });
  const code = await store.createExchange({ uid: "fs_member", oauthState: "state" });

  assert.deepEqual(await store.consumeExchange(code), { uid: "fs_member", oauthState: "state" });
  assert.equal(await store.consumeExchange(code), undefined);

  const expiredCode = await store.createExchange({ uid: "fs_member", oauthState: "state-2" });
  now += EXCHANGE_TTL_MS + 1;
  assert.equal(await store.consumeExchange(expiredCode), undefined);
});

test("expired persistent auth records are removed and member session associations are pruned", async () => {
  const data = new Map(Object.entries({
    auth_oauth_states: new Map([["expired-state", { expiresAt: 999 }], ["live-state", { expiresAt: 2_000 }]]),
    auth_exchange_codes: new Map([["expired-code", { expiresAt: 999 }]]),
    auth_sessions: new Map([["expired-session", { uid: "fs_member", expiresAt: 999 }], ["live-session", { uid: "fs_member", expiresAt: 2_000 }]]),
    members: new Map([["fs_member", { uid: "fs_member", sessionIds: ["expired-session", "live-session"] }]]),
  }));
  const collection = (name) => ({
    doc(id) {
      const records = data.get(name);
      return {
        async get() { const value = records.get(id); return { data: value ? [{ _id: id, ...structuredClone(value) }] : [] }; },
        async set(value) { records.set(id, structuredClone(value)); },
        async remove() { records.delete(id); },
      };
    },
    where({ expiresAt }) {
      let max = Number.POSITIVE_INFINITY;
      const matches = () => [...data.get(name).entries()].filter(([, value]) => value.expiresAt < expiresAt.cutoff).slice(0, max);
      return {
        limit(value) { max = value; return this; },
        async get() { return { data: matches().map(([id, value]) => ({ _id: id, ...structuredClone(value) })) }; },
        async remove() { for (const [id] of matches()) data.get(name).delete(id); },
      };
    },
  });
  const db = {
    command: { lt: (cutoff) => ({ cutoff }) },
    collection,
    async runTransaction(callback) { return callback({ collection }); },
  };

  await cleanupExpiredAuthRecords({ db, cutoff: 1_000 });

  assert.equal(data.get("auth_oauth_states").has("expired-state"), false);
  assert.equal(data.get("auth_oauth_states").has("live-state"), true);
  assert.equal(data.get("auth_exchange_codes").size, 0);
  assert.equal(data.get("auth_sessions").has("expired-session"), false);
  assert.deepEqual(data.get("members").get("fs_member").sessionIds, ["live-session"]);
});
