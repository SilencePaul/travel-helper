const { z } = require("zod");

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
  z.object({ action: z.literal("listMembers") }),
  z.object({ action: z.enum(["approveMember", "rejectMember", "removeMember"]), uid: z.string().min(4).max(32) }),
  z.object({ action: z.literal("saveTrip"), tripId: z.string().min(1).optional(), trip: TripSchema, expectedVersion: z.number().int().nonnegative(), idempotencyKey: z.string().min(8).max(128) }),
]);

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
  const { version, ...withoutServerVersion } = trip;
  return withoutServerVersion;
}
function safeMember(member) {
  if (!member) return undefined;
  const { uid, displayName, avatarUrl, role, version, createdAt, approvedAt } = member;
  return { uid, displayName, ...(avatarUrl ? { avatarUrl } : {}), role, version, createdAt, ...(approvedAt ? { approvedAt } : {}) };
}

function createTripCommands({ db, now = () => new Date() } = {}) {
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
      if (input.action === "removeMember" && target.role === "admin") {
        const admins = await members.where({ role: "admin" }).get();
        if ((admins.data || []).length <= 1) throw codedError("LAST_ADMIN");
      }
      const timestamp = now().toISOString();
      const role = input.action === "approveMember" ? "member" : "removed";
      const next = { ...target, role, version: (target.version || 0) + 1, ...(role === "member" ? { approvedAt: timestamp } : {}) };
      await members.doc(target.uid).set(next);
      await audit(transaction, actor, input.action, target.displayName, ["role", "version", ...(role === "member" ? ["approvedAt"] : [])]);
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
      if (Array.isArray(current.memberUids) && !current.memberUids.includes(actorUid)) throw codedError("FORBIDDEN");
      const idempotency = transaction.collection("trip_idempotency");
      const existing = one(await idempotency.doc(input.idempotencyKey).get());
      if (existing) {
        if (existing.actorUid !== actorUid || existing.tripId !== input.trip.id || !existing.trip || typeof existing.trip !== "object") throw codedError("IDEMPOTENCY_KEY_REUSED");
        const existingExpectedVersion = Number.isInteger(existing.expectedVersion) ? existing.expectedVersion : existing.trip?.version - 1;
        const priorRequest = existing.trip;
        if (existingExpectedVersion !== input.expectedVersion || canonical(requestTrip(priorRequest)) !== canonical(requestTrip(input.trip))) throw codedError("IDEMPOTENCY_KEY_REUSED");
        return { trip: existing.trip };
      }
      if (current.version !== input.expectedVersion) throw codedError("VERSION_CONFLICT", { currentVersion: current.version });
      const parsed = TripSchema.safeParse(input.trip);
      if (!parsed.success) throw codedError("INVALID_TRIP");
      const next = { ...parsed.data, version: current.version + 1 };
      if (next.version !== input.expectedVersion + 1) throw codedError("INVALID_TRIP");
      await trips.doc(next.id).set(next);
      await idempotency.doc(input.idempotencyKey).set({ actorUid, tripId: next.id, trip: next, createdAt: now().toISOString() });
      await audit(transaction, actor, "saveTrip", undefined, ["trip"]);
      return { trip: next };
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
      if (input.action === "saveTrip") return saveTrip(input, actorUid);
      return changeMember(input, actorUid);
    },
  };
}

module.exports = { createTripCommands, codedError, safeMember, TripSchema };
