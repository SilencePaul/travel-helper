const assert = require("node:assert/strict");
const test = require("node:test");
const { createTripHandler } = require("./index.js");

test("uses the authenticated custom UID and ignores a payload actor UID", async () => {
  const calls = [];
  const handler = createTripHandler({ getUserInfo: () => ({ customUserId: "fs_member" }), commands: { execute: async (payload, actorUid) => { calls.push({ payload, actorUid }); return { ok: true }; } } });

  const result = await handler({ data: { action: "listMembers", actorUid: "attacker" }, userInfo: { customUserId: "fs_attacker" } });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls[0], { payload: { action: "listMembers", actorUid: "attacker" }, actorUid: "fs_member" });
});

test("uses the trusted CloudBase runtime UID and ignores event or context identities", async () => {
  const calls = [];
  const handler = createTripHandler({ getUserInfo: () => ({ uid: "internal-only" }), commands: { execute: async (_payload, actorUid) => { calls.push(actorUid); return { ok: true }; } } });

  assert.deepEqual(await handler({ data: { action: "listMembers" }, userInfo: { customUserId: "fs_event_admin" } }, { userInfo: { customUserId: "fs_context_admin" } }), { ok: true });
  assert.deepEqual(calls, ["internal-only"]);
});

test("uses the custom user ID exposed by the CloudBase runtime auth", async () => {
  const calls = [];
  const handler = createTripHandler({
    getUserInfo: () => ({ uid: "cloudbase-internal-uid", customUserId: "fs_member" }),
    commands: { execute: async (payload, actorUid) => { calls.push({ payload, actorUid }); return { ok: true }; } },
  });

  assert.deepEqual(await handler({ data: { action: "listMembers" } }), { ok: true });
  assert.deepEqual(calls, [{ payload: { action: "listMembers" }, actorUid: "fs_member" }]);
});

test("returns only stable command errors", async () => {
  const handler = createTripHandler({ getUserInfo: () => ({ customUserId: "fs_member" }), commands: { execute: async () => { const error = new Error("provider details"); error.code = "UNEXPECTED_PROVIDER_ERROR"; throw error; } } });
  assert.deepEqual(await handler({ action: "listMembers" }), { error: "TRIP_API_UNAVAILABLE" });
});
