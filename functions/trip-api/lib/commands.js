const { z } = require("zod");
const { randomUUID } = require("node:crypto");
const { createDecisionAgentBridge } = require("./decision-agent-bridge.js");
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
  z.object({ action: z.literal("getDecisionWorkspace"), tripId: z.string().min(1) }),
  z.object({ action: z.literal("getDecisionEvents"), tripId: z.string().min(1), afterCursor: z.number().int().nonnegative() }),
  z.object({ action: z.literal("upsertPreference"), tripId: z.string().min(1), expectedRevision: z.number().int().nonnegative(), idempotencyKey: z.string().min(8).max(128), answers: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.number(), z.boolean(), z.null()])), freeText: z.object({ mustHave: z.string().optional(), mustAvoid: z.string().optional(), note: z.string().optional() }).optional() }),
  z.object({ action: z.enum(["completePreference", "skipPreference"]), tripId: z.string().min(1), expectedRevision: z.number().int().nonnegative(), idempotencyKey: z.string().min(8).max(128) }),
  z.object({ action: z.literal("generatePreferenceSummary"), tripId: z.string().min(1), sourcePreferenceRevisions: z.record(z.string(), z.number().int().nonnegative()), idempotencyKey: z.string().min(8).max(128) }),
  z.object({ action: z.literal("recordFeedback"), tripId: z.string().min(1), candidateId: z.string().min(1), kind: z.enum(["like", "dislike", "comment"]), reason: z.string().max(2000).optional(), idempotencyKey: z.string().min(8).max(128) }),
  z.object({ action: z.literal("placeTentative"), tripId: z.string().min(1), candidateId: z.string().min(1), expectedCandidateRevision: z.number().int().nonnegative(), placement: z.object({ tripDayId: z.string().min(1), date: z.string().date(), sortKey: z.string().min(1) }), idempotencyKey: z.string().min(8).max(128) }),
  z.object({ action: z.literal("attachTentativeToLegacyTrip"), tripId: z.string().min(1), placementId: z.string().min(1), legacyItemId: z.string().min(1), expectedPlacementRevision: z.number().int().nonnegative(), expectedTripVersion: z.number().int().nonnegative(), idempotencyKey: z.string().min(8).max(128) }),
  z.object({ action: z.literal("detachTentativeFromLegacyTrip"), tripId: z.string().min(1), placementId: z.string().min(1), expectedPlacementRevision: z.number().int().nonnegative(), expectedTripVersion: z.number().int().nonnegative(), idempotencyKey: z.string().min(8).max(128) }),
  z.object({ action: z.literal("setConfirmationReceipt"), tripId: z.string().min(1), candidateId: z.string().min(1), expectedCandidateRevision: z.number().int().nonnegative(), active: z.boolean(), reason: z.string().max(2000).optional(), idempotencyKey: z.string().min(8).max(128) }),
  z.object({ action: z.literal("createAgentRun"), tripId: z.string().min(1), publicKeyJwk: z.object({ kty: z.literal("EC"), crv: z.literal("P-256"), x: z.string().min(1), y: z.string().min(1) }), pairingCodeHash: z.string().length(43), scope: z.array(z.enum(["submitProposalBatch", "appendEvidenceSnapshot", "reportVerificationBlocked", "generatePreferenceSummary"])).min(1).max(4), idempotencyKey: z.string().min(8).max(128) }),
  z.object({ action: z.literal("revokeAgentRun"), tripId: z.string().min(1), agentRunId: z.string().min(1), expectedRevision: z.number().int().nonnegative(), idempotencyKey: z.string().min(8).max(128) }),
  z.object({ action: z.literal("listMembers") }),
  z.object({ action: z.enum(["approveMember", "rejectMember", "removeMember"]), uid: z.string().min(4).max(32) }),
  z.object({ action: z.literal("saveTrip"), tripId: z.string().min(1).optional(), trip: TripSchema, expectedVersion: z.number().int().nonnegative(), idempotencyKey: z.string().min(8).max(128) }),
]);
const ServerMemberUidsSchema = z.array(z.string().min(4).max(64)).min(1);

