const crypto = require("node:crypto");

const STATE_TTL_MS = 10 * 60 * 1000;
const EXCHANGE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const CLEANUP_BATCH_SIZE = 100;
function writableRecord(record) { const { _id, ...value } = record; return value; }

function randomId(randomBytes) {
  return randomBytes(32).toString("base64url");
}

function exchangeId(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

function createMemoryAuthStore({ now = () => Date.now(), randomBytes = crypto.randomBytes, memberStore } = {}) {
  const states = new Map();
  const sessions = new Map();
  const exchanges = new Map();
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
    async createExchange({ uid, oauthState }) {
      const code = randomId(randomBytes);
      exchanges.set(exchangeId(code), { uid, oauthState, expiresAt: now() + EXCHANGE_TTL_MS, usedAt: null });
      return code;
    },
    async getExchange(code) {
      if (!code) return undefined;
      const id = exchangeId(code);
      const record = exchanges.get(id);
      if (!record || record.usedAt !== null || record.expiresAt <= now()) {
        exchanges.delete(id);
        return undefined;
      }
      return { uid: record.uid, oauthState: record.oauthState };
    },
    async consumeExchange(code) {
      if (!code) return undefined;
      const id = exchangeId(code);
      const record = exchanges.get(id);
      if (!record || record.usedAt !== null || record.expiresAt <= now()) {
        exchanges.delete(id);
        return undefined;
      }
      exchanges.delete(id);
      return { uid: record.uid, oauthState: record.oauthState };
    },
  };
}

function readDoc(result) { return Array.isArray(result?.data) ? result.data[0] : result?.data; }

async function cleanupExpiredAuthRecords({ db, cutoff, limit = CLEANUP_BATCH_SIZE } = {}) {
  if (!db?.command?.lt || typeof db.collection !== "function" || typeof db.runTransaction !== "function") return;
  const expired = db.command.lt(cutoff);
  const expiredSessions = await db.collection("auth_sessions").where({ expiresAt: expired }).limit(limit).get();
  for (const row of expiredSessions?.data || []) {
    const sessionId = row?._id;
    if (typeof sessionId !== "string" || !sessionId) continue;
    await db.runTransaction(async (transaction) => {
      const sessionDocument = transaction.collection("auth_sessions").doc(sessionId);
      const session = readDoc(await sessionDocument.get());
      if (!session || typeof session.expiresAt !== "number" || session.expiresAt >= cutoff) return;
      if (typeof session.uid === "string" && session.uid) {
        const memberDocument = transaction.collection("members").doc(session.uid);
        const member = readDoc(await memberDocument.get());
        if (member && Array.isArray(member.sessionIds)) {
          await memberDocument.set(writableRecord({ ...member, sessionIds: member.sessionIds.filter((id) => id !== sessionId) }));
        }
      }
      await sessionDocument.remove();
    });
  }
  await db.collection("auth_oauth_states").where({ expiresAt: expired }).limit(limit).remove();
  await db.collection("auth_exchange_codes").where({ expiresAt: expired }).limit(limit).remove();
}

function createCloudBaseAuthStore({ db, now = () => Date.now(), randomBytes = crypto.randomBytes } = {}) {
  if (!db || typeof db.runTransaction !== "function") throw new Error("CLOUDBASE_TRANSACTION_UNAVAILABLE");
  const states = db.collection("auth_oauth_states");
  const sessions = db.collection("auth_sessions");
  const exchanges = db.collection("auth_exchange_codes");
  let lastCleanupAt = Number.NEGATIVE_INFINITY;
  async function maybeCleanupExpiredRecords() {
    const currentTime = now();
    if (currentTime - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
    lastCleanupAt = currentTime;
    try { await cleanupExpiredAuthRecords({ db, cutoff: currentTime }); } catch { /* Login stays available; the next warm instance retries cleanup. */ }
  }
  return {
    async createState() {
      await maybeCleanupExpiredRecords();
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
        await memberDoc.set(writableRecord({ ...member, sessionIds: [...new Set([...sessionIds, id])] }));
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
    async createExchange({ uid, oauthState }) {
      const code = randomId(randomBytes);
      await exchanges.doc(exchangeId(code)).set({ uid, oauthState, expiresAt: now() + EXCHANGE_TTL_MS, usedAt: null });
      return code;
    },
    async getExchange(code) {
      if (!code) return undefined;
      const record = readDoc(await exchanges.doc(exchangeId(code)).get());
      if (!record || record.usedAt != null || record.expiresAt <= now()) return undefined;
      return { uid: record.uid, oauthState: record.oauthState };
    },
    async consumeExchange(code) {
      if (!code) return undefined;
      return db.runTransaction(async (transaction) => {
        const document = transaction.collection("auth_exchange_codes").doc(exchangeId(code));
        const record = readDoc(await document.get());
        if (!record || record.usedAt != null || record.expiresAt <= now()) return undefined;
        await document.set(writableRecord({ ...record, usedAt: now() }));
        return { uid: record.uid, oauthState: record.oauthState };
      });
    },
  };
}

module.exports = { cleanupExpiredAuthRecords, createMemoryAuthStore, createCloudBaseAuthStore, STATE_TTL_MS, EXCHANGE_TTL_MS, SESSION_TTL_MS };
