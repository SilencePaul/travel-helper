const { z } = require("zod");
function writableRecord(record) { const { _id, ...value } = record; return value; }

const BudgetItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  category: z.enum(["flight", "hotel", "transport", "ticket", "food"]),
  estimated: z.number().int().nonnegative(),
  paid: z.number().int().nonnegative(),
  currency: z.string().min(1).max(8),
  status: z.enum(["unpaid", "partial", "paid"]),
  dayId: z.string().min(1).optional(),
}).superRefine((item, context) => {
  if (item.status === "unpaid" && item.paid !== 0) context.addIssue({ code: "custom", message: "未支付订单的已支付金额必须为 0", path: ["paid"] });
  if (item.status === "partial" && item.paid <= 0) context.addIssue({ code: "custom", message: "部分支付订单必须录入实际已付金额", path: ["paid"] });
  if (item.status === "paid" && item.paid <= 0) context.addIssue({ code: "custom", message: "已支付订单必须录入实际已付金额", path: ["paid"] });
});

const TripSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  startDate: z.string().date(),
  endDate: z.string().date(),
  travelers: z.array(z.object({ id: z.string(), name: z.string() })),
  days: z.array(z.object({
    id: z.string().min(1), date: z.string().date(), city: z.string(), itemIds: z.array(z.string()), hotelId: z.string().nullable().optional(),
  })),
  unscheduledItemIds: z.array(z.string()),
  orders: z.array(BudgetItemSchema).default([]),
  memberUids: z.array(z.string().min(4).max(64)).optional(),
  version: z.number().int().nonnegative(),
}).superRefine((trip, context) => {
  if (trip.endDate < trip.startDate) context.addIssue({ code: "custom", message: "结束日期不能早于开始日期", path: ["endDate"] });

  const dayIds = new Set();
  trip.days.forEach((day, index) => {
    if (dayIds.has(day.id)) context.addIssue({ code: "custom", message: "日期 ID 不能重复", path: ["days", index, "id"] });
    dayIds.add(day.id);
  });

  const orderIds = new Set();
  trip.orders.forEach((order, index) => {
    if (orderIds.has(order.id)) context.addIssue({ code: "custom", message: "订单 ID 不能重复", path: ["orders", index, "id"] });
    orderIds.add(order.id);
  });
});

const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("getCurrentMember") }),
  z.object({ action: z.literal("getTrip"), tripId: z.string().min(1) }),
  z.object({ action: z.literal("listMembers") }),
  z.object({ action: z.enum(["approveMember", "rejectMember", "removeMember"]), uid: z.string().min(4).max(32) }),
  z.object({ action: z.literal("saveTrip"), tripId: z.string().min(1).optional(), trip: TripSchema, expectedVersion: z.number().int().nonnegative(), idempotencyKey: z.string().min(8).max(128) }),
]);
const ServerMemberUidsSchema = z.array(z.string().min(4).max(64)).min(1);

