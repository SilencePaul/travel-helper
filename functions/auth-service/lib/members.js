const crypto = require("node:crypto");

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function uidForOpenId(openId) { return "fs_" + sha256(openId).slice(0, 29); }

function memberForIdentity(identity, role = "pending", now = new Date()) {
  const createdAt = now.toISOString();
  return {
    uid: uidForOpenId(identity.openId),
    displayName: identity.displayName,
    ...(identity.avatarUrl ? { avatarUrl: identity.avatarUrl } : {}),
    openIdHash: sha256(identity.openId),
    role,
    version: 0,
    tripIds: [],
    sessionIds: [],
    createdAt,
    ...(role === "admin" ? { approvedAt: createdAt } : {}),
  };
}

function createMemoryMemberStore({ now = () => new Date(), bootstrapCode } = {}) {
  const members = new Map();
  let bootstrap = bootstrapCode ? { hash: sha256(bootstrapCode), consumed: false } : undefined;
  let mutation = Promise.resolve();
  const atomic = (operation) => {
    const result = mutation.then(operation, operation);
    mutation = result.catch(() => undefined);
    return result;
  };
  return {
    async hasAdmin() { return Array.from(members.values()).some((item) => item.role === "admin"); },
    async findByUid(uid) { return members.get(uid); },
    async findByOpenId(openId) { return members.get(uidForOpenId(openId)); },
    async addSessionId(uid, sessionId) {
      const member = members.get(uid);
      if (!member) return undefined;
      const sessionIds = member.sessionIds === undefined ? [] : member.sessionIds;
      if (!Array.isArray(sessionIds)) return undefined;
      const next = { ...member, sessionIds: [...new Set([...sessionIds, sessionId])] };
      members.set(uid, next);
      return next;
    },
    async upsertPending(identity) {
      const uid = uidForOpenId(identity.openId);
      const existing = members.get(uid);
      if (existing) {
        const next = { ...existing, tripIds: existing.tripIds === undefined ? [] : existing.tripIds, sessionIds: existing.sessionIds === undefined ? [] : existing.sessionIds };
        members.set(uid, next);
        return next;
      }
      const member = memberForIdentity(identity, "pending", now());
      members.set(uid, member);
      return member;
    },
    async consumeBootstrap({ identity, uid, member, code }) {
      return atomic(async () => {
        if (!bootstrap || bootstrap.consumed || Array.from(members.values()).some((item) => item.role === "admin")) {
          const error = new Error("BOOTSTRAP_ALREADY_CONSUMED"); error.code = error.message; throw error;
        }
        const provided = Buffer.from(sha256(code || ""), "hex");
        const expected = Buffer.from(bootstrap.hash, "hex");
        if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
          const error = new Error("INVALID_BOOTSTRAP_CODE"); error.code = error.message; throw error;
        }
        const identityForMember = identity || { openId: member?.openId || member?.openIdHash || uid, displayName: member?.displayName || "管理员", ...(member?.avatarUrl ? { avatarUrl: member.avatarUrl } : {}) };
        const targetUid = uid || uidForOpenId(identityForMember.openId);
        const existing = members.get(targetUid) || member || memberForIdentity(identityForMember, "pending", now());
        const approvedAt = now().toISOString();
        const admin = { ...existing, displayName: identityForMember.displayName, ...(identityForMember.avatarUrl ? { avatarUrl: identityForMember.avatarUrl } : {}), role: "admin", tripIds: existing.tripIds === undefined ? [] : existing.tripIds, sessionIds: existing.sessionIds === undefined ? [] : existing.sessionIds, approvedAt, version: (existing.version || 0) + 1 };
        members.set(targetUid, admin);
        bootstrap = { ...bootstrap, consumed: true };
        return admin;
      });
    },
    async setRole(uid, role) {
      const member = members.get(uid);
      if (!member) return undefined;
      const next = { ...member, role, tripIds: member.tripIds === undefined ? [] : member.tripIds, sessionIds: member.sessionIds === undefined ? [] : member.sessionIds, version: member.version + 1, ...(role === "member" || role === "admin" ? { approvedAt: now().toISOString() } : {}) };
      members.set(uid, next);
      return next;
    },
  };
}