const AgentDateRangeSchema = z.object({ start: z.string().date(), end: z.string().date() });
const AgentFactsSchema = z.union([
  z.object({ propertyName: z.string().min(1), address: z.string().min(1), checkInDate: z.string().date(), checkOutDate: z.string().date(), travelers: z.number().int().positive(), roomTypeOrBed: z.string().min(1), availability: z.enum(["available", "unavailable", "unknown"]), priceAmount: z.union([z.number().nonnegative(), z.literal("not_provided")]), currency: z.union([z.string().min(1), z.literal("not_provided")]), priceDisplay: z.enum(["total", "per_night", "per_person", "not_provided"]), cancellationPolicy: z.union([z.string().min(1), z.literal("not_provided")]) }),
  z.object({ name: z.string().min(1), address: z.string().min(1), openInformation: z.union([z.string().min(1), z.literal("not_provided")]), priceSnapshot: z.union([z.string().min(1), z.literal("not_provided")]), ticketType: z.union([z.string().min(1), z.literal("not_provided")]) }),
  z.object({ name: z.string().min(1), address: z.string().min(1), openInformation: z.union([z.string().min(1), z.literal("not_provided")]), priceSnapshot: z.union([z.string().min(1), z.literal("not_provided")]) }),
]);
const AgentEvidenceInputSchema = z.object({
  sourceKind: z.enum(["flyai", "amap", "web", "official", "manual"]),
  sourceName: z.string().min(1),
  sourceUrl: z.string().url().optional(),
  capturedAt: z.string().datetime(),
  queryContext: z.object({ dates: AgentDateRangeSchema.optional(), travelers: z.number().int().positive().optional(), roomOrTicket: z.string().optional() }),
  captureMethod: z.enum(["detail_page", "search_result", "api_result", "manual"]),
  facts: AgentFactsSchema,
  supersedesEvidenceId: z.string().min(1).optional(),
  changeReason: z.string().optional(),
});
const AgentProposalSchema = z.object({
  category: z.enum(["hotel", "restaurant", "attraction"]),
  entity: z.object({ name: z.string().min(1), address: z.string().optional(), latitude: z.number().optional(), longitude: z.number().optional() }),
  applicability: z.object({ dates: AgentDateRangeSchema.optional(), travelers: z.number().int().positive().optional() }),
  recommendation: z.object({ round: z.number().int().positive(), reason: z.string().min(1), preferenceRevisionIds: z.array(z.string()), feedbackIds: z.array(z.string()) }),
  evidence: z.array(AgentEvidenceInputSchema).min(1),
});
const AgentApiSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("claimAgentRun"), agentRunId: z.string().min(1), pairingCode: z.string().min(1), clientNonce: z.string().min(8), signature: z.string().min(1) }),
  z.object({ action: z.literal("submitProposalBatch"), agentRunId: z.string().min(1), sequence: z.number().int().positive(), idempotencyKey: z.string().min(8).max(128), signature: z.string().min(1), payload: z.object({ round: z.number().int().positive(), candidates: z.array(AgentProposalSchema).min(2).max(4) }) }),
  z.object({ action: z.literal("appendEvidenceSnapshot"), agentRunId: z.string().min(1), sequence: z.number().int().positive(), idempotencyKey: z.string().min(8).max(128), signature: z.string().min(1), payload: z.object({ candidateId: z.string().min(1), expectedCandidateRevision: z.number().int().nonnegative(), evidence: AgentEvidenceInputSchema }) }),
  z.object({ action: z.literal("reportVerificationBlocked"), agentRunId: z.string().min(1), sequence: z.number().int().positive(), idempotencyKey: z.string().min(8).max(128), signature: z.string().min(1), payload: z.object({ candidateId: z.string().min(1), expectedCandidateRevision: z.number().int().nonnegative(), reason: z.enum(["login", "captcha", "risk_control", "load_failed", "field_missing"]) }) }),
  z.object({ action: z.literal("generatePreferenceSummary"), agentRunId: z.string().min(1), sequence: z.number().int().positive(), idempotencyKey: z.string().min(8).max(128), signature: z.string().min(1), payload: z.object({ sourcePreferenceRevisions: z.record(z.string(), z.number().int().nonnegative()) }) }),
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

