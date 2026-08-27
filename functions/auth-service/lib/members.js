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
    async findByUid(uid) { return members.get(uid); },
    async findByOpenId(openId) { return members.get(uidForOpenId(openId)); },
    async upsertPending(identity) {
      const uid = uidForOpenId(identity.openId);
      const existing = members.get(uid);
      if (existing) return existing;
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
        const admin = { ...existing, displayName: identityForMember.displayName, ...(identityForMember.avatarUrl ? { avatarUrl: identityForMember.avatarUrl } : {}), role: "admin", approvedAt, version: (existing.version || 0) + 1 };
        members.set(targetUid, admin);
        bootstrap = { ...bootstrap, consumed: true };
        return admin;
      });
    },
    async setRole(uid, role) {
      const member = members.get(uid);
      if (!member) return undefined;
      const next = { ...member, role, version: member.version + 1, ...(role === "member" || role === "admin" ? { approvedAt: now().toISOString() } : {}) };
      members.set(uid, next);
      return next;
    },
  };
}

function createCloudBaseMemberStore({ db, now = () => new Date(), bootstrapCode } = {}) {
  if (!db) throw new Error("CLOUDBASE_DATABASE_UNAVAILABLE");
  const members = db.collection("members");
  const memory = createMemoryMemberStore({ now, bootstrapCode });
  return {
    async findByUid(uid) {
      const result = await members.doc(uid).get();
      return result.data?.[0] || result.data || undefined;
    },
    async findByOpenId(openId) { return this.findByUid(uidForOpenId(openId)); },
    async upsertPending(identity) {
      const existing = await this.findByOpenId(identity.openId);
      if (existing) return existing;
      const member = memberForIdentity(identity, "pending", now());
      await members.doc(member.uid).set(member);
      return member;
    },
    async consumeBootstrap({ identity, uid, member, code }) {
      if (typeof db.runTransaction !== "function") return memory.consumeBootstrap({ identity, uid, member, code });
      return db.runTransaction(async (transaction) => {
        const bootstrapResult = await transaction.collection("auth_bootstrap").doc("singleton").get();
        const record = bootstrapResult.data?.[0] || bootstrapResult.data || { codeHash: sha256(bootstrapCode || ""), consumed: false };
        if (record.consumed) {
          const error = new Error("BOOTSTRAP_ALREADY_CONSUMED"); error.code = error.message; throw error;
        }
        const provided = Buffer.from(sha256(code || ""), "hex");
        const expected = Buffer.from(record.codeHash || "", "hex");
        if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
          const error = new Error("INVALID_BOOTSTRAP_CODE"); error.code = error.message; throw error;
        }
        const targetUid = uid || uidForOpenId(identity.openId);
        if (typeof transaction.collection("members").where === "function") {
          const admins = await transaction.collection("members").where({ role: "admin" }).limit(1).get();
          if ((admins.data || []).length > 0) {
            const error = new Error("BOOTSTRAP_ALREADY_CONSUMED"); error.code = error.message; throw error;
          }
        }
        const result = await transaction.collection("members").doc(targetUid).get();
        const existing = result.data?.[0] || result.data || member || memberForIdentity(identity, "pending", now());
        const admin = { ...existing, role: "admin", approvedAt: now().toISOString(), version: (existing.version || 0) + 1 };
        await transaction.collection("members").doc(targetUid).set(admin);
        await transaction.collection("auth_bootstrap").doc("singleton").set({ ...record, consumed: true, consumedAt: now().toISOString() });
        return admin;
      });
    },
    async setRole(uid, role) {
      const current = await this.findByUid(uid); if (!current) return undefined;
      const next = { ...current, role, version: (current.version || 0) + 1, ...(role === "member" || role === "admin" ? { approvedAt: now().toISOString() } : {}) };
      await members.doc(uid).set(next); return next;
    },
  };
}

module.exports = { uidForOpenId, sha256, createMemoryMemberStore, createCloudBaseMemberStore };