function createCloudBaseMemberStore({ db, now = () => new Date(), bootstrapCode } = {}) {
  if (!db || typeof db.collection !== "function" || typeof db.runTransaction !== "function") {
    const error = new Error("CLOUDBASE_TRANSACTION_UNAVAILABLE"); error.code = error.message; throw error;
  }
  const members = db.collection("members");
  const bootstrap = db.collection("auth_bootstrap");
  const membershipIndex = db.collection("membership_index");
  const memberDoc = members?.doc?.("__capability_check__");
  const bootstrapDoc = bootstrap?.doc?.("__capability_check__");
  const memberQuery = members?.where?.({ role: "admin" });
  const membershipIndexDoc = membershipIndex?.doc?.("__capability_check__");
  if (!members || typeof members.doc !== "function" || typeof members.where !== "function" || !memberQuery || typeof memberQuery.limit !== "function" || !memberDoc || typeof memberDoc.get !== "function" || typeof memberDoc.set !== "function" || !bootstrap || typeof bootstrap.doc !== "function" || !bootstrapDoc || typeof bootstrapDoc.get !== "function" || typeof bootstrapDoc.set !== "function" || !membershipIndex || typeof membershipIndex.doc !== "function" || !membershipIndexDoc || typeof membershipIndexDoc.get !== "function" || typeof membershipIndexDoc.set !== "function") {
    const error = new Error("CLOUDBASE_TRANSACTION_UNAVAILABLE"); error.code = error.message; throw error;
  }
  return {
    async hasAdmin() {
      const result = await members.where({ role: "admin" }).limit(1).get();
      return (result.data || []).length > 0;
    },
    async findByUid(uid) {
      const result = await members.doc(uid).get();
      return result.data?.[0] || result.data || undefined;
    },
    async findByOpenId(openId) { return this.findByUid(uidForOpenId(openId)); },
    async upsertPending(identity) {
      const existing = await this.findByOpenId(identity.openId);
      if (existing) {
        const next = { ...existing, tripIds: existing.tripIds === undefined ? [] : existing.tripIds, sessionIds: existing.sessionIds === undefined ? [] : existing.sessionIds };
        if (next.tripIds === existing.tripIds && next.sessionIds === existing.sessionIds) return existing;
        await members.doc(existing.uid).set(next);
        return next;
      }
      const member = memberForIdentity(identity, "pending", now());
      await members.doc(member.uid).set(member);
      return member;
    },
    async consumeBootstrap({ identity, uid, member, code }) {
      return db.runTransaction(async (transaction) => {
        if (!transaction || typeof transaction.collection !== "function") {
          const error = new Error("CLOUDBASE_TRANSACTION_UNAVAILABLE"); error.code = error.message; throw error;
        }
        const transactionMembers = transaction.collection("members");
        const transactionBootstrap = transaction.collection("auth_bootstrap");
        const transactionMembershipIndex = transaction.collection("membership_index");
        const transactionMemberDoc = transactionMembers?.doc?.("__capability_check__");
        const transactionBootstrapDoc = transactionBootstrap?.doc?.("__capability_check__");
        const transactionMembershipIndexDoc = transactionMembershipIndex?.doc?.("__capability_check__");
        if (!transactionMembers || typeof transactionMembers.doc !== "function" || !transactionMemberDoc || typeof transactionMemberDoc.get !== "function" || typeof transactionMemberDoc.set !== "function" || !transactionBootstrap || typeof transactionBootstrap.doc !== "function" || !transactionBootstrapDoc || typeof transactionBootstrapDoc.get !== "function" || typeof transactionBootstrapDoc.set !== "function" || !transactionMembershipIndex || typeof transactionMembershipIndex.doc !== "function" || !transactionMembershipIndexDoc || typeof transactionMembershipIndexDoc.get !== "function" || typeof transactionMembershipIndexDoc.set !== "function") {
          const error = new Error("CLOUDBASE_TRANSACTION_UNAVAILABLE"); error.code = error.message; throw error;
        }
        const bootstrapResult = await transactionBootstrap.doc("singleton").get();
        const record = bootstrapResult.data?.[0] || bootstrapResult.data || { codeHash: sha256(bootstrapCode || ""), consumed: false, adminUids: [] };
        if (record.consumed) {
          const error = new Error("BOOTSTRAP_ALREADY_CONSUMED"); error.code = error.message; throw error;
        }
        const provided = Buffer.from(sha256(code || ""), "hex");
        const expected = Buffer.from(record.codeHash || "", "hex");
        if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
          const error = new Error("INVALID_BOOTSTRAP_CODE"); error.code = error.message; throw error;
        }
        const adminIndexResult = await transactionMembershipIndex.doc("admins").get();
        const adminIndex = adminIndexResult.data?.[0] || adminIndexResult.data || undefined;
        const adminUids = adminIndex?.adminUids || adminIndex?.uids || record.adminUids || [];
        if (!Array.isArray(adminUids) || adminUids.some((item) => typeof item !== "string") || new Set(adminUids).size !== adminUids.length) {
          const error = new Error("MEMBERSHIP_INDEX_UNAVAILABLE"); error.code = error.message; throw error;
        }
        if (record.consumed || adminUids.length > 0) {
          const error = new Error("BOOTSTRAP_ALREADY_CONSUMED"); error.code = error.message; throw error;
        }
        const targetUid = uid || uidForOpenId(identity.openId);
        const result = await transactionMembers.doc(targetUid).get();
        const existing = result.data?.[0] || result.data || member || memberForIdentity(identity, "pending", now());
        const admin = { ...existing, role: "admin", tripIds: existing.tripIds === undefined ? [] : existing.tripIds, sessionIds: existing.sessionIds === undefined ? [] : existing.sessionIds, approvedAt: now().toISOString(), version: (existing.version || 0) + 1 };
        await transactionMembers.doc(targetUid).set(admin);
        await transactionBootstrap.doc("singleton").set({ ...record, consumed: true, adminUids: [targetUid], consumedAt: now().toISOString() });
        await transactionMembershipIndex.doc("admins").set({ ...(adminIndex || {}), adminUids: [targetUid] });
        return admin;
      });
    },
    async setRole(uid, role) {
      return db.runTransaction(async (transaction) => {
        const current = (await transaction.collection("members").doc(uid).get()).data?.[0] || undefined; if (!current) return undefined;
        const indexDoc = transaction.collection("membership_index").doc("admins");
        const index = (await indexDoc.get()).data?.[0] || { adminUids: [] };
        const adminUids = index.adminUids || index.uids || [];
        if (adminUids.some((item) => typeof item !== "string") || new Set(adminUids).size !== adminUids.length) {
          const error = new Error("MEMBERSHIP_INDEX_UNAVAILABLE"); error.code = error.message; throw error;
        }
        const nextAdminUids = role === "admin" ? [...new Set([...adminUids, uid])] : adminUids.filter((item) => item !== uid);
        const next = { ...current, role, tripIds: current.tripIds === undefined ? [] : current.tripIds, sessionIds: current.sessionIds === undefined ? [] : current.sessionIds, version: (current.version || 0) + 1, ...(role === "member" || role === "admin" ? { approvedAt: now().toISOString() } : {}) };
        await transaction.collection("members").doc(uid).set(next);
        await indexDoc.set({ ...index, adminUids: nextAdminUids });
        return next;
      });
    },
  };
}

module.exports = { uidForOpenId, sha256, memberForIdentity, createMemoryMemberStore, createCloudBaseMemberStore };