function createTripCommands({ db, now = () => new Date(), randomId = randomUUID, sessionRevoker = createCloudBaseSessionRevoker(), agentBridge } = {}) {
  if (!db || typeof db.runTransaction !== "function") throw codedError("CLOUDBASE_TRANSACTION_UNAVAILABLE");
  const effectiveAgentBridge = agentBridge || createDecisionAgentBridge({ now });

  async function getActor(transaction, uid) {
    const actor = one(await transaction.collection("members").doc(uid).get());
    if (!actor || !["admin", "member"].includes(actor.role)) throw codedError("MEMBERSHIP_REQUIRED");
    return actor;
  }

  async function audit(transaction, actor, action, targetName, changedFields = []) {
    const timestamp = now().toISOString();
    await transaction.collection("trip_audits").add({ actorUid: actor.uid, actorName: actor.displayName, action, ...(targetName ? { targetName } : {}), changedFields, createdAt: timestamp });
  }

  async function decisionAudit(transaction, { tripId, targetType, targetId, command, actorType, actorUid, agentRunId, beforeRevision, afterRevision, reason, changedFields = [] }) {
    await transaction.collection("trip_decision_audits").add({
      tripId,
      targetType,
      targetId,
      command,
      actorType,
      ...(actorUid ? { actorUid } : {}),
      ...(agentRunId ? { agentRunId } : {}),
      ...(Number.isInteger(beforeRevision) ? { beforeRevision } : {}),
      ...(Number.isInteger(afterRevision) ? { afterRevision } : {}),
      ...(reason ? { reason } : {}),
      changedFields,
      createdAt: now().toISOString(),
    });
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
      const candidateUpdates = [];
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
          const decisionIndex = readRecord(await transaction.collection("trip_decision_indexes").doc(tripId).get());
          for (const candidateId of decisionIndex?.candidateIds || []) {
            const candidate = readRecord(await transaction.collection("trip_candidates").doc(candidateId).get());
            if (candidate?.tripId === tripId && candidate.decisionState === "confirmed") {
              candidateUpdates.push({
                beforeRevision: candidate.revision,
                value: { ...candidate, decisionState: "tentative", revision: candidate.revision + 1, updatedAt: timestamp },
              });
            }
          }
        }
        if (typeof sessionRevoker.prepareSessionsForUid === "function") {
          await sessionRevoker.prepareSessionsForUid(transaction, target.uid, sessionIds, timestamp);
        }
      }
      const next = { ...target, role, tripIds, sessionIds, version: (target.version || 0) + 1, ...(role === "member" ? { approvedAt: timestamp } : {}) };
      await members.doc(target.uid).set(writableRecord(next));
      for (const update of tripUpdates) await transaction.collection("trips").doc(update.id).set(writableRecord(update.value));
      for (const update of candidateUpdates) {
        await transaction.collection("trip_candidates").doc(update.value.id).set(writableRecord(update.value));
        await recordDecisionEvent(transaction, update.value.tripId, "candidate", update.value);
        await decisionAudit(transaction, { tripId: update.value.tripId, targetType: "candidate", targetId: update.value.id, command: input.action, actorType: "member", actorUid, beforeRevision: update.beforeRevision, afterRevision: update.value.revision, changedFields: ["decisionState", "revision"] });
      }
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

  async function assertTripMember(transaction, tripId, actorUid) {
    await getActor(transaction, actorUid);
    const current = one(await transaction.collection("trips").doc(tripId).get());
    if (!current) throw codedError("TRIP_NOT_FOUND");
    if (!Array.isArray(current.memberUids) || !current.memberUids.includes(actorUid)) throw codedError("FORBIDDEN");
    return current;
  }

  async function getDecisionWorkspace(input, actorUid) {
    return db.runTransaction(async (transaction) => {
      const trip = await assertTripMember(transaction, input.tripId, actorUid);
      const preferences = transaction.collection("trip_preferences");
      const records = [];
      for (const uid of trip.memberUids) {
        const record = one(await preferences.doc(`${input.tripId}:${uid}`).get());
        if (record) records.push(record);
      }
      const index = one(await transaction.collection("trip_decision_indexes").doc(input.tripId).get()) || {};
      async function loadIndexed(collectionName, ids = []) {
        const values = [];
        for (const id of ids) {
          const value = one(await transaction.collection(collectionName).doc(id).get());
          if (value && !value.deletedAt) values.push(writableRecord(value));
        }
        return values;
      }
      const summary = one(await transaction.collection("trip_preference_summaries").doc(input.tripId).get());
      const meta = one(await transaction.collection("trip_decision_meta").doc(input.tripId).get());
      return {
        tripId: input.tripId,
        preferences: records.map(writableRecord),
        ...(summary && !summary.deletedAt ? { summary: writableRecord(summary) } : {}),
        candidates: await loadIndexed("trip_candidates", index.candidateIds),
        evidence: await loadIndexed("trip_evidence_snapshots", index.evidenceIds),
        feedback: await loadIndexed("trip_candidate_feedback", index.feedbackIds),
        placements: await loadIndexed("trip_tentative_placements", index.placementIds),
        confirmations: await loadIndexed("trip_confirmation_receipts", index.confirmationIds),
        workspaceCursor: String((meta?.nextSequence || 1) - 1),
        fetchedAt: now().toISOString(),
      };
    });
  }

  async function getDecisionEvents(input, actorUid) {
    return db.runTransaction(async (transaction) => {
      await assertTripMember(transaction, input.tripId, actorUid);
      const meta = one(await transaction.collection("trip_decision_meta").doc(input.tripId).get());
      const cursor = (meta?.nextSequence || 1) - 1;
      const events = [];
      for (let sequence = input.afterCursor + 1; sequence <= cursor; sequence += 1) {
        const event = one(await transaction.collection("trip_decision_events").doc(`${input.tripId}:${String(sequence).padStart(12, "0")}`).get());
        if (!event) throw codedError("CURSOR_EXPIRED");
        events.push(writableRecord(event));
      }
      return { events, cursor };
    });
  }

  const decisionIndexFields = {
    candidate: "candidateIds",
    evidence: "evidenceIds",
    feedback: "feedbackIds",
    placement: "placementIds",
    confirmation: "confirmationIds",
  };

  async function indexDecisionResource(transaction, tripId, resourceType, resourceId) {
    const field = decisionIndexFields[resourceType];
    if (!field) return;
    const indexes = transaction.collection("trip_decision_indexes");
    const current = one(await indexes.doc(tripId).get()) || { tripId };
    const ids = Array.isArray(current[field]) ? current[field] : [];
    if (ids.includes(resourceId)) return;
    await indexes.doc(tripId).set({ ...current, [field]: [...ids, resourceId] });
  }

  async function recordDecisionEvent(transaction, tripId, resourceType, resource, operation = "upsert") {
    await indexDecisionResource(transaction, tripId, resourceType, resource.id);
    const metas = transaction.collection("trip_decision_meta");
    const meta = one(await metas.doc(tripId).get()) || { tripId, nextSequence: 1 };
    const sequence = meta.nextSequence;
    const event = {
      tripId,
      sequence,
      resourceType,
      resourceId: resource.id,
      revision: resource.revision,
      operation,
      occurredAt: now().toISOString(),
      resource: writableRecord(resource),
    };
    await transaction.collection("trip_decision_events").doc(`${tripId}:${String(sequence).padStart(12, "0")}`).set(event);
    await metas.doc(tripId).set({ ...meta, nextSequence: sequence + 1 });
  }

  async function markSharedSummaryOutdated(transaction, tripId, timestamp) {
    const summaries = transaction.collection("trip_preference_summaries");
    const current = one(await summaries.doc(tripId).get());
    if (!current || current.status === "outdated") return undefined;
    const summary = {
      ...current,
      status: "outdated",
      revision: (current.revision || 0) + 1,
      updatedAt: timestamp,
    };
    await summaries.doc(tripId).set(summary);
    return summary;
  }

  async function upsertPreference(input, actorUid) {
    return db.runTransaction(async (transaction) => {
      await assertTripMember(transaction, input.tripId, actorUid);
      return runIdempotentDecision(transaction, input, actorUid, async () => {
        const preferences = transaction.collection("trip_preferences");
        const id = `${input.tripId}:${actorUid}`;
        const current = one(await preferences.doc(id).get());
        const revision = current?.revision || 0;
        if (revision !== input.expectedRevision) throw codedError("VERSION_CONFLICT", { currentVersion: revision, latest: current && writableRecord(current) });
        const timestamp = now().toISOString();
        const preference = { id, tripId: input.tripId, ownerUid: actorUid, answers: input.answers, ...(input.freeText ? { freeText: input.freeText } : {}), status: current?.status || "editing", revision: revision + 1, updatedAt: timestamp, updatedBy: actorUid };
        await preferences.doc(id).set(preference);
        const outdatedSummary = await markSharedSummaryOutdated(transaction, input.tripId, timestamp);
        await recordDecisionEvent(transaction, input.tripId, "preference", preference);
        if (outdatedSummary) await recordDecisionEvent(transaction, input.tripId, "summary", outdatedSummary);
        await decisionAudit(transaction, { tripId: input.tripId, targetType: "preference", targetId: id, command: input.action, actorType: "member", actorUid, beforeRevision: revision, afterRevision: preference.revision, changedFields: ["answers", "freeText", "revision"] });
        return { preference };
      });
    });
  }

  async function runIdempotentDecision(transaction, input, actorUid, operation) {
    const idempotency = transaction.collection("trip_decision_idempotency");
    const id = `${actorUid}:${input.action}:${input.idempotencyKey}`;
    const request = canonical(input);
    const prior = one(await idempotency.doc(id).get());
    if (prior) {
      if (prior.actorUid !== actorUid || prior.action !== input.action || prior.request !== request) {
        throw codedError("IDEMPOTENCY_KEY_REUSED");
      }
      return prior.result;
    }
    const result = await operation();
    await idempotency.doc(id).set({ actorUid, action: input.action, request, result, createdAt: now().toISOString() });
    return result;
  }

  async function setPreferenceStatus(input, actorUid) {
    return db.runTransaction(async (transaction) => {
      await assertTripMember(transaction, input.tripId, actorUid);
      return runIdempotentDecision(transaction, input, actorUid, async () => {
        const preferences = transaction.collection("trip_preferences");
        const id = `${input.tripId}:${actorUid}`;
        const current = one(await preferences.doc(id).get());
        if (!current || current.revision !== input.expectedRevision) {
          throw codedError("VERSION_CONFLICT", {
            currentVersion: current?.revision || 0,
            latest: current && writableRecord(current),
          });
        }
        const preference = {
          ...current,
          status: input.action === "completePreference" ? "completed" : "skipped",
          revision: current.revision + 1,
          updatedAt: now().toISOString(),
          updatedBy: actorUid,
        };
        await preferences.doc(id).set(preference);
        const outdatedSummary = await markSharedSummaryOutdated(transaction, input.tripId, preference.updatedAt);
        await recordDecisionEvent(transaction, input.tripId, "preference", preference);
        if (outdatedSummary) await recordDecisionEvent(transaction, input.tripId, "summary", outdatedSummary);
        await decisionAudit(transaction, { tripId: input.tripId, targetType: "preference", targetId: id, command: input.action, actorType: "member", actorUid, beforeRevision: current.revision, afterRevision: preference.revision, changedFields: ["status", "revision"] });
        return { preference };
      });
    });
  }

  async function buildSharedPreferenceSummary(transaction, trip, sourcePreferenceRevisions) {
    if (trip.memberUids.length !== 2
      || Object.keys(sourcePreferenceRevisions).length !== 2
      || trip.memberUids.some((uid) => !Object.hasOwn(sourcePreferenceRevisions, uid))) {
      throw codedError("SUMMARY_NOT_READY");
    }
    const profiles = [];
    for (const uid of trip.memberUids) {
      const profile = one(await transaction.collection("trip_preferences").doc(`${trip.id}:${uid}`).get());
      if (!profile || !["completed", "skipped"].includes(profile.status) || profile.revision !== sourcePreferenceRevisions[uid]) {
        throw codedError("SUMMARY_NOT_READY");
      }
      profiles.push(profile);
    }
    const answerKeys = [...new Set(profiles.flatMap((profile) => Object.keys(profile.answers)))].sort();
    const common = [];
    const disagreements = [];
    for (const key of answerKeys) {
      const values = profiles.map((profile) => profile.answers[key]);
      if (canonical(values[0]) === canonical(values[1])) common.push(`${key}: ${canonical(values[0])}`);
      else disagreements.push(`${key}: ${trip.memberUids.map((uid, index) => `${uid}=${canonical(values[index])}`).join("; ")}`);
    }
    const summaries = transaction.collection("trip_preference_summaries");
    const current = one(await summaries.doc(trip.id).get());
    const timestamp = now().toISOString();
    const summary = {
      id: trip.id,
      tripId: trip.id,
      sourcePreferenceRevisions,
      common,
      disagreements,
      tradeoffs: disagreements.map((entry) => `共同决定：${entry}`),
      status: "ready",
      generatedAt: timestamp,
      revision: (current?.revision || 0) + 1,
      updatedAt: timestamp,
    };
    await summaries.doc(trip.id).set(summary);
    await recordDecisionEvent(transaction, trip.id, "summary", summary);
    return summary;
  }

  async function generateMemberPreferenceSummary(input, actorUid) {
    return db.runTransaction(async (transaction) => {
      const trip = await assertTripMember(transaction, input.tripId, actorUid);
      return runIdempotentDecision(transaction, input, actorUid, async () => {
        const summary = await buildSharedPreferenceSummary(transaction, trip, input.sourcePreferenceRevisions);
        await decisionAudit(transaction, { tripId: input.tripId, targetType: "summary", targetId: summary.id, command: input.action, actorType: "member", actorUid, beforeRevision: summary.revision - 1, afterRevision: summary.revision, changedFields: ["summary", "revision"] });
        return { summary };
      });
    });
  }

  async function setConfirmationReceipt(input, actorUid) {
    return db.runTransaction(async (transaction) => {
      const trip = await assertTripMember(transaction, input.tripId, actorUid);
      return runIdempotentDecision(transaction, input, actorUid, async () => {
        const candidates = transaction.collection("trip_candidates");
        const current = one(await candidates.doc(input.candidateId).get());
        if (!current || current.tripId !== input.tripId) throw codedError("FORBIDDEN");
        if (current.revision !== input.expectedCandidateRevision) {
          throw codedError("VERSION_CONFLICT", { currentVersion: current.revision, latest: writableRecord(current) });
        }
        if (input.active && current.decisionState !== "tentative") throw codedError("INVALID_CONFIRMATION_STATE");

        const receipts = transaction.collection("trip_confirmation_receipts");
        const receiptId = `${input.tripId}:${input.candidateId}:${actorUid}`;
        const previousReceipt = one(await receipts.doc(receiptId).get());
        if (input.active) {
          const placement = one(await transaction.collection("trip_tentative_placements").doc(`${input.tripId}:${input.candidateId}`).get());
          if (!placement || placement.candidateId !== input.candidateId || !["planned", "linked"].includes(placement.status) || previousReceipt?.active) {
            throw codedError("INVALID_CONFIRMATION_STATE");
          }
        }
        if (!input.active && !previousReceipt?.active) throw codedError("INVALID_CONFIRMATION_STATE");
        const timestamp = now().toISOString();
        const receipt = {
          id: receiptId,
          tripId: input.tripId,
          candidateId: input.candidateId,
          memberUid: actorUid,
          active: input.active,
          ...(input.reason ? { reason: input.reason } : {}),
          revision: (previousReceipt?.revision || 0) + 1,
          actedAt: timestamp,
          updatedAt: timestamp,
        };
        await receipts.doc(receiptId).set(receipt);

        const activeReceipts = [];
        for (const memberUid of trip.memberUids) {
          if (memberUid === actorUid) activeReceipts.push(receipt);
          else activeReceipts.push(one(await receipts.doc(`${input.tripId}:${input.candidateId}:${memberUid}`).get()));
        }
        const confirmed = trip.memberUids.length === 2 && activeReceipts.every((candidateReceipt) => candidateReceipt?.active === true);
        const candidate = {
          ...current,
          decisionState: confirmed ? "confirmed" : "tentative",
          revision: current.revision + 1,
          updatedAt: timestamp,
        };
        await candidates.doc(candidate.id).set(candidate);
        await recordDecisionEvent(transaction, input.tripId, "confirmation", receipt);
        await recordDecisionEvent(transaction, input.tripId, "candidate", candidate);
        await decisionAudit(transaction, { tripId: input.tripId, targetType: "confirmation", targetId: receipt.id, command: input.action, actorType: "member", actorUid, beforeRevision: previousReceipt?.revision || 0, afterRevision: receipt.revision, reason: input.reason, changedFields: ["active", "decisionState", "revision"] });
        return { receipt, candidate };
      });
    });
  }

  async function recordFeedback(input, actorUid) {
    return db.runTransaction(async (transaction) => {
      await assertTripMember(transaction, input.tripId, actorUid);
      return runIdempotentDecision(transaction, input, actorUid, async () => {
        const candidate = one(await transaction.collection("trip_candidates").doc(input.candidateId).get());
        if (!candidate || candidate.tripId !== input.tripId) throw codedError("FORBIDDEN");
        const timestamp = now().toISOString();
        const feedback = {
          id: `${input.tripId}:${input.candidateId}:${actorUid}:${input.idempotencyKey}`,
          tripId: input.tripId,
          candidateId: input.candidateId,
          actorUid,
          kind: input.kind,
          ...(input.reason ? { reason: input.reason } : {}),
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        await transaction.collection("trip_candidate_feedback").doc(feedback.id).set(feedback);
        await indexDecisionResource(transaction, input.tripId, "candidate", candidate.id);
        await recordDecisionEvent(transaction, input.tripId, "feedback", feedback);
        await decisionAudit(transaction, { tripId: input.tripId, targetType: "feedback", targetId: feedback.id, command: input.action, actorType: "member", actorUid, afterRevision: feedback.revision, reason: input.reason, changedFields: ["feedback"] });
        return { feedback };
      });
    });
  }

  async function placeTentative(input, actorUid) {
    return db.runTransaction(async (transaction) => {
      const trip = await assertTripMember(transaction, input.tripId, actorUid);
      return runIdempotentDecision(transaction, input, actorUid, async () => {
        const day = trip.days.find((candidateDay) => candidateDay.id === input.placement.tripDayId);
        if (!day || day.date !== input.placement.date) throw codedError("INVALID_PLACEMENT");
        const candidates = transaction.collection("trip_candidates");
        const current = one(await candidates.doc(input.candidateId).get());
        if (!current || current.tripId !== input.tripId) throw codedError("FORBIDDEN");
        if (current.revision !== input.expectedCandidateRevision) {
          throw codedError("VERSION_CONFLICT", { currentVersion: current.revision, latest: writableRecord(current) });
        }
        if (current.decisionState === "confirmed") throw codedError("INVALID_PLACEMENT_STATE");

        const placements = transaction.collection("trip_tentative_placements");
        const placementId = `${input.tripId}:${input.candidateId}`;
        const previousPlacement = one(await placements.doc(placementId).get());
        const timestamp = now().toISOString();
        const placement = {
          id: placementId,
          tripId: input.tripId,
          candidateId: input.candidateId,
          ...input.placement,
          status: "planned",
          revision: (previousPlacement?.revision || 0) + 1,
          updatedAt: timestamp,
        };
        const candidate = {
          ...current,
          decisionState: "tentative",
          revision: current.revision + 1,
          updatedAt: timestamp,
        };
        await placements.doc(placement.id).set(placement);
        await candidates.doc(candidate.id).set(candidate);
        await recordDecisionEvent(transaction, input.tripId, "placement", placement);
        await recordDecisionEvent(transaction, input.tripId, "candidate", candidate);
        await decisionAudit(transaction, { tripId: input.tripId, targetType: "placement", targetId: placement.id, command: input.action, actorType: "member", actorUid, beforeRevision: previousPlacement?.revision || 0, afterRevision: placement.revision, changedFields: ["placement", "decisionState", "revision"] });
        return { placement, candidate };
      });
    });
  }

  async function changeLegacyPlacement(input, actorUid) {
    return db.runTransaction(async (transaction) => {
      const trip = await assertTripMember(transaction, input.tripId, actorUid);
      return runIdempotentDecision(transaction, input, actorUid, async () => {
        const placements = transaction.collection("trip_tentative_placements");
        const currentPlacement = one(await placements.doc(input.placementId).get());
        if (!currentPlacement || currentPlacement.tripId !== input.tripId) throw codedError("INVALID_PLACEMENT");
        if (currentPlacement.revision !== input.expectedPlacementRevision) {
          throw codedError("VERSION_CONFLICT", { currentVersion: currentPlacement.revision, latest: writableRecord(currentPlacement) });
        }
        if (trip.version !== input.expectedTripVersion) {
          throw codedError("VERSION_CONFLICT", { currentVersion: trip.version, latest: { tripVersion: trip.version, trip: writableRecord(trip) } });
        }
        const dayIndex = trip.days.findIndex((day) => day.id === currentPlacement.tripDayId && day.date === currentPlacement.date);
        if (dayIndex < 0) throw codedError("INVALID_PLACEMENT");
        const timestamp = now().toISOString();
        const nextDays = trip.days.map((day) => ({ ...day, itemIds: [...day.itemIds] }));
        let placement;
        if (input.action === "attachTentativeToLegacyTrip") {
          if (currentPlacement.status !== "planned" || trip.days.some((day) => day.itemIds.includes(input.legacyItemId))) {
            throw codedError("INVALID_PLACEMENT_STATE");
          }
          nextDays[dayIndex].itemIds.push(input.legacyItemId);
          placement = {
            ...currentPlacement,
            status: "linked",
            legacyTripItemId: input.legacyItemId,
            revision: currentPlacement.revision + 1,
            updatedAt: timestamp,
          };
        } else {
          if (currentPlacement.status !== "linked" || !currentPlacement.legacyTripItemId) throw codedError("INVALID_PLACEMENT_STATE");
          const matches = nextDays[dayIndex].itemIds.filter((id) => id === currentPlacement.legacyTripItemId).length;
          if (matches !== 1) throw codedError("INVALID_PLACEMENT_STATE");
          nextDays[dayIndex].itemIds = nextDays[dayIndex].itemIds.filter((id) => id !== currentPlacement.legacyTripItemId);
          placement = {
            ...currentPlacement,
            status: "detached",
            revision: currentPlacement.revision + 1,
            updatedAt: timestamp,
          };
        }
        const nextTrip = { ...trip, days: nextDays, version: trip.version + 1 };
        const candidates = transaction.collection("trip_candidates");
        const currentCandidate = one(await candidates.doc(currentPlacement.candidateId).get());
        if (!currentCandidate || currentCandidate.tripId !== input.tripId) throw codedError("INVALID_PLACEMENT");
        const candidate = input.action === "detachTentativeFromLegacyTrip" && currentCandidate.decisionState === "confirmed"
          ? { ...currentCandidate, decisionState: "tentative", revision: currentCandidate.revision + 1, updatedAt: timestamp }
          : undefined;
        await placements.doc(placement.id).set(placement);
        await transaction.collection("trips").doc(input.tripId).set(writableRecord(nextTrip));
        if (candidate) await candidates.doc(candidate.id).set(candidate);
        await recordDecisionEvent(transaction, input.tripId, "placement", placement);
        if (candidate) await recordDecisionEvent(transaction, input.tripId, "candidate", candidate);
        await decisionAudit(transaction, { tripId: input.tripId, targetType: "placement", targetId: input.placementId, command: input.action, actorType: "member", actorUid, beforeRevision: currentPlacement.revision, afterRevision: placement.revision, changedFields: ["placement", "trip", "revision"] });
        return { placement, tripVersion: nextTrip.version };
      });
    });
  }

  async function changeAgentRun(input, actorUid) {
    return db.runTransaction(async (transaction) => {
      await assertTripMember(transaction, input.tripId, actorUid);
      return runIdempotentDecision(transaction, input, actorUid, async () => {
        const runs = transaction.collection("trip_agent_runs");
        const timestamp = now();
        if (input.action === "createAgentRun") {
          if (new Set(input.scope).size !== input.scope.length) throw codedError("INVALID_REQUEST");
          const id = randomId();
          if (one(await runs.doc(id).get())) throw codedError("INVALID_REQUEST");
          const expiresAt = new Date(timestamp.getTime() + 15 * 60 * 1000).toISOString();
          await runs.doc(id).set({
            id,
            tripId: input.tripId,
            creatorUid: actorUid,
            publicKeyJwk: input.publicKeyJwk,
            pairingCodeHash: input.pairingCodeHash,
            scope: input.scope,
            status: "pending_claim",
            lastSequence: 0,
            revision: 1,
            createdAt: timestamp.toISOString(),
            expiresAt,
          });
          await decisionAudit(transaction, { tripId: input.tripId, targetType: "agentRun", targetId: id, command: input.action, actorType: "member", actorUid, afterRevision: 1, changedFields: ["status", "scope", "expiresAt"] });
          return { agentRunId: id, expiresAt };
        }
        const run = one(await runs.doc(input.agentRunId).get());
        if (!run || run.tripId !== input.tripId) throw codedError("FORBIDDEN");
        if (run.revision !== input.expectedRevision) throw codedError("VERSION_CONFLICT", { currentVersion: run.revision });
        if (run.status === "revoked") throw codedError("INVALID_AGENT_CLAIM");
        const revokedAt = timestamp.toISOString();
        await runs.doc(run.id).set({ ...run, status: "revoked", revokedAt, revision: run.revision + 1 });
        await decisionAudit(transaction, { tripId: input.tripId, targetType: "agentRun", targetId: run.id, command: input.action, actorType: "member", actorUid, beforeRevision: run.revision, afterRevision: run.revision + 1, changedFields: ["status", "revision"] });
        return { agentRunId: run.id, revokedAt };
      });
    });
  }

  async function submitProposalBatch(transaction, input, run) {
    await assertTripMember(transaction, run.tripId, run.creatorUid);
    const timestamp = now().toISOString();
    const prepared = [];
    for (const proposal of input.payload.candidates) {
      if (proposal.recommendation.round !== input.payload.round) throw codedError("INVALID_REQUEST");
      const candidateId = randomId();
      if (!candidateId || one(await transaction.collection("trip_candidates").doc(candidateId).get())) throw codedError("INVALID_REQUEST");
      const evidence = [];
      for (const evidenceInput of proposal.evidence) {
        const evidenceId = randomId();
        if (!evidenceId || one(await transaction.collection("trip_evidence_snapshots").doc(evidenceId).get())) throw codedError("INVALID_REQUEST");
        evidence.push({
          id: evidenceId,
          tripId: run.tripId,
          candidateId,
          ...evidenceInput,
          fieldCompleteness: Object.keys(evidenceInput.facts),
          verificationOutcome: "candidate",
          revision: 1,
          updatedAt: timestamp,
        });
      }
      prepared.push({
        candidate: {
          id: candidateId,
          tripId: run.tripId,
          category: proposal.category,
          entity: proposal.entity,
          applicability: proposal.applicability,
          recommendation: proposal.recommendation,
          verificationState: "candidate",
          decisionState: "none",
          currentEvidenceId: evidence.at(-1).id,
          revision: 1,
          updatedAt: timestamp,
        },
        evidence,
      });
    }
    for (const item of prepared) {
      for (const evidence of item.evidence) {
        await transaction.collection("trip_evidence_snapshots").doc(evidence.id).set(evidence);
        await recordDecisionEvent(transaction, run.tripId, "evidence", evidence);
      }
      await transaction.collection("trip_candidates").doc(item.candidate.id).set(item.candidate);
      await recordDecisionEvent(transaction, run.tripId, "candidate", item.candidate);
    }
    await transaction.collection("trip_decision_audits").add({
      tripId: run.tripId,
      targetType: "candidate",
      targetId: prepared.map(({ candidate }) => candidate.id).join(","),
      command: input.action,
      actorType: "agent",
      agentRunId: run.id,
      createdAt: timestamp,
    });
    return { candidates: prepared.map(({ candidate }) => candidate) };
  }

  function hasExactKeys(value, expected) {
    const actual = Object.keys(value).sort();
    return actual.length === expected.length && expected.every((key, index) => key === actual[index]);
  }

  function isWebVerifiedEvidence(candidate, evidence) {
    const capturedAge = now().getTime() - new Date(evidence.capturedAt).getTime();
    if (!["web", "official"].includes(evidence.sourceKind)
      || !evidence.sourceUrl
      || evidence.captureMethod !== "detail_page"
      || capturedAge < 0
      || capturedAge > 24 * 60 * 60 * 1000
      || canonical(evidence.queryContext.dates) !== canonical(candidate.applicability.dates)
      || evidence.queryContext.travelers !== candidate.applicability.travelers) return false;
    const requiredKeys = {
      hotel: ["address", "availability", "cancellationPolicy", "checkInDate", "checkOutDate", "currency", "priceAmount", "priceDisplay", "propertyName", "roomTypeOrBed", "travelers"],
      restaurant: ["address", "name", "openInformation", "priceSnapshot"],
      attraction: ["address", "name", "openInformation", "priceSnapshot", "ticketType"],
    }[candidate.category];
    if (!requiredKeys || !hasExactKeys(evidence.facts, requiredKeys)) return false;
    if (candidate.category === "hotel") {
      return evidence.facts.checkInDate === candidate.applicability.dates?.start
        && evidence.facts.checkOutDate === candidate.applicability.dates?.end
        && evidence.facts.travelers === candidate.applicability.travelers;
    }
    return true;
  }

  async function appendAgentEvidence(transaction, input, run) {
    await assertTripMember(transaction, run.tripId, run.creatorUid);
    const candidates = transaction.collection("trip_candidates");
    const current = one(await candidates.doc(input.payload.candidateId).get());
    if (!current || current.tripId !== run.tripId) throw codedError("FORBIDDEN");
    if (current.revision !== input.payload.expectedCandidateRevision) {
      throw codedError("VERSION_CONFLICT", { currentVersion: current.revision, latest: writableRecord(current) });
    }
    if (input.payload.evidence.supersedesEvidenceId) {
      const previous = one(await transaction.collection("trip_evidence_snapshots").doc(input.payload.evidence.supersedesEvidenceId).get());
      if (!previous || previous.candidateId !== current.id) throw codedError("INVALID_REQUEST");
    }
    const evidenceId = randomId();
    if (!evidenceId || one(await transaction.collection("trip_evidence_snapshots").doc(evidenceId).get())) throw codedError("INVALID_REQUEST");
    const timestamp = now().toISOString();
    const webVerified = isWebVerifiedEvidence(current, input.payload.evidence);
    const changedSincePrevious = Boolean(
      input.payload.evidence.supersedesEvidenceId && input.payload.evidence.changeReason,
    );
    const verificationState = webVerified ? "web_verified" : changedSincePrevious ? "stale" : "candidate";
    const evidence = {
      id: evidenceId,
      tripId: run.tripId,
      candidateId: current.id,
      ...input.payload.evidence,
      fieldCompleteness: Object.keys(input.payload.evidence.facts),
      verificationOutcome: verificationState,
      revision: 1,
      updatedAt: timestamp,
    };
    const candidate = {
      ...current,
      currentEvidenceId: evidence.id,
      verificationState,
      revision: current.revision + 1,
      updatedAt: timestamp,
    };
    await transaction.collection("trip_evidence_snapshots").doc(evidence.id).set(evidence);
    await candidates.doc(candidate.id).set(candidate);
    await recordDecisionEvent(transaction, run.tripId, "evidence", evidence);
    await recordDecisionEvent(transaction, run.tripId, "candidate", candidate);
    await transaction.collection("trip_decision_audits").add({ tripId: run.tripId, targetType: "candidate", targetId: candidate.id, command: input.action, actorType: "agent", agentRunId: run.id, beforeRevision: current.revision, afterRevision: candidate.revision, createdAt: timestamp });
    return { evidence, candidate, ...(webVerified ? {} : { warning: "VERIFICATION_INCOMPLETE" }) };
  }

  async function reportAgentVerificationBlocked(transaction, input, run) {
    await assertTripMember(transaction, run.tripId, run.creatorUid);
    const candidates = transaction.collection("trip_candidates");
    const current = one(await candidates.doc(input.payload.candidateId).get());
    if (!current || current.tripId !== run.tripId) throw codedError("FORBIDDEN");
    if (current.revision !== input.payload.expectedCandidateRevision) {
      throw codedError("VERSION_CONFLICT", { currentVersion: current.revision, latest: writableRecord(current) });
    }
    const timestamp = now().toISOString();
    const candidate = {
      ...current,
      verificationState: "needs_takeover",
      changeReason: input.payload.reason,
      revision: current.revision + 1,
      updatedAt: timestamp,
    };
    await candidates.doc(candidate.id).set(candidate);
    await recordDecisionEvent(transaction, run.tripId, "candidate", candidate);
    await transaction.collection("trip_decision_audits").add({ tripId: run.tripId, targetType: "candidate", targetId: candidate.id, command: input.action, actorType: "agent", agentRunId: run.id, beforeRevision: current.revision, afterRevision: candidate.revision, reason: input.payload.reason, createdAt: timestamp });
    return { candidate };
  }

  async function generateAgentPreferenceSummary(transaction, input, run) {
    const trip = await assertTripMember(transaction, run.tripId, run.creatorUid);
    const summary = await buildSharedPreferenceSummary(transaction, trip, input.payload.sourcePreferenceRevisions);
    await decisionAudit(transaction, { tripId: run.tripId, targetType: "summary", targetId: summary.id, command: input.action, actorType: "agent", agentRunId: run.id, beforeRevision: summary.revision - 1, afterRevision: summary.revision, changedFields: ["summary", "revision"] });
    return { summary };
  }

  async function getCurrentMember(actorUid) {
    return db.runTransaction(async (transaction) => {
      const member = one(await transaction.collection("members").doc(actorUid).get());
      if (!member || member.role === "removed") throw codedError("MEMBERSHIP_REQUIRED");
      return { member: safeMember(member) };
    });
  }

  return {
    async executeAgent(event) {
      let input;
      try { input = AgentApiSchema.parse(event); } catch { throw codedError("INVALID_REQUEST"); }
      if (input.action === "claimAgentRun") {
        return db.runTransaction(async (transaction) => {
          const run = one(await transaction.collection("trip_agent_runs").doc(input.agentRunId).get());
          if (run) await assertTripMember(transaction, run.tripId, run.creatorUid);
          return effectiveAgentBridge.claim(transaction, input);
        });
      }
      const outcome = await db.runTransaction((transaction) => effectiveAgentBridge.run(
        transaction,
        input,
        (run) => {
          if (input.action === "submitProposalBatch") return submitProposalBatch(transaction, input, run);
          if (input.action === "appendEvidenceSnapshot") return appendAgentEvidence(transaction, input, run);
          if (input.action === "reportVerificationBlocked") return reportAgentVerificationBlocked(transaction, input, run);
          return generateAgentPreferenceSummary(transaction, input, run);
        },
      ));
      return { ...outcome.result, replayed: outcome.replayed };
    },
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
      if (input.action === "getDecisionWorkspace") return getDecisionWorkspace(input, actorUid);
      if (input.action === "getDecisionEvents") return getDecisionEvents(input, actorUid);
      if (input.action === "upsertPreference") return upsertPreference(input, actorUid);
      if (input.action === "completePreference" || input.action === "skipPreference") return setPreferenceStatus(input, actorUid);
      if (input.action === "generatePreferenceSummary") return generateMemberPreferenceSummary(input, actorUid);
      if (input.action === "recordFeedback") return recordFeedback(input, actorUid);
      if (input.action === "placeTentative") return placeTentative(input, actorUid);
      if (input.action === "attachTentativeToLegacyTrip" || input.action === "detachTentativeFromLegacyTrip") return changeLegacyPlacement(input, actorUid);
      if (input.action === "setConfirmationReceipt") return setConfirmationReceipt(input, actorUid);
      if (input.action === "createAgentRun" || input.action === "revokeAgentRun") return changeAgentRun(input, actorUid);
      if (input.action === "saveTrip") return saveTrip(input, actorUid);
      return changeMember(input, actorUid);
    },
  };
}

module.exports = { createTripCommands, createCloudBaseSessionRevoker, codedError, safeMember, TripSchema };
