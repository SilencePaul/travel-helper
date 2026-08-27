const crypto = require("node:crypto");

const STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
function writableRecord(record) { const { _id, ...value } = record; return value; }

function randomId(randomBytes) {
  return randomBytes(32).toString("base64url");
}

function createMemoryAuthStore({ now = () => Date.now(), randomBytes = crypto.randomBytes, memberStore } = {}) {
  const states = new Map();
  const sessions = new Map();
  return {
    async createState() {
      const id = randomId(randomBytes);
      states.set(id, { expiresAt: now() + STATE_TTL_MS, consumed: false });
      return id;
    },
    async consumeState(id) {
      const record = states.get(id);
      if (!record || record.consumed || record.expiresAt <= now()) return false;
      record.consumed = true;
      states.delete(id);
      return true;
    },
    async createSession({ uid, oauthState }) {
      const id = randomId(randomBytes);
      sessions.set(id, { uid, oauthState, expiresAt: now() + SESSION_TTL_MS, revoked: false });
      if (memberStore?.addSessionId && !(await memberStore.addSessionId(uid, id))) {
        sessions.delete(id);
        throw new Error("MEMBERSHIP_ASSOCIATIONS_UNAVAILABLE");
      }
      return id;
    },
    async getSession(id) {
      if (!id) return undefined;
      const record = sessions.get(id);
      if (!record || record.revoked || record.expiresAt <= now()) {
        if (record) sessions.delete(id);
        return undefined;
      }
      return record;
    },
    async revokeSession(id) {
      if (id) sessions.delete(id);
    },
  };
}

function readDoc(result) { return result?.data?.[0] || result?.data || undefined; }

function createCloudBaseAuthStore({ db, now = () => Date.now(), randomBytes = crypto.randomBytes } = {}) {
  if (!db || typeof db.runTransaction !== "function") throw new Error("CLOUDBASE_TRANSACTION_UNAVAILABLE");
  const states = db.collection("auth_oauth_states");
  const sessions = db.collection("auth_sessions");
  return {
    async createState() {
      const id = randomId(randomBytes);
      await states.doc(id).set({ expiresAt: now() + STATE_TTL_MS, consumed: false });
      return id;
    },
    async consumeState(id) {
      if (!id) return false;
      return db.runTransaction(async (transaction) => {
        const record = readDoc(await transaction.collection("auth_oauth_states").doc(id).get());
        if (!record || record.consumed || record.expiresAt <= now()) return false;
        await transaction.collection("auth_oauth_states").doc(id).set(writableRecord({ ...record, consumed: true, consumedAt: now() }));
        return true;
      });
    },
    async createSession({ uid, oauthState }) {
      const id = randomId(randomBytes);
      const session = { uid, oauthState, expiresAt: now() + SESSION_TTL_MS, revoked: false };
      await db.runTransaction(async (transaction) => {
        const memberDoc = transaction.collection("members").doc(uid);
        const result = await memberDoc.get();
        const member = readDoc(result);
        if (!member) throw new Error("MEMBERSHIP_ASSOCIATIONS_UNAVAILABLE");
        const sessionIds = member.sessionIds === undefined ? [] : member.sessionIds;
        if (!Array.isArray(sessionIds) || sessionIds.some((item) => typeof item !== "string")) throw new Error("MEMBERSHIP_ASSOCIATIONS_UNAVAILABLE");
        await transaction.collection("auth_sessions").doc(id).set(session);
        await memberDoc.set({ ...member, sessionIds: [...new Set([...sessionIds, id])] });
      });
      return id;
    },
    async getSession(id) {
      if (!id) return undefined;
      const record = readDoc(await sessions.doc(id).get());
      if (!record || record.revoked || record.expiresAt <= now()) return undefined;
      return record;
    },
    async revokeSession(id) {
      if (id) await sessions.doc(id).set({ revoked: true, expiresAt: now() });
    },
  };
}

module.exports = { createMemoryAuthStore, createCloudBaseAuthStore, STATE_TTL_MS, SESSION_TTL_MS };
