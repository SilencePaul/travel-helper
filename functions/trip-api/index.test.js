const assert = require("node:assert/strict");
const test = require("node:test");
const { createTripHandler } = require("./index.js");

test("uses the authenticated custom UID and ignores a payload actor UID", async () => {
  const calls = [];
  const handler = createTripHandler({ commands: { execute: async (payload, actorUid) => { calls.push({ payload, actorUid }); return { ok: true }; } } });

  const result = await handler({ data: { action: "listMembers", actorUid: "attacker" }, userInfo: { uid: "fs_member" } });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls[0], { payload: { action: "listMembers", actorUid: "attacker" }, actorUid: "fs_member" });
  assert.deepEqual(await handler({ action: "listMembers", actorUid: "attacker" }), { error: "AUTH_REQUIRED" });
});

test("returns only stable command errors", async () => {
  const handler = createTripHandler({ commands: { execute: async () => { const error = new Error("provider details"); error.code = "UNEXPECTED_PROVIDER_ERROR"; throw error; } } });
  assert.deepEqual(await handler({ action: "listMembers", userInfo: { uid: "fs_member" } }), { error: "TRIP_API_UNAVAILABLE" });
});