function codedError(code, details = {}) { const error = new Error(code); error.code = code; Object.assign(error, details); return error; }
function one(result) {
  if (!result || !Object.hasOwn(result, "data")) return undefined;
  return Array.isArray(result.data) ? result.data[0] : result.data;
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function requestTrip(trip) {
  const { version, memberUids, ...withoutServerOwnedFields } = trip;
  return withoutServerOwnedFields;
}
function canonicalTripRequest(trip) {
  const parsed = TripSchema.safeParse(trip);
  if (!parsed.success) throw codedError("IDEMPOTENCY_KEY_REUSED");
  return canonical(requestTrip(parsed.data));
}
function associationIds(value, code = "MEMBERSHIP_ASSOCIATIONS_UNAVAILABLE") {
  if (!Array.isArray(value)) throw codedError(code);
  if (value.some((id) => typeof id !== "string" || !id || value.indexOf(id) !== value.lastIndexOf(id))) throw codedError(code);
  return [...value];
}
function optionalAssociationIds(value) {
  return value === undefined ? [] : associationIds(value);
}
function readRecord(result) {
  return one(result);
}
function createCloudBaseSessionRevoker() {
  return {
    async prepareSessionsForUid(transaction, uid, sessionIds, revokedAt) {
      const sessions = transaction.collection("auth_sessions");
      const updates = [];
      for (const sessionId of sessionIds) {
        const session = readRecord(await sessions.doc(sessionId).get());
        if (!session || session.uid !== uid) throw codedError("SESSION_REVOKE_FAILED");
        updates.push({ id: sessionId, value: { ...session, revoked: true, revokedAt, expiresAt: Date.parse(revokedAt) } });
      }
      return updates;
    },
    async revokeSessionsForUid(transaction, uid, revokedAt, sessionIds) {
      const ids = sessionIds === undefined
        ? associationIds(readRecord(await transaction.collection("members").doc(uid).get())?.sessionIds)
        : associationIds(sessionIds);
      const updates = await this.prepareSessionsForUid(transaction, uid, ids, revokedAt);
      const sessions = transaction.collection("auth_sessions");
      for (const update of updates) await sessions.doc(update.id).set(writableRecord(update.value));
    },
  };
}
function safeMember(member) {
  if (!member) return undefined;
  const { uid, displayName, avatarUrl, role, version, createdAt, approvedAt } = member;
  return { uid, displayName, ...(avatarUrl ? { avatarUrl } : {}), role, version, createdAt, ...(approvedAt ? { approvedAt } : {}) };
}

function createTripCommands({ db, now = () => new Date(), sessionRevoker = createCloudBaseSessionRevoker() } = {}) {
  if (!db || typeof db.runTransaction !== "function") throw codedError("CLOUDBASE_TRANSACTION_UNAVAILABLE");

  async function getActor(transaction, uid) {
    const actor = one(await transaction.collection("members").doc(uid).get());
    if (!actor || !["admin", "member"].includes(actor.role)) throw codedError("MEMBERSHIP_REQUIRED");
    return actor;
  }

  async function audit(transaction, actor, action, targetName, changedFields = []) {
    const timestamp = now().toISOString();
    await transaction.collection("trip_audits").add({ actorUid: actor.uid, actorName: actor.displayName, action, ...(targetName ? { targetName } : {}), changedFields, createdAt: timestamp });
  }

  async function assertActiveMemberCapacity(transaction, actorUid, targetUid) {
    const index = readRecord(await transaction.collection("membership_index").doc("members").get());
    const memberUids = associationIds(index?.memberUids, "MEMBERSHIP_INDEX_UNAVAILABLE");
    if (!memberUids.includes(actorUid) || !memberUids.includes(targetUid)) throw codedError("MEMBERSHIP_INDEX_UNAVAILABLE");
    let activeCount = 0;
    for (const uid of memberUids) {
      const member = readRecord(await transaction.collection("members").doc(uid).get());
      if (!member) throw codedError("MEMBERSHIP_INDEX_UNAVAILABLE");
      if (member.role === "admin" || member.role === "member") activeCount += 1;
    }
    if (activeCount >= 2) throw codedError("MEMBER_LIMIT_REACHED");
  }

  async function changeMember(input, actorUid) {
    return db.runTransaction(async (transaction) => {
      const actor = await getActor(transaction, actorUid);
      if (actor.role !== "admin") throw codedError("ADMIN_REQUIRED");
      const members = transaction.collection("members");
      const target = one(await members.doc(input.uid).get());
      if (!target) throw codedError("MEMBER_NOT_FOUND");
      if (input.action === "approveMember" && target.role !== "pending") throw codedError("INVALID_MEMBER_STATE");
      if (input.action === "rejectMember" && target.role !== "pending") throw codedError("INVALID_MEMBER_STATE");
      if (input.action === "removeMember" && !["admin", "member"].includes(target.role)) throw codedError("INVALID_MEMBER_STATE");
      let tripIds = input.action === "removeMember" ? associationIds(target.tripIds) : optionalAssociationIds(target.tripIds);
      const sessionIds = input.action === "removeMember" ? associationIds(target.sessionIds) : optionalAssociationIds(target.sessionIds);
      let nextAdminIndex;
      if (input.action === "removeMember" && target.role === "admin") {
        const adminIndex = readRecord(await transaction.collection("membership_index").doc("admins").get());
        const adminIds = adminIndex?.adminUids || adminIndex?.uids;
        if (!Array.isArray(adminIds) || adminIds.some((uid) => typeof uid !== "string") || new Set(adminIds).size !== adminIds.length) throw codedError("MEMBERSHIP_INDEX_UNAVAILABLE");
        if (!adminIds.includes(target.uid)) throw codedError("MEMBERSHIP_INDEX_UNAVAILABLE");
        if (adminIds.length <= 1) throw codedError("LAST_ADMIN");
        nextAdminIndex = { ...adminIndex, adminUids: adminIds.filter((uid) => uid !== target.uid) };
      }
      const timestamp = now().toISOString();
      const role = input.action === "approveMember" ? "member" : "removed";
      let tripUpdates = [];
      if (input.action === "approveMember") {
        await assertActiveMemberCapacity(transaction, actor.uid, target.uid);
        const actorTripIds = associationIds(actor.tripIds);
        if (actorTripIds.length === 0 || tripIds.some((tripId) => !actorTripIds.includes(tripId))) throw codedError("MEMBERSHIP_ASSOCIATIONS_UNAVAILABLE");
        const trips = transaction.collection("trips");
        for (const tripId of actorTripIds) {
          const trip = readRecord(await trips.doc(tripId).get());
          if (!trip || !Array.isArray(trip.memberUids) || !trip.memberUids.includes(actor.uid)) throw codedError("MEMBERSHIP_ASSOCIATIONS_UNAVAILABLE");
          if (!trip.memberUids.includes(target.uid)) {
            tripUpdates.push({ id: tripId, value: {
              ...trip,
              memberUids: [...trip.memberUids, target.uid],
              version: Number.isInteger(trip.version) ? trip.version + 1 : 1,
            } });
          }
        }
        tripIds = actorTripIds;
      } else if (input.action === "removeMember") {
        const trips = transaction.collection("trips");
        for (const tripId of tripIds) {
          const trip = readRecord(await trips.doc(tripId).get());
          if (!trip || !Array.isArray(trip.memberUids) || !trip.memberUids.includes(target.uid)) throw codedError("MEMBERSHIP_ASSOCIATIONS_UNAVAILABLE");
          tripUpdates.push({ id: tripId, value: {
            ...trip,
            memberUids: trip.memberUids.filter((uid) => uid !== target.uid),
            version: Number.isInteger(trip.version) ? trip.version + 1 : 1,
          } });
        }
        if (typeof sessionRevoker.prepareSessionsForUid === "function") {
          await sessionRevoker.prepareSessionsForUid(transaction, target.uid, sessionIds, timestamp);
        }
      }
      const next = { ...target, role, tripIds, sessionIds, version: (target.version || 0) + 1, ...(role === "member" ? { approvedAt: timestamp } : {}) };
      await members.doc(target.uid).set(writableRecord(next));
      for (const update of tripUpdates) await transaction.collection("trips").doc(update.id).set(writableRecord(update.value));
      if (input.action === "removeMember") await sessionRevoker.revokeSessionsForUid(transaction, target.uid, timestamp, sessionIds);
      if (nextAdminIndex) await transaction.collection("membership_index").doc("admins").set(writableRecord(nextAdminIndex));
      await audit(transaction, actor, input.action, target.displayName, ["role", "version", ...(role === "member" ? ["approvedAt", "tripIds", "memberUids"] : []), ...(input.action === "removeMember" ? ["memberUids", "sessions"] : [])]);
      return { member: safeMember(next) };
    });
  }

  async function saveTrip(input, actorUid) {
    return db.runTransaction(async (transaction) => {
      const actor = await getActor(transaction, actorUid);
      const trips = transaction.collection("trips");
      const current = one(await trips.doc(input.trip.id).get());
      if (!current) throw codedError("TRIP_NOT_FOUND");
      const tripId = input.tripId || input.trip.id;
      if (tripId !== input.trip.id) throw codedError("INVALID_TRIP");
      if (!ServerMemberUidsSchema.safeParse(current.memberUids).success) throw codedError("INVALID_TRIP");
      if (!current.memberUids.includes(actorUid)) throw codedError("FORBIDDEN");
      const parsed = TripSchema.safeParse(input.trip);
      if (!parsed.success) throw codedError("INVALID_TRIP");
      const idempotency = transaction.collection("trip_idempotency");
      const existing = one(await idempotency.doc(input.idempotencyKey).get());
      if (existing) {
        if (existing.actorUid !== actorUid || existing.tripId !== input.trip.id || !existing.trip || typeof existing.trip !== "object") throw codedError("IDEMPOTENCY_KEY_REUSED");
        const existingExpectedVersion = Number.isInteger(existing.expectedVersion) ? existing.expectedVersion : existing.trip?.version - 1;
        const priorRequest = existing.trip;
        if (existingExpectedVersion !== input.expectedVersion || canonicalTripRequest(priorRequest) !== canonicalTripRequest(parsed.data)) throw codedError("IDEMPOTENCY_KEY_REUSED");
        return { trip: existing.trip };
      }
      if (current.version !== input.expectedVersion) throw codedError("VERSION_CONFLICT", { currentVersion: current.version });
      const next = { ...parsed.data, memberUids: [...current.memberUids], version: current.version + 1 };
      if (next.version !== input.expectedVersion + 1) throw codedError("INVALID_TRIP");
      const memberUpdates = [];
      for (const uid of current.memberUids) {
        const member = readRecord(await transaction.collection("members").doc(uid).get());
        if (!member) throw codedError("MEMBER_NOT_FOUND");
        const tripIds = optionalAssociationIds(member.tripIds);
        if (!tripIds.includes(next.id)) tripIds.push(next.id);
        memberUpdates.push({ uid, value: { ...member, tripIds } });
      }
      await trips.doc(next.id).set(writableRecord(next));
      for (const update of memberUpdates) await transaction.collection("members").doc(update.uid).set(writableRecord(update.value));
      await idempotency.doc(input.idempotencyKey).set({ actorUid, tripId: next.id, expectedVersion: input.expectedVersion, trip: next, createdAt: now().toISOString() });
      await audit(transaction, actor, "saveTrip", undefined, ["trip"]);
      return { trip: next };
    });
  }

  async function getTrip(input, actorUid) {
    return db.runTransaction(async (transaction) => {
      await getActor(transaction, actorUid);
      const current = one(await transaction.collection("trips").doc(input.tripId).get());
      if (!current) throw codedError("TRIP_NOT_FOUND");
      if (!Array.isArray(current.memberUids) || !current.memberUids.includes(actorUid)) throw codedError("FORBIDDEN");
      const parsed = TripSchema.safeParse(current);
      if (!parsed.success) throw codedError("INVALID_TRIP");
      return { trip: writableRecord(parsed.data) };
    });
  }

  async function getCurrentMember(actorUid) {
    return db.runTransaction(async (transaction) => {
      const member = one(await transaction.collection("members").doc(actorUid).get());
      if (!member || member.role === "removed") throw codedError("MEMBERSHIP_REQUIRED");
      return { member: safeMember(member) };
    });
  }

  return {
    async execute(event, actorUid) {
      if (!actorUid || typeof actorUid !== "string") throw codedError("AUTH_REQUIRED");
      let input;
      try { input = ActionSchema.parse(event); } catch { throw codedError("INVALID_REQUEST"); }
      if (input.action === "listMembers") {
        const members = db.collection("members");
        const actor = one(await members.doc(actorUid).get());
        if (!actor || !["admin", "member"].includes(actor.role)) throw codedError("MEMBERSHIP_REQUIRED");
        if (actor.role !== "admin") throw codedError("ADMIN_REQUIRED");
        const result = await members.where({}).get();
        return { members: (result.data || []).map(safeMember) };
      }
      if (input.action === "getCurrentMember") return getCurrentMember(actorUid);
      if (input.action === "getTrip") return getTrip(input, actorUid);
      if (input.action === "saveTrip") return saveTrip(input, actorUid);
      return changeMember(input, actorUid);
    },
  };
}

module.exports = { createTripCommands, createCloudBaseSessionRevoker, codedError, safeMember, TripSchema };
