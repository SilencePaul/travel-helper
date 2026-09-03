const assert = require("node:assert/strict");
const { generateKeyPairSync, sign } = require("node:crypto");
const test = require("node:test");

const { createTripCommands } = require("./commands.js");
const { canonicalJson, sha256Base64Url } = require("./decision-agent-bridge.js");

function agentSignature(privateKey, value) {
  return sign("sha256", Buffer.from(canonicalJson(value)), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
}

function member(uid, role, displayName = uid) {
  return { uid, role, displayName, version: 0, createdAt: "2026-08-27T00:00:00.000Z", tripIds: [], sessionIds: [] };
}

function trip(version = 0) {
  return {
    id: "trip-2026-autumn", title: "秋日旅行", startDate: "2026-10-01", endDate: "2026-10-01",
    travelers: [{ id: "ym", name: "一鸣" }], days: [{ id: "day-1", date: "2026-10-01", city: "香港", itemIds: [] }],
    unscheduledItemIds: [], orders: [], version,
  };
}

function candidate(overrides = {}) {
  return {
    id: "candidate-1",
    tripId: "trip-2026-autumn",
    category: "hotel",
    name: "海边酒店",
    verificationState: "web_verified",
    decisionState: "tentative",
    revision: 2,
    updatedAt: "2026-08-28T00:00:00.000Z",
    ...overrides,
  };
}

function restaurantProposal(name, sourceUrls = ["https://flyai.example/restaurants", "https://guide.example/restaurants"]) {
  return {
    category: "restaurant",
    entity: { name, address: "香港" },
    applicability: { dates: { start: "2026-10-01", end: "2026-10-01" }, travelers: 2 },
    recommendation: { round: 1, reason: "符合共同偏好", preferenceRevisionIds: [], feedbackIds: [] },
    evidence: sourceUrls.map((sourceUrl, index) => ({
      sourceKind: index === 0 ? "flyai" : "web",
      sourceName: index === 0 ? "FlyAI" : "公开旅行指南",
      sourceUrl,
      capturedAt: "2026-08-28T07:00:00.000Z",
      queryContext: { dates: { start: "2026-10-01", end: "2026-10-01" }, travelers: 2 },
      captureMethod: index === 0 ? "api_result" : "search_result",
      facts: { name, address: "香港", openInformation: "晚餐营业", priceSnapshot: "约 HK$200/人" },
    })),
  };
}

function placement(overrides = {}) {
  return {
    id: "trip-2026-autumn:candidate-1",
    tripId: "trip-2026-autumn",
    candidateId: "candidate-1",
    tripDayId: "day-1",
    date: "2026-10-01",
    sortKey: "a0",
    status: "planned",
    revision: 1,
    updatedAt: "2026-08-28T00:00:00.000Z",
    ...overrides,
  };
}

function createDb({ members = [], trips = [trip()], authSessions = [], candidates = [], summaries = [], placements = [], confirmations = [] } = {}) {
  const data = {
    members: new Map(members.map((item) => [item.uid, structuredClone(item)])),
    trips: new Map(trips.map((item) => [item.id, structuredClone(item)])),
    auth_sessions: new Map(authSessions.map((item) => [item._id, structuredClone(item)])),
    membership_index: new Map([
      ["admins", { adminUids: members.filter((item) => item.role === "admin").map((item) => item.uid) }],
      ["members", { memberUids: members.map((item) => item.uid) }],
    ]),
    audits: [],
    decisionAudits: [],
    idempotency: new Map(),
    trip_preferences: new Map(),
    trip_preference_summaries: new Map(summaries.map((item) => [item.id, structuredClone(item)])),
    trip_candidates: new Map(candidates.map((item) => [item.id, structuredClone(item)])),
    trip_evidence_snapshots: new Map(),
    trip_candidate_feedback: new Map(),
    trip_tentative_placements: new Map(placements.map((item) => [item.id, structuredClone(item)])),
    trip_confirmation_receipts: new Map(confirmations.map((item) => [item.id, structuredClone(item)])),
    trip_decision_indexes: new Map(),
    trip_decision_meta: new Map(),
    trip_decision_events: new Map(),
    trip_decision_idempotency: new Map(),
    trip_agent_runs: new Map(),
    trip_agent_idempotency: new Map(),
  };
  const collection = (name, allowQueries = true) => {
    const store = name === "trip_idempotency" ? data.idempotency : name === "trip_audits" ? undefined : data[name];
    return {
    doc(id) {
      return {
        async get() { const value = store?.get(id); return { data: value ? [structuredClone(value)] : [] }; },
        async set(value) { store?.set(id, structuredClone(value)); },
      };
    },
    where(query) {
      if (!allowQueries) throw new Error("CloudBase transactions do not support where queries");
      return {
        async get() { return { data: [...(store?.values() || [])].filter((value) => Object.entries(query).every(([key, expected]) => value[key] === expected)).map((value) => structuredClone(value)) }; },
        limit() { return this; },
      };
    },
      async add(value) { (name === "trip_decision_audits" ? data.decisionAudits : data.audits).push(structuredClone(value)); },
    };
  };
  return { data, collection, async runTransaction(callback) { return callback({ collection: (name) => collection(name, false) }); } };
}

test("only an administrator can approve a pending member", async () => {
  const db = createDb({
    members: [{ ...member("fs_admin", "admin", "一鸣"), tripIds: ["trip-2026-autumn"] }, member("fs_pending", "pending", "美垚")],
    trips: [{ ...trip(), memberUids: ["fs_admin"] }],
  });
  const commands = createTripCommands({ db, now: () => new Date("2026-08-27T12:00:00.000Z") });

  await assert.rejects(() => commands.execute({ action: "approveMember", uid: "fs_pending" }, "fs_pending"), { code: "MEMBERSHIP_REQUIRED" });
  const result = await commands.execute({ action: "approveMember", uid: "fs_pending" }, "fs_admin");

  assert.deepEqual(result.member, expectMember("fs_pending", "member", "美垚"));
  assert.equal(db.data.members.get("fs_pending").role, "member");
  assert.equal(db.data.audits[0].action, "approveMember");
  assert.equal("openId" in db.data.audits[0], false);
});

test("an approved member is atomically attached to the administrator's trip and can load and save it", async () => {
  const admin = { ...member("fs_admin", "admin", "一鸣"), tripIds: ["trip-2026-autumn"] };
  const db = createDb({
    members: [admin, member("fs_pending", "pending", "美垚")],
    trips: [{ ...trip(), memberUids: ["fs_admin"] }],
  });
  const commands = createTripCommands({ db, now: () => new Date("2026-08-27T12:00:00.000Z") });

  await commands.execute({ action: "approveMember", uid: "fs_pending" }, "fs_admin");

  assert.deepEqual(db.data.members.get("fs_pending").tripIds, ["trip-2026-autumn"]);
  assert.deepEqual(db.data.trips.get("trip-2026-autumn").memberUids, ["fs_admin", "fs_pending"]);
  assert.equal(db.data.trips.get("trip-2026-autumn").version, 1);

  const loaded = await commands.execute({ action: "getTrip", tripId: "trip-2026-autumn" }, "fs_pending");
  const saved = await commands.execute({
    action: "saveTrip",
    trip: { ...loaded.trip, title: "两个人的旅行" },
    expectedVersion: loaded.trip.version,
    idempotencyKey: "approved-member-save",
  }, "fs_pending");

  assert.equal(saved.trip.title, "两个人的旅行");
  assert.equal(saved.trip.version, 2);
  assert.deepEqual(saved.trip.memberUids, ["fs_admin", "fs_pending"]);
});

test("approval enforces the private trip's two-active-member limit without counting pending records", async () => {
  const admin = { ...member("fs_admin", "admin"), tripIds: ["trip-2026-autumn"] };
  const active = { ...member("fs_member", "member"), tripIds: ["trip-2026-autumn"] };
  const db = createDb({
    members: [admin, active, member("fs_pending", "pending")],
    trips: [{ ...trip(), memberUids: ["fs_admin", "fs_member"] }],
  });
  db.data.membership_index.set("members", { memberUids: ["fs_admin", "fs_member", "fs_pending"] });
  const commands = createTripCommands({ db });

  await assert.rejects(
    () => commands.execute({ action: "approveMember", uid: "fs_pending" }, "fs_admin"),
    { code: "MEMBER_LIMIT_REACHED" },
  );
  assert.equal(db.data.members.get("fs_pending").role, "pending");
  assert.deepEqual(db.data.trips.get("trip-2026-autumn").memberUids, ["fs_admin", "fs_member"]);
});

test("a trip member can load only their own trip", async () => {
  const db = createDb({
    members: [member("fs_member", "member")],
    trips: [{ ...trip(), memberUids: ["fs_member"] }],
  });
  const commands = createTripCommands({ db });

  const result = await commands.execute({ action: "getTrip", tripId: "trip-2026-autumn" }, "fs_member");
  assert.equal(result.trip.id, "trip-2026-autumn");
  await assert.rejects(
    () => commands.execute({ action: "getTrip", tripId: "trip-2026-autumn" }, "fs_other"),
    { code: "MEMBERSHIP_REQUIRED" },
  );
});

test("a member saves an idempotent preference and sees it in the private decision workspace", async () => {
  const db = createDb({ members: [member("fs_member", "member")], trips: [{ ...trip(), memberUids: ["fs_member"] }] });
  const commands = createTripCommands({ db, now: () => new Date("2026-08-28T00:00:00.000Z") });
  const input = { action: "upsertPreference", tripId: "trip-2026-autumn", expectedRevision: 0, idempotencyKey: "preference-001", answers: { pace: "slow" } };
  const saved = await commands.execute(input, "fs_member");
  assert.equal(saved.preference.status, "editing");
  assert.deepEqual((await commands.execute({ action: "getDecisionWorkspace", tripId: "trip-2026-autumn" }, "fs_member")).preferences, [saved.preference]);
  assert.deepEqual(await commands.execute(input, "fs_member"), saved);
});

test("the decision workspace returns every indexed resource at one snapshot cursor", async () => {
  const db = createDb({
    members: [member("fs_member", "member")],
    trips: [{ ...trip(), memberUids: ["fs_member"] }],
    candidates: [candidate()],
    summaries: [{
      id: "trip-2026-autumn",
      tripId: "trip-2026-autumn",
      sourcePreferenceRevisions: { fs_member: 1 },
      common: ["慢节奏"],
      disagreements: [],
      tradeoffs: [],
      status: "ready",
      revision: 1,
      generatedAt: "2026-08-28T00:00:00.000Z",
    }],
  });
  db.data.trip_preferences.set("trip-2026-autumn:fs_member", {
    id: "trip-2026-autumn:fs_member",
    tripId: "trip-2026-autumn",
    ownerUid: "fs_member",
    answers: { pace: "slow" },
    status: "completed",
    revision: 1,
    updatedAt: "2026-08-28T00:00:00.000Z",
    updatedBy: "fs_member",
  });
  db.data.trip_evidence_snapshots.set("evidence-1", { id: "evidence-1", tripId: "trip-2026-autumn", candidateId: "candidate-1", revision: 1 });
  db.data.trip_candidate_feedback.set("feedback-1", { id: "feedback-1", tripId: "trip-2026-autumn", candidateId: "candidate-1", actorUid: "fs_member", kind: "like", revision: 1 });
  db.data.trip_tentative_placements.set("placement-1", { id: "placement-1", tripId: "trip-2026-autumn", candidateId: "candidate-1", status: "planned", revision: 1 });
  db.data.trip_confirmation_receipts.set("confirmation-1", { id: "confirmation-1", tripId: "trip-2026-autumn", candidateId: "candidate-1", memberUid: "fs_member", active: true, revision: 1 });
  db.data.trip_decision_indexes.set("trip-2026-autumn", {
    candidateIds: ["candidate-1"],
    evidenceIds: ["evidence-1"],
    feedbackIds: ["feedback-1"],
    placementIds: ["placement-1"],
    confirmationIds: ["confirmation-1"],
  });
  db.data.trip_decision_meta.set("trip-2026-autumn", { tripId: "trip-2026-autumn", nextSequence: 8 });
  const commands = createTripCommands({ db, now: () => new Date("2026-08-28T06:00:00.000Z") });

  const workspace = await commands.execute({ action: "getDecisionWorkspace", tripId: "trip-2026-autumn" }, "fs_member");

  assert.equal(workspace.summary.id, "trip-2026-autumn");
  assert.deepEqual(workspace.candidates.map(({ id }) => id), ["candidate-1"]);
  assert.deepEqual(workspace.evidence.map(({ id }) => id), ["evidence-1"]);
  assert.deepEqual(workspace.feedback.map(({ id }) => id), ["feedback-1"]);
  assert.deepEqual(workspace.placements.map(({ id }) => id), ["placement-1"]);
  assert.deepEqual(workspace.confirmations.map(({ id }) => id), ["confirmation-1"]);
  assert.equal(workspace.workspaceCursor, "7");
});

test("decision mutations update the workspace index and monotonic event cursor", async () => {
  const db = createDb({
    members: [member("fs_member", "member")],
    trips: [{ ...trip(), memberUids: ["fs_member"] }],
    candidates: [candidate({ decisionState: "none" })],
  });
  const commands = createTripCommands({ db, now: () => new Date("2026-08-28T06:30:00.000Z") });

  await commands.execute({
    action: "upsertPreference",
    tripId: "trip-2026-autumn",
    expectedRevision: 0,
    idempotencyKey: "workspace-preference-001",
    answers: { pace: "slow" },
  }, "fs_member");
  await commands.execute({
    action: "recordFeedback",
    tripId: "trip-2026-autumn",
    candidateId: "candidate-1",
    kind: "like",
    idempotencyKey: "workspace-feedback-001",
  }, "fs_member");
  const placed = await commands.execute({
    action: "placeTentative",
    tripId: "trip-2026-autumn",
    candidateId: "candidate-1",
    expectedCandidateRevision: 2,
    placement: { tripDayId: "day-1", date: "2026-10-01", sortKey: "a0" },
    idempotencyKey: "workspace-placement-001",
  }, "fs_member");
  await commands.execute({
    action: "setConfirmationReceipt",
    tripId: "trip-2026-autumn",
    candidateId: "candidate-1",
    expectedCandidateRevision: placed.candidate.revision,
    active: true,
    idempotencyKey: "workspace-confirmation-001",
  }, "fs_member");

  const workspace = await commands.execute({ action: "getDecisionWorkspace", tripId: "trip-2026-autumn" }, "fs_member");
  assert.deepEqual(workspace.candidates.map(({ id }) => id), ["candidate-1"]);
  assert.equal(workspace.feedback.length, 1);
  assert.equal(workspace.placements.length, 1);
  assert.equal(workspace.confirmations.length, 1);
  assert.equal(workspace.workspaceCursor, "6");
  assert.deepEqual([...db.data.trip_decision_events.values()].map(({ sequence }) => sequence), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(db.data.decisionAudits.map(({ command }) => command), ["upsertPreference", "recordFeedback", "placeTentative", "setConfirmationReceipt"]);
});

test("a member can resume decision events strictly after their cursor", async () => {
  const db = createDb({
    members: [member("fs_member", "member")],
    trips: [{ ...trip(), memberUids: ["fs_member"] }],
    candidates: [candidate()],
  });
  const commands = createTripCommands({ db });
  await commands.execute({
    action: "upsertPreference",
    tripId: "trip-2026-autumn",
    expectedRevision: 0,
    idempotencyKey: "event-preference-001",
    answers: { pace: "slow" },
  }, "fs_member");
  await commands.execute({
    action: "recordFeedback",
    tripId: "trip-2026-autumn",
    candidateId: "candidate-1",
    kind: "comment",
    reason: "交通方便",
    idempotencyKey: "event-feedback-001",
  }, "fs_member");

  const all = await commands.execute({ action: "getDecisionEvents", tripId: "trip-2026-autumn", afterCursor: 0 }, "fs_member");
  const resumed = await commands.execute({ action: "getDecisionEvents", tripId: "trip-2026-autumn", afterCursor: 1 }, "fs_member");

  assert.deepEqual(all.events.map(({ sequence }) => sequence), [1, 2]);
  assert.equal(all.cursor, 2);
  assert.deepEqual(resumed.events.map(({ sequence }) => sequence), [2]);
  assert.equal(resumed.cursor, 2);
});

test("the first member confirmation keeps a tentative candidate tentative", async () => {
  const db = createDb({
    members: [member("fs_admin", "admin"), member("fs_member", "member")],
    trips: [{ ...trip(), memberUids: ["fs_admin", "fs_member"] }],
    candidates: [candidate()],
    placements: [placement()],
  });
  const commands = createTripCommands({ db, now: () => new Date("2026-08-28T01:00:00.000Z") });

  const result = await commands.execute({
    action: "setConfirmationReceipt",
    tripId: "trip-2026-autumn",
    candidateId: "candidate-1",
    expectedCandidateRevision: 2,
    active: true,
    idempotencyKey: "confirm-admin-001",
  }, "fs_admin");

  assert.equal(result.candidate.decisionState, "tentative");
  assert.equal(result.candidate.revision, 3);
  assert.equal(result.receipt.memberUid, "fs_admin");
  assert.equal(result.receipt.active, true);
  assert.equal(result.receipt.updatedAt, "2026-08-28T01:00:00.000Z");
});

test("the second active member confirmation confirms a tentative candidate", async () => {
  const db = createDb({
    members: [member("fs_admin", "admin"), member("fs_member", "member")],
    trips: [{ ...trip(), memberUids: ["fs_admin", "fs_member"] }],
    candidates: [candidate()],
    placements: [placement()],
  });
  const commands = createTripCommands({ db, now: () => new Date("2026-08-28T01:00:00.000Z") });
  const first = await commands.execute({
    action: "setConfirmationReceipt",
    tripId: "trip-2026-autumn",
    candidateId: "candidate-1",
    expectedCandidateRevision: 2,
    active: true,
    idempotencyKey: "confirm-admin-002",
  }, "fs_admin");

  const second = await commands.execute({
    action: "setConfirmationReceipt",
    tripId: "trip-2026-autumn",
    candidateId: "candidate-1",
    expectedCandidateRevision: first.candidate.revision,
    active: true,
    idempotencyKey: "confirm-member-001",
  }, "fs_member");

  assert.equal(second.candidate.decisionState, "confirmed");
  assert.equal(second.candidate.revision, 4);
});

test("confirmation replay returns the original result without another revision", async () => {
  const db = createDb({
    members: [member("fs_admin", "admin"), member("fs_member", "member")],
    trips: [{ ...trip(), memberUids: ["fs_admin", "fs_member"] }],
    candidates: [candidate()],
    placements: [placement()],
  });
  const commands = createTripCommands({ db, now: () => new Date("2026-08-28T01:00:00.000Z") });
  const input = {
    action: "setConfirmationReceipt",
    tripId: "trip-2026-autumn",
    candidateId: "candidate-1",
    expectedCandidateRevision: 2,
    active: true,
    idempotencyKey: "confirm-replay-001",
  };

  const first = await commands.execute(input, "fs_admin");
  const replay = await commands.execute(input, "fs_admin");

  assert.deepEqual(replay, first);
  assert.equal(db.data.trip_candidates.get("candidate-1").revision, 3);
});

test("an active confirmation requires a planned or linked tentative placement", async () => {
  const db = createDb({
    members: [member("fs_admin", "admin"), member("fs_member", "member")],
    trips: [{ ...trip(), memberUids: ["fs_admin", "fs_member"] }],
    candidates: [candidate()],
  });
  const commands = createTripCommands({ db });

  await assert.rejects(() => commands.execute({
    action: "setConfirmationReceipt",
    tripId: "trip-2026-autumn",
    candidateId: "candidate-1",
    expectedCandidateRevision: 2,
    active: true,
    idempotencyKey: "confirm-no-placement-001",
  }, "fs_admin"), { code: "INVALID_CONFIRMATION_STATE" });
});

test("a member cannot withdraw a confirmation receipt that is not active", async () => {
  const db = createDb({
    members: [member("fs_admin", "admin"), member("fs_member", "member")],
    trips: [{ ...trip(), memberUids: ["fs_admin", "fs_member"] }],
    candidates: [candidate()],
    placements: [placement()],
  });
  const commands = createTripCommands({ db });

  await assert.rejects(() => commands.execute({
    action: "setConfirmationReceipt",
    tripId: "trip-2026-autumn",
    candidateId: "candidate-1",
    expectedCandidateRevision: 2,
    active: false,
    idempotencyKey: "withdraw-missing-001",
  }, "fs_admin"), { code: "INVALID_CONFIRMATION_STATE" });
});

test("a member cannot activate a second confirmation receipt with a new key", async () => {
  const db = createDb({
    members: [member("fs_admin", "admin"), member("fs_member", "member")],
    trips: [{ ...trip(), memberUids: ["fs_admin", "fs_member"] }],
    candidates: [candidate()],
    placements: [placement()],
  });
  const commands = createTripCommands({ db });
  const first = await commands.execute({
    action: "setConfirmationReceipt",
    tripId: "trip-2026-autumn",
    candidateId: "candidate-1",
    expectedCandidateRevision: 2,
    active: true,
    idempotencyKey: "confirm-once-001",
  }, "fs_admin");

  await assert.rejects(() => commands.execute({
    action: "setConfirmationReceipt",
    tripId: "trip-2026-autumn",
    candidateId: "candidate-1",
    expectedCandidateRevision: first.candidate.revision,
    active: true,
    idempotencyKey: "confirm-twice-001",
  }, "fs_admin"), { code: "INVALID_CONFIRMATION_STATE" });
});

test("withdrawing either active receipt returns a confirmed candidate to tentative", async () => {
  const db = createDb({
    members: [member("fs_admin", "admin"), member("fs_member", "member")],
    trips: [{ ...trip(), memberUids: ["fs_admin", "fs_member"] }],
    candidates: [candidate({ decisionState: "confirmed", revision: 4 })],
    placements: [placement()],
    confirmations: [
      { id: "trip-2026-autumn:candidate-1:fs_admin", tripId: "trip-2026-autumn", candidateId: "candidate-1", memberUid: "fs_admin", active: true, revision: 1, actedAt: "2026-08-28T00:00:00.000Z" },
      { id: "trip-2026-autumn:candidate-1:fs_member", tripId: "trip-2026-autumn", candidateId: "candidate-1", memberUid: "fs_member", active: true, revision: 1, actedAt: "2026-08-28T00:00:00.000Z" },
    ],
  });
  const commands = createTripCommands({ db });

  const result = await commands.execute({
    action: "setConfirmationReceipt",
    tripId: "trip-2026-autumn",
    candidateId: "candidate-1",
    expectedCandidateRevision: 4,
    active: false,
    idempotencyKey: "withdraw-confirmation-001",
  }, "fs_member");

  assert.equal(result.receipt.active, false);
  assert.equal(result.candidate.decisionState, "tentative");
  assert.equal(result.candidate.revision, 5);
});

test("candidate feedback is append-only and idempotent for its author", async () => {
  const db = createDb({
    members: [member("fs_member", "member")],
    trips: [{ ...trip(), memberUids: ["fs_member"] }],
    candidates: [candidate()],
  });
  const commands = createTripCommands({ db, now: () => new Date("2026-08-28T02:00:00.000Z") });
  const input = {
    action: "recordFeedback",
    tripId: "trip-2026-autumn",
    candidateId: "candidate-1",
    kind: "dislike",
    reason: "离地铁太远",
    idempotencyKey: "feedback-001",
  };

  const first = await commands.execute(input, "fs_member");
  const replay = await commands.execute(input, "fs_member");

  assert.deepEqual(replay, first);
  assert.equal(db.data.trip_candidate_feedback.size, 1);
  assert.equal(first.feedback.actorUid, "fs_member");
  assert.equal(first.feedback.updatedAt, "2026-08-28T02:00:00.000Z");
});

test("a tentative placement validates the trip day and replays without duplication", async () => {
  const db = createDb({
    members: [member("fs_member", "member")],
    trips: [{ ...trip(), memberUids: ["fs_member"] }],
    candidates: [candidate({ decisionState: "none" })],
  });
  const commands = createTripCommands({ db, now: () => new Date("2026-08-28T03:00:00.000Z") });
  const input = {
    action: "placeTentative",
    tripId: "trip-2026-autumn",
    candidateId: "candidate-1",
    expectedCandidateRevision: 2,
    placement: { tripDayId: "day-1", date: "2026-10-01", sortKey: "a0" },
    idempotencyKey: "placement-001",
  };

  const first = await commands.execute(input, "fs_member");
  const replay = await commands.execute(input, "fs_member");

  assert.deepEqual(replay, first);
  assert.equal(first.placement.status, "planned");
  assert.equal(first.placement.revision, 1);
  assert.equal(first.candidate.decisionState, "tentative");
  assert.equal(db.data.trip_tentative_placements.size, 1);
});

test("attaching a tentative placement atomically updates the placement and legacy trip", async () => {
  const db = createDb({
    members: [member("fs_member", "member")],
    trips: [{ ...trip(), memberUids: ["fs_member"] }],
    candidates: [candidate()],
    placements: [placement()],
  });
  const commands = createTripCommands({ db });

  const result = await commands.execute({
    action: "attachTentativeToLegacyTrip",
    tripId: "trip-2026-autumn",
    placementId: "trip-2026-autumn:candidate-1",
    legacyItemId: "hotel-item-1",
    expectedPlacementRevision: 1,
    expectedTripVersion: 0,
    idempotencyKey: "attach-placement-001",
  }, "fs_member");

  assert.equal(result.placement.status, "linked");
  assert.equal(result.placement.legacyTripItemId, "hotel-item-1");
  assert.equal(result.placement.revision, 2);
  assert.equal(result.tripVersion, 1);
  assert.deepEqual(db.data.trips.get("trip-2026-autumn").days[0].itemIds, ["hotel-item-1"]);
});

test("an attach version conflict leaves both the placement and trip unchanged", async () => {
  const db = createDb({
    members: [member("fs_member", "member")],
    trips: [{ ...trip(2), memberUids: ["fs_member"] }],
    candidates: [candidate()],
    placements: [placement()],
  });
  const commands = createTripCommands({ db });

  await assert.rejects(() => commands.execute({
    action: "attachTentativeToLegacyTrip",
    tripId: "trip-2026-autumn",
    placementId: "trip-2026-autumn:candidate-1",
    legacyItemId: "hotel-item-1",
    expectedPlacementRevision: 1,
    expectedTripVersion: 1,
    idempotencyKey: "attach-conflict-001",
  }, "fs_member"), { code: "VERSION_CONFLICT" });

  assert.equal(db.data.trip_tentative_placements.get("trip-2026-autumn:candidate-1").status, "planned");
  assert.deepEqual(db.data.trips.get("trip-2026-autumn").days[0].itemIds, []);
});

test("detaching a linked placement updates the trip and returns a confirmed candidate to tentative", async () => {
  const linkedTrip = trip(1);
  linkedTrip.days[0].itemIds = ["hotel-item-1"];
  const db = createDb({
    members: [member("fs_admin", "admin"), member("fs_member", "member")],
    trips: [{ ...linkedTrip, memberUids: ["fs_admin", "fs_member"] }],
    candidates: [candidate({ decisionState: "confirmed", revision: 4 })],
    placements: [placement({ status: "linked", legacyTripItemId: "hotel-item-1", revision: 2 })],
  });
  const commands = createTripCommands({ db });

  const result = await commands.execute({
    action: "detachTentativeFromLegacyTrip",
    tripId: "trip-2026-autumn",
    placementId: "trip-2026-autumn:candidate-1",
    expectedPlacementRevision: 2,
    expectedTripVersion: 1,
    idempotencyKey: "detach-placement-001",
  }, "fs_member");

  assert.equal(result.placement.status, "detached");
  assert.equal(result.placement.revision, 3);
  assert.equal(result.tripVersion, 2);
  assert.deepEqual(db.data.trips.get("trip-2026-autumn").days[0].itemIds, []);
  assert.equal(db.data.trip_candidates.get("candidate-1").decisionState, "tentative");
  assert.equal(db.data.trip_candidates.get("candidate-1").revision, 5);
});

test("a member completes their own preference idempotently", async () => {
  const db = createDb({
    members: [member("fs_member", "member")],
    trips: [{ ...trip(), memberUids: ["fs_member"] }],
  });
  const commands = createTripCommands({ db, now: () => new Date("2026-08-28T04:00:00.000Z") });
  await commands.execute({
    action: "upsertPreference",
    tripId: "trip-2026-autumn",
    expectedRevision: 0,
    idempotencyKey: "preference-draft-001",
    answers: { pace: "slow" },
  }, "fs_member");
  const input = {
    action: "completePreference",
    tripId: "trip-2026-autumn",
    expectedRevision: 1,
    idempotencyKey: "preference-complete-001",
  };

  const first = await commands.execute(input, "fs_member");
  const replay = await commands.execute(input, "fs_member");

  assert.deepEqual(replay, first);
  assert.equal(first.preference.status, "completed");
  assert.equal(first.preference.revision, 2);
});

test("a member generates a shared summary only from both current finished profiles", async () => {
  const db = createDb({
    members: [member("fs_admin", "admin"), member("fs_member", "member")],
    trips: [{ ...trip(), memberUids: ["fs_admin", "fs_member"] }],
  });
  const commands = createTripCommands({ db, now: () => new Date("2026-08-28T04:30:00.000Z") });
  for (const uid of ["fs_admin", "fs_member"]) {
    await commands.execute({
      action: "upsertPreference",
      tripId: "trip-2026-autumn",
      expectedRevision: 0,
      idempotencyKey: `summary-draft-${uid}`,
      answers: { pace: "slow", budget: uid === "fs_admin" ? "mid" : "high" },
    }, uid);
    await commands.execute({
      action: "completePreference",
      tripId: "trip-2026-autumn",
      expectedRevision: 1,
      idempotencyKey: `summary-complete-${uid}`,
    }, uid);
  }

  const result = await commands.execute({
    action: "generatePreferenceSummary",
    tripId: "trip-2026-autumn",
    sourcePreferenceRevisions: { fs_admin: 2, fs_member: 2 },
    idempotencyKey: "generate-summary-001",
  }, "fs_admin");

  assert.equal(result.summary.status, "ready");
  assert.deepEqual(result.summary.sourcePreferenceRevisions, { fs_admin: 2, fs_member: 2 });
  assert.equal(result.summary.common.some((entry) => entry.includes("pace")), true);
  assert.equal(result.summary.disagreements.some((entry) => entry.includes("budget")), true);
  assert.equal(result.summary.revision, 1);
});

test("editing a preference marks an existing shared summary outdated", async () => {
  const db = createDb({
    members: [member("fs_member", "member")],
    trips: [{ ...trip(), memberUids: ["fs_member"] }],
  });
  const commands = createTripCommands({ db, now: () => new Date("2026-08-28T05:00:00.000Z") });
  await commands.execute({
    action: "upsertPreference",
    tripId: "trip-2026-autumn",
    expectedRevision: 0,
    idempotencyKey: "preference-summary-001",
    answers: { pace: "slow" },
  }, "fs_member");
  db.data.trip_preference_summaries.set("trip-2026-autumn", {
    id: "trip-2026-autumn",
    tripId: "trip-2026-autumn",
    sourcePreferenceRevisions: { fs_member: 1 },
    common: ["慢节奏"],
    disagreements: [],
    tradeoffs: [],
    status: "ready",
    revision: 5,
    updatedAt: "2026-08-28T04:00:00.000Z",
  });

  await commands.execute({
    action: "upsertPreference",
    tripId: "trip-2026-autumn",
    expectedRevision: 1,
    idempotencyKey: "preference-summary-002",
    answers: { pace: "fast" },
  }, "fs_member");

  const summary = db.data.trip_preference_summaries.get("trip-2026-autumn");
  assert.equal(summary.status, "outdated");
  assert.equal(summary.revision, 6);
});

test("decision idempotency keys are scoped by actor and action", async () => {
  const db = createDb({
    members: [member("fs_admin", "admin"), member("fs_member", "member")],
    trips: [{ ...trip(), memberUids: ["fs_admin", "fs_member"] }],
  });
  const commands = createTripCommands({ db });
  const input = {
    action: "upsertPreference",
    tripId: "trip-2026-autumn",
    expectedRevision: 0,
    idempotencyKey: "shared-preference-key",
    answers: { pace: "slow" },
  };

  const adminResult = await commands.execute(input, "fs_admin");
  const memberResult = await commands.execute(input, "fs_member");

  assert.equal(adminResult.preference.ownerUid, "fs_admin");
  assert.equal(memberResult.preference.ownerUid, "fs_member");
  assert.equal(db.data.trip_preferences.size, 2);
});

test("ordinary members cannot create, inspect, or revoke AgentRuns", async () => {
  const db = createDb({
    members: [member("fs_member", "member")],
    trips: [{ ...trip(), memberUids: ["fs_member"] }],
  });
  db.data.trip_agent_runs.set("agent-run-1", {
    id: "agent-run-1",
    tripId: "trip-2026-autumn",
    creatorUid: "fs_member",
    publicKeyJwk: { kty: "EC", crv: "P-256", x: "x-coordinate", y: "y-coordinate" },
    scope: ["submitProposalBatch"],
    status: "pending_claim",
    lastSequence: 0,
    revision: 1,
    createdAt: "2026-08-28T07:00:00.000Z",
    expiresAt: "2026-08-28T07:15:00.000Z",
  });
  const commands = createTripCommands({
    db,
    now: () => new Date("2026-08-28T07:00:00.000Z"),
  });

  await assert.rejects(() => commands.execute({
    action: "createAgentRun",
    tripId: "trip-2026-autumn",
    publicKeyJwk: { kty: "EC", crv: "P-256", x: "x-coordinate", y: "y-coordinate" },
    pairingCodeHash: "2g8DdGhJvqg00hyxT13Po40J6lVT92CRPLHZfoW3szI",
    scope: ["submitProposalBatch"],
    idempotencyKey: "create-agent-run-001",
  }, "fs_member"), { code: "ADMIN_REQUIRED" });
  await assert.rejects(() => commands.execute({
    action: "getAgentRunStatus",
    tripId: "trip-2026-autumn",
    agentRunId: "agent-run-1",
  }, "fs_member"), { code: "ADMIN_REQUIRED" });
  await assert.rejects(() => commands.execute({
    action: "revokeAgentRun",
    tripId: "trip-2026-autumn",
    agentRunId: "agent-run-1",
    expectedRevision: 1,
    idempotencyKey: "revoke-agent-run-001",
  }, "fs_member"), { code: "ADMIN_REQUIRED" });
  assert.equal(db.data.trip_agent_runs.get("agent-run-1").status, "pending_claim");
});

test("an administrator creates a fixed 15-minute AgentRun, inspects, and revokes only the fixed proposal scope", async () => {
  const db = createDb({
    members: [member("fs_admin", "admin")],
    trips: [{ ...trip(), memberUids: ["fs_admin"] }],
  });
  const commands = createTripCommands({
    db,
    now: () => new Date("2026-08-28T07:00:00.000Z"),
    randomId: () => "agent-run-1",
  });
  await assert.rejects(() => commands.execute({
    action: "createAgentRun",
    tripId: "trip-2026-autumn",
    publicKeyJwk: { kty: "EC", crv: "P-256", x: "x-coordinate", y: "y-coordinate" },
    pairingCodeHash: "2g8DdGhJvqg00hyxT13Po40J6lVT92CRPLHZfoW3szI",
    scope: ["submitProposalBatch", "appendEvidenceSnapshot"],
    idempotencyKey: "create-agent-run-wide",
  }, "fs_admin"), { code: "INVALID_REQUEST" });
  const created = await commands.execute({
    action: "createAgentRun",
    tripId: "trip-2026-autumn",
    publicKeyJwk: { kty: "EC", crv: "P-256", x: "x-coordinate", y: "y-coordinate" },
    pairingCodeHash: "2g8DdGhJvqg00hyxT13Po40J6lVT92CRPLHZfoW3szI",
    scope: ["submitProposalBatch"],
    idempotencyKey: "create-agent-run-001",
  }, "fs_admin");

  assert.deepEqual(created, { agentRunId: "agent-run-1", expiresAt: "2026-08-28T07:15:00.000Z" });
  assert.equal(
    Date.parse(created.expiresAt) - Date.parse("2026-08-28T07:00:00.000Z"),
    15 * 60 * 1_000,
    "createAgentRun keeps its server-side 15-minute lease",
  );
  assert.equal(db.data.trip_agent_runs.get("agent-run-1").status, "pending_claim");
  assert.equal(db.data.trip_agent_runs.get("agent-run-1").lastSequence, 0);
  const pendingStatus = await commands.execute({
    action: "getAgentRunStatus",
    tripId: "trip-2026-autumn",
    agentRunId: "agent-run-1",
  }, "fs_admin");
  assert.deepEqual(pendingStatus, {
    agentRunId: "agent-run-1",
    tripId: "trip-2026-autumn",
    status: "pending_claim",
    scope: ["submitProposalBatch"],
    revision: 1,
    nextSequence: 1,
    createdAt: "2026-08-28T07:00:00.000Z",
    expiresAt: "2026-08-28T07:15:00.000Z",
  });
  assert.equal("publicKeyJwk" in pendingStatus, false);
  assert.equal("pairingCodeHash" in pendingStatus, false);
  assert.equal("clientNonce" in pendingStatus, false);

  const revoked = await commands.execute({
    action: "revokeAgentRun",
    tripId: "trip-2026-autumn",
    agentRunId: "agent-run-1",
    expectedRevision: 1,
    idempotencyKey: "revoke-agent-run-001",
  }, "fs_admin");
  assert.deepEqual(revoked, { agentRunId: "agent-run-1", revokedAt: "2026-08-28T07:00:00.000Z" });
  assert.equal(db.data.trip_agent_runs.get("agent-run-1").status, "revoked");
  assert.equal(db.data.trip_agent_runs.get("agent-run-1").revision, 2);
  assert.equal((await commands.execute({ action: "getAgentRunStatus", tripId: "trip-2026-autumn", agentRunId: "agent-run-1" }, "fs_admin")).status, "revoked");
  assert.deepEqual(db.data.decisionAudits.map(({ command }) => command), ["createAgentRun", "revokeAgentRun"]);
  assert.equal(JSON.stringify(db.data.decisionAudits).includes("pairingCodeHash"), false);
  assert.equal(JSON.stringify(db.data.decisionAudits).includes("publicKeyJwk"), false);
});

test("AgentRun status rejects corrupt expirations and reports a valid elapsed run as expired", async () => {
  for (const [label, expiresAt, clock, expected] of [
    ["missing", undefined, new Date("2026-08-28T07:05:00.000Z"), "AGENT_RUN_EXPIRED"],
    ["invalid", "not-a-date", new Date("2026-08-28T07:05:00.000Z"), "AGENT_RUN_EXPIRED"],
    ["non-datetime", "2099-08-28", new Date("2026-08-28T07:05:00.000Z"), "AGENT_RUN_EXPIRED"],
    ["invalid clock", "2026-08-28T07:15:00.000Z", new Date("not-a-date"), "AGENT_RUN_EXPIRED"],
    ["elapsed", "2026-08-28T07:05:00.000Z", new Date("2026-08-28T07:05:00.000Z"), "expired"],
  ]) {
    const db = createDb({
      members: [member("fs_admin", "admin")],
      trips: [{ ...trip(), memberUids: ["fs_admin"] }],
    });
    db.data.trip_agent_runs.set("agent-run-1", {
      id: "agent-run-1",
      tripId: "trip-2026-autumn",
      creatorUid: "fs_admin",
      publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
      scope: ["submitProposalBatch"],
      status: "claimed",
      lastSequence: 0,
      revision: 2,
      createdAt: "2026-08-28T07:00:00.000Z",
      expiresAt,
    });
    const commands = createTripCommands({ db, now: () => clock });
    const status = () => commands.execute({
      action: "getAgentRunStatus",
      tripId: "trip-2026-autumn",
      agentRunId: "agent-run-1",
    }, "fs_admin");

    if (expected === "expired") {
      assert.equal((await status()).status, "expired", label);
    } else {
      await assert.rejects(status, { code: expected }, label);
    }
  }
});

test("an administrator cannot query a different trip's AgentRun through their own trip", async () => {
  const tripA = { ...trip(), id: "trip-a", memberUids: ["fs_admin"] };
  const tripB = { ...trip(), id: "trip-b", memberUids: ["fs_other"] };
  const db = createDb({ members: [member("fs_admin", "admin"), member("fs_other", "admin")], trips: [tripA, tripB] });
  db.data.trip_agent_runs.set("agent-run-b", {
    id: "agent-run-b",
    tripId: "trip-b",
    creatorUid: "fs_other",
    publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
    scope: ["submitProposalBatch"],
    status: "claimed",
    lastSequence: 0,
    revision: 2,
    createdAt: "2026-08-28T07:00:00.000Z",
    expiresAt: "2099-08-28T07:15:00.000Z",
  });
  const commands = createTripCommands({ db });

  await assert.rejects(
    () => commands.execute({ action: "getAgentRunStatus", tripId: "trip-a", agentRunId: "agent-run-b" }, "fs_admin"),
    { code: "FORBIDDEN" },
  );
});

test("agent run revoke conflicts include only the latest safe projection", async () => {
  const db = createDb({
    members: [member("fs_admin", "admin")],
    trips: [{ ...trip(), memberUids: ["fs_admin"] }],
  });
  db.data.trip_agent_runs.set("agent-run-1", {
    id: "agent-run-1",
    tripId: "trip-2026-autumn",
    creatorUid: "fs_admin",
    publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
    pairingCodeHash: "secret-hash",
    scope: ["submitProposalBatch"],
    status: "pending_claim",
    lastSequence: 0,
    revision: 2,
    createdAt: "2026-08-28T07:00:00.000Z",
    expiresAt: "2026-08-28T07:15:00.000Z",
  });
  const commands = createTripCommands({ db, now: () => new Date("2026-08-28T07:05:00.000Z") });

  await assert.rejects(
    () => commands.execute({ action: "revokeAgentRun", tripId: "trip-2026-autumn", agentRunId: "agent-run-1", expectedRevision: 1, idempotencyKey: "revoke-conflict-001" }, "fs_admin"),
    (error) => {
      assert.equal(error.code, "VERSION_CONFLICT");
      assert.equal(error.latest.revision, 2);
      assert.equal(error.latest.status, "pending_claim");
      assert.equal("publicKeyJwk" in error.latest, false);
      assert.equal("pairingCodeHash" in error.latest, false);
      return true;
    },
  );
});

test("invalid Agent signatures are rejected before trip or member data is read", async () => {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const db = createDb();
  db.data.trip_agent_runs.set("agent-run-invalid", {
    id: "agent-run-invalid",
    tripId: "trip-2026-autumn",
    creatorUid: "fs_member",
    publicKeyJwk: publicKey.export({ format: "jwk" }),
    pairingCodeHash: sha256Base64Url("pairing-code"),
    scope: ["submitProposalBatch"],
    status: "pending_claim",
    lastSequence: 0,
    revision: 1,
    expiresAt: "2026-08-31T00:15:00.000Z",
  });
  const originalRunTransaction = db.runTransaction.bind(db);
  db.runTransaction = (callback) => originalRunTransaction((transaction) => callback({
    collection(name) {
      if (name === "trips" || name === "members") throw new Error("MEMBER_DATA_READ_BEFORE_SIGNATURE");
      return transaction.collection(name);
    },
  }));
  const commands = createTripCommands({ db, now: () => new Date("2026-08-31T00:05:00.000Z") });

  await assert.rejects(() => commands.executeAgent({
    action: "claimAgentRun",
    agentRunId: "agent-run-invalid",
    pairingCode: "pairing-code",
    clientNonce: "nonce-001",
    signature: "invalid-signature",
  }), { code: "INVALID_AGENT_CLAIM" });
  await assert.rejects(() => commands.executeAgent({
    action: "getDecisionContext",
    agentRunId: "agent-run-invalid",
    sequence: 1,
    idempotencyKey: "invalid-command-001",
    payload: {},
    signature: "invalid-signature",
  }), { code: "INVALID_AGENT_CLAIM" });
});

test("claim rechecks that the AgentRun creator is still an administrator", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const db = createDb({
    members: [member("fs_admin", "admin")],
    trips: [{ ...trip(), memberUids: ["fs_admin"] }],
  });
  const commands = createTripCommands({
    db,
    now: () => new Date("2026-08-28T07:05:00.000Z"),
    randomId: () => "agent-run-1",
  });
  await commands.execute({
    action: "createAgentRun",
    tripId: "trip-2026-autumn",
    publicKeyJwk: publicKey.export({ format: "jwk" }),
    pairingCodeHash: sha256Base64Url("pairing-code"),
    scope: ["submitProposalBatch"],
    idempotencyKey: "create-demotion-run-001",
  }, "fs_admin");
  db.data.members.get("fs_admin").role = "member";
  const claim = { agentRunId: "agent-run-1", pairingCode: "pairing-code", clientNonce: "nonce-001" };

  await assert.rejects(
    () => commands.executeAgent({ action: "claimAgentRun", ...claim, signature: agentSignature(privateKey, claim) }),
    { code: "ADMIN_REQUIRED" },
  );
  assert.equal(db.data.trip_agent_runs.get("agent-run-1").status, "pending_claim");
  assert.equal(db.data.trip_agent_runs.get("agent-run-1").claimResult, undefined);
});

test("an exact claim replay is denied after the creator is demoted", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const db = createDb({
    members: [member("fs_admin", "admin")],
    trips: [{ ...trip(), memberUids: ["fs_admin"] }],
  });
  const commands = createTripCommands({
    db,
    now: () => new Date("2026-08-28T07:05:00.000Z"),
    randomId: () => "agent-run-1",
  });
  await commands.execute({
    action: "createAgentRun",
    tripId: "trip-2026-autumn",
    publicKeyJwk: publicKey.export({ format: "jwk" }),
    pairingCodeHash: sha256Base64Url("pairing-code"),
    scope: ["submitProposalBatch"],
    idempotencyKey: "create-claim-replay",
  }, "fs_admin");
  const claim = { agentRunId: "agent-run-1", pairingCode: "pairing-code", clientNonce: "nonce-001" };
  const envelope = { action: "claimAgentRun", ...claim, signature: agentSignature(privateKey, claim) };
  await commands.executeAgent(envelope);
  db.data.members.get("fs_admin").role = "member";

  await assert.rejects(() => commands.executeAgent(envelope), { code: "ADMIN_REQUIRED" });
});

test("a demoted creator cannot read context or submit, but can self-revoke with replay protection", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const ids = ["agent-run-1", "candidate-1", "evidence-1", "evidence-2", "candidate-2", "evidence-3", "evidence-4"];
  const db = createDb({
    members: [member("fs_admin", "admin")],
    trips: [{ ...trip(), memberUids: ["fs_admin"] }],
  });
  const commands = createTripCommands({
    db,
    now: () => new Date("2026-08-28T07:05:00.000Z"),
    randomId: () => ids.shift(),
  });
  await commands.execute({
    action: "createAgentRun",
    tripId: "trip-2026-autumn",
    publicKeyJwk: publicKey.export({ format: "jwk" }),
    pairingCodeHash: sha256Base64Url("pairing-code"),
    scope: ["submitProposalBatch"],
    idempotencyKey: "create-active-run-001",
  }, "fs_admin");
  const claim = { agentRunId: "agent-run-1", pairingCode: "pairing-code", clientNonce: "nonce-001" };
  await commands.executeAgent({
    action: "claimAgentRun",
    ...claim,
    signature: agentSignature(privateKey, claim),
  });
  db.data.members.get("fs_admin").role = "member";

  const context = {
    agentRunId: "agent-run-1",
    sequence: 1,
    idempotencyKey: "demoted-context-001",
    action: "getDecisionContext",
    payload: {},
  };
  await assert.rejects(
    () => commands.executeAgent({ ...context, signature: agentSignature(privateKey, context) }),
    { code: "ADMIN_REQUIRED" },
  );
  const submit = {
    agentRunId: "agent-run-1",
    sequence: 1,
    idempotencyKey: "demoted-submit-001",
    action: "submitProposalBatch",
    payload: { round: 1, candidates: [restaurantProposal("餐厅 A"), restaurantProposal("餐厅 B")] },
  };
  await assert.rejects(
    () => commands.executeAgent({ ...submit, signature: agentSignature(privateKey, submit) }),
    { code: "ADMIN_REQUIRED" },
  );
  assert.equal(db.data.trip_candidates.size, 0);
  assert.equal(db.data.trip_evidence_snapshots.size, 0);

  const revoke = {
    agentRunId: "agent-run-1",
    sequence: 1,
    idempotencyKey: "self-revoke-001",
    action: "revokeAgentRunSelf",
    payload: {},
  };
  const first = await commands.executeAgent({ ...revoke, signature: agentSignature(privateKey, revoke) });
  const replay = await commands.executeAgent({ ...revoke, signature: agentSignature(privateKey, revoke) });

  assert.deepEqual(first, {
    agentRunId: "agent-run-1",
    revokedAt: "2026-08-28T07:05:00.000Z",
    replayed: false,
  });
  assert.deepEqual(replay, { ...first, replayed: true });
  assert.deepEqual(Object.keys(first).sort(), ["agentRunId", "replayed", "revokedAt"]);
  assert.equal(db.data.trip_agent_runs.get("agent-run-1").status, "revoked");
  assert.equal(db.data.trip_agent_runs.get("agent-run-1").lastSequence, 1);
  assert.equal(db.data.trip_agent_runs.get("agent-run-1").revision, 3);
});

test("demotion blocks old context and submit replays while the self-revoke replay remains available", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const ids = ["agent-run-1", "candidate-1", "evidence-1", "evidence-2", "candidate-2", "evidence-3", "evidence-4"];
  const db = createDb({
    members: [member("fs_admin", "admin")],
    trips: [{ ...trip(), memberUids: ["fs_admin"] }],
  });
  const commands = createTripCommands({
    db,
    now: () => new Date("2026-08-28T07:05:00.000Z"),
    randomId: () => ids.shift(),
  });
  await commands.execute({
    action: "createAgentRun",
    tripId: "trip-2026-autumn",
    publicKeyJwk: publicKey.export({ format: "jwk" }),
    pairingCodeHash: sha256Base64Url("pairing-code"),
    scope: ["submitProposalBatch"],
    idempotencyKey: "create-replay-run-001",
  }, "fs_admin");
  const claim = { agentRunId: "agent-run-1", pairingCode: "pairing-code", clientNonce: "nonce-001" };
  await commands.executeAgent({ action: "claimAgentRun", ...claim, signature: agentSignature(privateKey, claim) });
  const context = {
    agentRunId: "agent-run-1",
    sequence: 1,
    idempotencyKey: "context-before-demotion",
    action: "getDecisionContext",
    payload: {},
  };
  const submit = {
    agentRunId: "agent-run-1",
    sequence: 2,
    idempotencyKey: "submit-before-demotion",
    action: "submitProposalBatch",
    payload: { round: 1, candidates: [restaurantProposal("餐厅 A"), restaurantProposal("餐厅 B")] },
  };
  await commands.executeAgent({ ...context, signature: agentSignature(privateKey, context) });
  await commands.executeAgent({ ...submit, signature: agentSignature(privateKey, submit) });
  db.data.members.get("fs_admin").role = "member";

  await assert.rejects(
    () => commands.executeAgent({ ...context, signature: agentSignature(privateKey, context) }),
    { code: "ADMIN_REQUIRED" },
  );
  await assert.rejects(
    () => commands.executeAgent({ ...submit, signature: agentSignature(privateKey, submit) }),
    { code: "ADMIN_REQUIRED" },
  );
  assert.equal(db.data.trip_candidates.size, 2);
  assert.equal(db.data.trip_evidence_snapshots.size, 4);

  const revoke = {
    agentRunId: "agent-run-1",
    sequence: 3,
    idempotencyKey: "self-revoke-after-demotion",
    action: "revokeAgentRunSelf",
    payload: {},
  };
  const first = await commands.executeAgent({ ...revoke, signature: agentSignature(privateKey, revoke) });
  const replay = await commands.executeAgent({ ...revoke, signature: agentSignature(privateKey, revoke) });
  assert.equal(first.replayed, false);
  assert.deepEqual(replay, { ...first, replayed: true });
});

test("demotion blocks legacy scoped Agent actions on replay and fresh envelopes without writes", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const db = createDb({
    members: [member("fs_admin", "admin"), member("fs_member", "member")],
    trips: [{ ...trip(), memberUids: ["fs_admin", "fs_member"] }],
    candidates: [candidate({
      entity: { name: "海边酒店", address: "香港" },
      applicability: { dates: { start: "2026-10-01", end: "2026-10-02" }, travelers: 2 },
      recommendation: { round: 1, reason: "位置合适", preferenceRevisionIds: [], feedbackIds: [] },
      verificationState: "candidate",
      decisionState: "none",
    })],
  });
  for (const uid of ["fs_admin", "fs_member"]) {
    db.data.trip_preferences.set(`trip-2026-autumn:${uid}`, {
      id: `trip-2026-autumn:${uid}`,
      tripId: "trip-2026-autumn",
      ownerUid: uid,
      answers: { pace: "slow" },
      status: "completed",
      revision: 1,
      updatedAt: "2026-08-28T07:00:00.000Z",
      updatedBy: uid,
    });
  }
  db.data.trip_agent_runs.set("legacy-run-1", {
    id: "legacy-run-1",
    tripId: "trip-2026-autumn",
    creatorUid: "fs_admin",
    publicKeyJwk: publicKey.export({ format: "jwk" }),
    scope: ["appendEvidenceSnapshot", "reportVerificationBlocked", "generatePreferenceSummary"],
    status: "claimed",
    lastSequence: 0,
    revision: 2,
    expiresAt: "2026-08-28T08:00:00.000Z",
  });
  const commands = createTripCommands({
    db,
    now: () => new Date("2026-08-28T07:10:00.000Z"),
    randomId: () => "legacy-evidence-1",
  });
  const append = {
    agentRunId: "legacy-run-1",
    sequence: 1,
    idempotencyKey: "legacy-append-001",
    action: "appendEvidenceSnapshot",
    payload: {
      candidateId: "candidate-1",
      expectedCandidateRevision: 2,
      evidence: {
        sourceKind: "manual",
        sourceName: "管理员手工证据",
        capturedAt: "2026-08-28T07:00:00.000Z",
        queryContext: {},
        captureMethod: "manual",
        facts: { name: "海边酒店", address: "香港", openInformation: "not_provided", priceSnapshot: "not_provided" },
      },
    },
  };
  const report = {
    agentRunId: "legacy-run-1",
    sequence: 2,
    idempotencyKey: "legacy-report-001",
    action: "reportVerificationBlocked",
    payload: { candidateId: "candidate-1", expectedCandidateRevision: 3, reason: "captcha" },
  };
  const summary = {
    agentRunId: "legacy-run-1",
    sequence: 3,
    idempotencyKey: "legacy-summary-001",
    action: "generatePreferenceSummary",
    payload: { sourcePreferenceRevisions: { fs_admin: 1, fs_member: 1 } },
  };
  for (const envelope of [append, report, summary]) {
    await commands.executeAgent({ ...envelope, signature: agentSignature(privateKey, envelope) });
  }
  const beforeDemotion = {
    candidate: structuredClone(db.data.trip_candidates.get("candidate-1")),
    evidenceCount: db.data.trip_evidence_snapshots.size,
    summary: structuredClone(db.data.trip_preference_summaries.get("trip-2026-autumn")),
    eventCount: db.data.trip_decision_events.size,
    auditCount: db.data.decisionAudits.length,
    run: structuredClone(db.data.trip_agent_runs.get("legacy-run-1")),
  };
  db.data.members.get("fs_admin").role = "member";

  for (const envelope of [append, report, summary]) {
    await assert.rejects(
      () => commands.executeAgent({ ...envelope, signature: agentSignature(privateKey, envelope) }),
      { code: "ADMIN_REQUIRED" },
    );
    const fresh = { ...envelope, sequence: 4, idempotencyKey: `${envelope.action}-fresh` };
    await assert.rejects(
      () => commands.executeAgent({ ...fresh, signature: agentSignature(privateKey, fresh) }),
      { code: "ADMIN_REQUIRED" },
    );
  }
  assert.deepEqual(db.data.trip_candidates.get("candidate-1"), beforeDemotion.candidate);
  assert.equal(db.data.trip_evidence_snapshots.size, beforeDemotion.evidenceCount);
  assert.deepEqual(db.data.trip_preference_summaries.get("trip-2026-autumn"), beforeDemotion.summary);
  assert.equal(db.data.trip_decision_events.size, beforeDemotion.eventCount);
  assert.equal(db.data.decisionAudits.length, beforeDemotion.auditCount);
  assert.deepEqual(db.data.trip_agent_runs.get("legacy-run-1"), beforeDemotion.run);
});

test("a claimed scoped agent submits an atomic two-candidate proposal batch", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const ids = ["agent-run-1", "candidate-1", "evidence-1", "evidence-2", "candidate-2", "evidence-3", "evidence-4"];
  const db = createDb({
    members: [member("fs_admin", "admin")],
    trips: [{ ...trip(), memberUids: ["fs_admin"] }],
  });
  const commands = createTripCommands({
    db,
    now: () => new Date("2026-08-28T07:05:00.000Z"),
    randomId: () => ids.shift(),
  });
  await commands.execute({
    action: "createAgentRun",
    tripId: "trip-2026-autumn",
    publicKeyJwk: publicKey.export({ format: "jwk" }),
    pairingCodeHash: sha256Base64Url("pairing-code"),
    scope: ["submitProposalBatch"],
    idempotencyKey: "create-proposal-run-001",
  }, "fs_admin");
  const claim = { action: "claimAgentRun", agentRunId: "agent-run-1", pairingCode: "pairing-code", clientNonce: "nonce-001" };
  await commands.executeAgent({ ...claim, signature: agentSignature(privateKey, { agentRunId: claim.agentRunId, pairingCode: claim.pairingCode, clientNonce: claim.clientNonce }) });

  const signed = {
    agentRunId: "agent-run-1",
    sequence: 1,
    idempotencyKey: "proposal-batch-001",
    action: "submitProposalBatch",
    payload: { round: 1, candidates: [restaurantProposal("餐厅 A"), restaurantProposal("餐厅 B")] },
  };
  const result = await commands.executeAgent({ ...signed, signature: agentSignature(privateKey, signed) });
  const eventCountAfterFirstSubmit = db.data.trip_decision_events.size;
  const auditCountAfterFirstSubmit = db.data.decisionAudits.length;
  const replay = await commands.executeAgent({ ...signed, signature: agentSignature(privateKey, signed) });

  assert.equal(result.candidates.length, 2);
  assert.equal(result.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.candidates.map(({ id }) => id), result.candidates.map(({ id }) => id));
  assert.equal(result.candidates[0].verificationState, "candidate");
  assert.equal(result.candidates[0].decisionState, "none");
  assert.equal(db.data.trip_candidates.size, 2);
  assert.equal(db.data.trip_evidence_snapshots.size, 4);
  assert.equal(db.data.trip_decision_events.size, eventCountAfterFirstSubmit);
  assert.equal(db.data.decisionAudits.length, auditCountAfterFirstSubmit);
  assert.equal(db.data.trip_agent_runs.get("agent-run-1").lastSequence, 1);
  const workspace = await commands.execute({ action: "getDecisionWorkspace", tripId: "trip-2026-autumn" }, "fs_admin");
  assert.equal(workspace.candidates.length, 2);
  assert.equal(workspace.evidence.length, 4);

  const contextCommand = {
    agentRunId: "agent-run-1",
    sequence: 2,
    idempotencyKey: "decision-context-001",
    action: "getDecisionContext",
    payload: {},
  };
  const context = await commands.executeAgent({ ...contextCommand, signature: agentSignature(privateKey, contextCommand) });
  assert.equal(context.context.workspace.tripId, "trip-2026-autumn");
  assert.equal(context.context.workspace.candidates.length, 2);
  assert.deepEqual(context.context.trip, {
    version: 0,
    days: [{ id: "day-1", date: "2026-10-01", city: "香港" }],
    travelerNames: ["一鸣"],
    travelerCount: 1,
  });
  assert.equal(JSON.stringify(context.context).includes("publicKeyJwk"), false);
  assert.equal(JSON.stringify(context.context).includes("pairingCodeHash"), false);

  const activeStatus = await commands.execute({
    action: "getAgentRunStatus",
    tripId: "trip-2026-autumn",
    agentRunId: "agent-run-1",
  }, "fs_admin");
  await commands.execute({
    action: "revokeAgentRun",
    tripId: "trip-2026-autumn",
    agentRunId: "agent-run-1",
    expectedRevision: activeStatus.revision,
    idempotencyKey: "revoke-active-agent-001",
  }, "fs_admin");
  const afterRevoke = {
    agentRunId: "agent-run-1",
    sequence: 3,
    idempotencyKey: "context-after-revoke-001",
    action: "getDecisionContext",
    payload: {},
  };
  await assert.rejects(
    () => commands.executeAgent({ ...afterRevoke, signature: agentSignature(privateKey, afterRevoke) }),
    { code: "INVALID_AGENT_CLAIM" },
  );
});

test("Agent decision context returns a whitelist Trip projection using traveler names from the Trip", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const safeTripSource = {
    ...trip(7),
    travelers: [
      { id: "traveler-secret-a", name: "一鸣" },
      { id: "traveler-secret-b", name: "美垚" },
    ],
    days: [{
      id: "day-1",
      date: "2026-10-01",
      city: "香港",
      itemIds: ["item-secret"],
      hotelId: "hotel-secret",
    }],
    orders: [{
      id: "order-secret",
      name: "私密订单",
      category: "hotel",
      estimated: 100,
      paid: 0,
      currency: "CNY",
      status: "unpaid",
    }],
    memberUids: ["fs_admin", "fs_partner"],
    pairingSecret: "must-not-leak",
  };
  const db = createDb({
    members: [member("fs_admin", "admin", "不应用此名"), member("fs_partner", "member", "也不应用此名")],
    trips: [safeTripSource],
  });
  db.data.trip_agent_runs.set("agent-run-1", {
    id: "agent-run-1",
    tripId: "trip-2026-autumn",
    creatorUid: "fs_admin",
    publicKeyJwk: publicKey.export({ format: "jwk" }),
    scope: ["submitProposalBatch"],
    status: "claimed",
    lastSequence: 0,
    revision: 2,
    expiresAt: "2026-08-28T08:00:00.000Z",
  });
  const originalRunTransaction = db.runTransaction.bind(db);
  db.runTransaction = (callback) => originalRunTransaction((transaction) => callback({
    collection(name) {
      const original = transaction.collection(name);
      if (name !== "members") return original;
      return {
        ...original,
        doc(id) {
          if (id === "fs_partner") throw new Error("TRAVELER_MEMBER_RECORD_READ");
          return original.doc(id);
        },
      };
    },
  }));
  const commands = createTripCommands({ db, now: () => new Date("2026-08-28T07:05:00.000Z") });
  const signed = {
    agentRunId: "agent-run-1",
    sequence: 1,
    idempotencyKey: "safe-context-001",
    action: "getDecisionContext",
    payload: {},
  };

  const result = await commands.executeAgent({ ...signed, signature: agentSignature(privateKey, signed) });

  assert.deepEqual(result.context.trip, {
    version: 7,
    days: [{ id: "day-1", date: "2026-10-01", city: "香港" }],
    travelerNames: ["一鸣", "美垚"],
    travelerCount: 2,
  });
  const serializedTrip = JSON.stringify(result.context.trip);
  for (const secret of ["fs_admin", "fs_partner", "traveler-secret", "item-secret", "hotel-secret", "order-secret", "pairingSecret"]) {
    assert.equal(serializedTrip.includes(secret), false);
  }
  assert.equal(result.context.workspace.tripId, "trip-2026-autumn");
});

test("Agent decision context fails closed when a stored Trip has no travelers", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const db = createDb({
    members: [member("fs_admin", "admin")],
    trips: [{ ...trip(), travelers: [], memberUids: ["fs_admin"] }],
  });
  db.data.trip_agent_runs.set("agent-run-1", {
    id: "agent-run-1",
    tripId: "trip-2026-autumn",
    creatorUid: "fs_admin",
    publicKeyJwk: publicKey.export({ format: "jwk" }),
    scope: ["submitProposalBatch"],
    status: "claimed",
    lastSequence: 0,
    revision: 2,
    expiresAt: "2026-08-28T08:00:00.000Z",
  });
  const commands = createTripCommands({ db, now: () => new Date("2026-08-28T07:05:00.000Z") });
  const signed = {
    agentRunId: "agent-run-1",
    sequence: 1,
    idempotencyKey: "empty-travelers-001",
    action: "getDecisionContext",
    payload: {},
  };

  await assert.rejects(
    () => commands.executeAgent({ ...signed, signature: agentSignature(privateKey, signed) }),
    { code: "INVALID_REQUEST" },
  );
  assert.equal(db.data.trip_agent_idempotency.size, 0);
  assert.equal(db.data.trip_agent_runs.get("agent-run-1").lastSequence, 0);
});

test("proposal batches reject duplicate normalized HTTPS origins before writing anything", async () => {
  const variants = [
    ["https://source.example/a", "https://source.example/b?different=1"],
    ["https://SOURCE.example/a", "https://source.example/b"],
    ["https://source.example:443/a", "https://source.example/b"],
    ["https://source.example./a", "https://source.example/b"],
    ["https://SOURCE.EXAMPLE.:443/a", "https://source.example/b"],
    ["https://[2001:db8::1]:443/a", "https://[2001:db8::1]/b?different=1"],
  ];

  for (const [firstUrl, secondUrl] of variants) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const db = createDb({
      members: [member("fs_admin", "admin")],
      trips: [{ ...trip(), memberUids: ["fs_admin"] }],
    });
    db.data.trip_agent_runs.set("agent-run-1", {
      id: "agent-run-1",
      tripId: "trip-2026-autumn",
      creatorUid: "fs_admin",
      publicKeyJwk: publicKey.export({ format: "jwk" }),
      scope: ["submitProposalBatch"],
      status: "claimed",
      lastSequence: 0,
      revision: 2,
      expiresAt: "2026-08-28T08:00:00.000Z",
    });
    const commands = createTripCommands({ db, now: () => new Date("2026-08-28T07:05:00.000Z") });
    const duplicateOrigin = restaurantProposal("餐厅 A", [firstUrl, secondUrl]);
    const signed = {
      agentRunId: "agent-run-1",
      sequence: 1,
      idempotencyKey: "duplicate-origin-001",
      action: "submitProposalBatch",
      payload: { round: 1, candidates: [duplicateOrigin, restaurantProposal("餐厅 B")] },
    };

    await assert.rejects(
      () => commands.executeAgent({ ...signed, signature: agentSignature(privateKey, signed) }),
      { code: "INVALID_REQUEST" },
    );
    assert.equal(db.data.trip_candidates.size, 0);
    assert.equal(db.data.trip_evidence_snapshots.size, 0);
    assert.equal(db.data.trip_decision_events.size, 0);
    assert.equal(db.data.trip_agent_idempotency.size, 0);
    assert.equal(db.data.trip_agent_runs.get("agent-run-1").lastSequence, 0);
  }
});

test("proposal-only schemas require deep-strict HTTPS evidence", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const db = createDb({
    members: [member("fs_admin", "admin")],
    trips: [{ ...trip(), memberUids: ["fs_admin"] }],
  });
  db.data.trip_agent_runs.set("agent-run-1", {
    id: "agent-run-1",
    tripId: "trip-2026-autumn",
    creatorUid: "fs_admin",
    publicKeyJwk: publicKey.export({ format: "jwk" }),
    scope: ["submitProposalBatch"],
    status: "claimed",
    lastSequence: 0,
    revision: 2,
    expiresAt: "2026-08-28T08:00:00.000Z",
  });
  const commands = createTripCommands({ db, now: () => new Date("2026-08-28T07:05:00.000Z") });
  const invalidCandidates = [
    restaurantProposal("餐厅 A", [undefined, "https://guide.example/a"]),
    restaurantProposal("餐厅 A", ["http://flyai.example/a", "https://guide.example/a"]),
    restaurantProposal("餐厅 A", ["https://flyai.example/a#", "https://guide.example/a"]),
    restaurantProposal("餐厅 A", ["https://./a", "https://guide.example/a"]),
    {
      ...restaurantProposal("餐厅 A"),
      evidence: restaurantProposal("餐厅 A").evidence.map((evidence, index) => (
        index === 0 ? { ...evidence, queryContext: { ...evidence.queryContext, leaked: "secret" } } : evidence
      )),
    },
    { ...restaurantProposal("餐厅 A"), leaked: "secret" },
  ];
  for (const [index, invalidCandidate] of invalidCandidates.entries()) {
    const signed = {
      agentRunId: "agent-run-1",
      sequence: 1,
      idempotencyKey: `strict-proposal-${index}`,
      action: "submitProposalBatch",
      payload: { round: 1, candidates: [invalidCandidate, restaurantProposal("餐厅 B")] },
    };
    await assert.rejects(
      () => commands.executeAgent({ ...signed, signature: agentSignature(privateKey, signed) }),
      { code: "INVALID_REQUEST" },
    );
  }
  assert.equal(db.data.trip_candidates.size, 0);
  assert.equal(db.data.trip_evidence_snapshots.size, 0);
  assert.equal(db.data.trip_decision_events.size, 0);
  assert.equal(db.data.trip_agent_idempotency.size, 0);
  assert.equal(db.data.trip_agent_runs.get("agent-run-1").lastSequence, 0);
});

test("agent web evidence is server-verified, changed evidence becomes stale, and blockage is explicit", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const db = createDb({
    members: [member("fs_member", "admin")],
    trips: [{ ...trip(), memberUids: ["fs_member"] }],
    candidates: [candidate({
      category: "hotel",
      entity: { name: "海边酒店", address: "香港" },
      applicability: { dates: { start: "2026-10-01", end: "2026-10-02" }, travelers: 2 },
      recommendation: { round: 1, reason: "位置合适", preferenceRevisionIds: [], feedbackIds: [] },
      verificationState: "candidate",
      decisionState: "none",
    })],
  });
  db.data.trip_agent_runs.set("agent-run-1", {
    id: "agent-run-1",
    tripId: "trip-2026-autumn",
    creatorUid: "fs_member",
    publicKeyJwk: publicKey.export({ format: "jwk" }),
    scope: ["appendEvidenceSnapshot", "reportVerificationBlocked"],
    status: "claimed",
    lastSequence: 0,
    revision: 2,
    expiresAt: "2026-08-28T08:00:00.000Z",
  });
  const evidenceIds = ["evidence-web-1", "evidence-stale-1", "evidence-recovered-1"];
  const commands = createTripCommands({ db, now: () => new Date("2026-08-28T07:10:00.000Z"), randomId: () => evidenceIds.shift() });
  const evidenceCommand = {
    agentRunId: "agent-run-1",
    sequence: 1,
    idempotencyKey: "web-evidence-001",
    action: "appendEvidenceSnapshot",
    payload: {
      candidateId: "candidate-1",
      expectedCandidateRevision: 2,
      evidence: {
        sourceKind: "official",
        sourceName: "酒店官网",
        sourceUrl: "https://example.com/hotel",
        capturedAt: "2026-08-28T07:00:00.000Z",
        queryContext: { dates: { start: "2026-10-01", end: "2026-10-02" }, travelers: 2, roomOrTicket: "双床房" },
        captureMethod: "detail_page",
        facts: {
          propertyName: "海边酒店",
          address: "香港",
          checkInDate: "2026-10-01",
          checkOutDate: "2026-10-02",
          travelers: 2,
          roomTypeOrBed: "双床房",
          availability: "available",
          priceAmount: 1800,
          currency: "HKD",
          priceDisplay: "total",
          cancellationPolicy: "入住前一天可取消",
        },
      },
    },
  };
  const verified = await commands.executeAgent({ ...evidenceCommand, signature: agentSignature(privateKey, evidenceCommand) });
  assert.equal(verified.evidence.verificationOutcome, "web_verified");
  assert.equal(verified.candidate.verificationState, "web_verified");
  assert.equal(verified.candidate.revision, 3);

  const changedEvidenceCommand = {
    agentRunId: "agent-run-1",
    sequence: 2,
    idempotencyKey: "changed-evidence-001",
    action: "appendEvidenceSnapshot",
    payload: {
      candidateId: "candidate-1",
      expectedCandidateRevision: 3,
      evidence: {
        sourceKind: "flyai",
        sourceName: "FlyAI",
        capturedAt: "2026-08-28T07:08:00.000Z",
        queryContext: { dates: { start: "2026-10-01", end: "2026-10-02" }, travelers: 2, roomOrTicket: "双床房" },
        captureMethod: "api_result",
        facts: {
          propertyName: "海边酒店",
          address: "香港",
          checkInDate: "2026-10-01",
          checkOutDate: "2026-10-02",
          travelers: 2,
          roomTypeOrBed: "双床房",
          availability: "available",
          priceAmount: 2100,
          currency: "HKD",
          priceDisplay: "total",
          cancellationPolicy: "不可取消",
        },
        supersedesEvidenceId: "evidence-web-1",
        changeReason: "价格与取消政策发生变化",
      },
    },
  };
  const changed = await commands.executeAgent({ ...changedEvidenceCommand, signature: agentSignature(privateKey, changedEvidenceCommand) });
  assert.equal(changed.evidence.verificationOutcome, "stale");
  assert.equal(changed.candidate.verificationState, "stale");
  assert.equal(changed.candidate.currentEvidenceId, "evidence-stale-1");
  assert.equal(db.data.trip_evidence_snapshots.get("evidence-web-1").verificationOutcome, "web_verified");

  const blockedCommand = {
    agentRunId: "agent-run-1",
    sequence: 3,
    idempotencyKey: "web-blocked-001",
    action: "reportVerificationBlocked",
    payload: { candidateId: "candidate-1", expectedCandidateRevision: 4, reason: "captcha" },
  };
  const blocked = await commands.executeAgent({ ...blockedCommand, signature: agentSignature(privateKey, blockedCommand) });
  assert.equal(blocked.candidate.verificationState, "needs_takeover");
  assert.equal(blocked.candidate.verificationBlockReason, "captcha");
  assert.equal(blocked.candidate.changeReason, undefined);
  assert.equal(blocked.candidate.revision, 5);

  const recoveredCommand = {
    agentRunId: "agent-run-1",
    sequence: 4,
    idempotencyKey: "web-recovered-001",
    action: "appendEvidenceSnapshot",
    payload: {
      candidateId: "candidate-1",
      expectedCandidateRevision: 5,
      evidence: { ...evidenceCommand.payload.evidence, capturedAt: "2026-08-28T07:09:00.000Z" },
    },
  };
  const recovered = await commands.executeAgent({ ...recoveredCommand, signature: agentSignature(privateKey, recoveredCommand) });
  assert.equal(recovered.candidate.verificationState, "web_verified");
  assert.equal(recovered.candidate.verificationBlockReason, undefined);
});

test("a scoped agent generates a summary only for the supplied current revisions", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const db = createDb({
    members: [member("fs_admin", "admin"), member("fs_member", "member")],
    trips: [{ ...trip(), memberUids: ["fs_admin", "fs_member"] }],
  });
  for (const uid of ["fs_admin", "fs_member"]) {
    db.data.trip_preferences.set(`trip-2026-autumn:${uid}`, {
      id: `trip-2026-autumn:${uid}`,
      tripId: "trip-2026-autumn",
      ownerUid: uid,
      answers: { pace: "slow" },
      status: "completed",
      revision: 2,
      updatedAt: "2026-08-28T07:00:00.000Z",
      updatedBy: uid,
    });
  }
  db.data.trip_agent_runs.set("agent-run-1", {
    id: "agent-run-1",
    tripId: "trip-2026-autumn",
    creatorUid: "fs_admin",
    publicKeyJwk: publicKey.export({ format: "jwk" }),
    scope: ["generatePreferenceSummary"],
    status: "claimed",
    lastSequence: 0,
    revision: 2,
    expiresAt: "2026-08-28T08:00:00.000Z",
  });
  const commands = createTripCommands({ db, now: () => new Date("2026-08-28T07:20:00.000Z") });
  const signed = {
    agentRunId: "agent-run-1",
    sequence: 1,
    idempotencyKey: "agent-summary-001",
    action: "generatePreferenceSummary",
    payload: { sourcePreferenceRevisions: { fs_admin: 2, fs_member: 2 } },
  };

  const result = await commands.executeAgent({ ...signed, signature: agentSignature(privateKey, signed) });

  assert.equal(result.summary.status, "ready");
  assert.equal(result.summary.common.length, 1);
  assert.equal(db.data.decisionAudits.at(-1).actorType, "agent");
});

test("an authenticated pending user can read only their own safe member profile", async () => {
  const db = createDb({ members: [member("fs_pending", "pending", "美垚")] });
  const commands = createTripCommands({ db });

  assert.deepEqual(
    await commands.execute({ action: "getCurrentMember" }, "fs_pending"),
    { member: { uid: "fs_pending", role: "pending", displayName: "美垚", version: 0, createdAt: "2026-08-27T00:00:00.000Z" } },
  );
  await assert.rejects(() => commands.execute({ action: "getCurrentMember" }, "fs_missing"), { code: "MEMBERSHIP_REQUIRED" });
});

test("removing the final administrator is rejected", async () => {
  const db = createDb({ members: [member("fs_admin", "admin", "一鸣")] });
  const commands = createTripCommands({ db });

  await assert.rejects(() => commands.execute({ action: "removeMember", uid: "fs_admin" }, "fs_admin"), { code: "LAST_ADMIN" });
});

test("saveTrip writes once per idempotency key and rejects stale versions", async () => {
  const db = createDb({ members: [member("fs_admin", "admin", "一鸣")], trips: [{ ...trip(), memberUids: ["fs_admin"] }] });
  const commands = createTripCommands({ db, now: () => new Date("2026-08-27T12:00:00.000Z") });
  const event = { action: "saveTrip", trip: { ...trip(), title: "更新后的旅行" }, expectedVersion: 0, idempotencyKey: "save-001" };

  const saved = await commands.execute(event, "fs_admin");
  assert.deepEqual(db.data.idempotency.get("save-001"), { actorUid: "fs_admin", tripId: "trip-2026-autumn", expectedVersion: 0, trip: saved.trip, createdAt: "2026-08-27T12:00:00.000Z" });
  const replay = await commands.execute(event, "fs_admin");

  assert.equal(saved.trip.version, 1);
  assert.deepEqual(replay, saved);
  assert.equal(db.data.trips.get("trip-2026-autumn").version, 1);
  await assert.rejects(() => commands.execute({ ...event, idempotencyKey: "save-002" }, "fs_admin"), { code: "VERSION_CONFLICT" });
});

test("saveTrip requires the actor to belong to the trip", async () => {
  const db = createDb({
    members: [member("fs_member", "member")],
    trips: [{ ...trip(), memberUids: ["fs_other"] }],
  });
  const commands = createTripCommands({ db });

  await assert.rejects(
    () => commands.execute({ action: "saveTrip", trip: { ...trip(), memberUids: ["fs_other"], title: "越权" }, expectedVersion: 0, idempotencyKey: "write-unauthorized" }, "fs_member"),
    { code: "FORBIDDEN" },
  );
  assert.equal(db.data.trips.get("trip-2026-autumn").title, "秋日旅行");
});

test("saveTrip rejects a stored trip without a server-owned membership list", async () => {
  const db = createDb({ members: [member("fs_admin", "admin")] });
  const commands = createTripCommands({ db });

  await assert.rejects(
    () => commands.execute({ action: "saveTrip", trip: trip(), expectedVersion: 0, idempotencyKey: "missing-members" }, "fs_admin"),
    { code: "INVALID_TRIP" },
  );
  assert.equal(db.data.trips.get("trip-2026-autumn").version, 0);
});

test("saveTrip rejects malformed stored membership instead of claiming the trip", async () => {
  const db = createDb({
    members: [member("fs_admin", "admin")],
    trips: [{ ...trip(), memberUids: ["x"] }],
  });
  const commands = createTripCommands({ db });

  await assert.rejects(
    () => commands.execute({ action: "saveTrip", trip: trip(), expectedVersion: 0, idempotencyKey: "malformed-members" }, "fs_admin"),
    { code: "INVALID_TRIP" },
  );
});

test("a member cannot alter the server-owned trip membership list", async () => {
  const db = createDb({
    members: [member("fs_member", "member")],
    trips: [{ ...trip(), memberUids: ["fs_member"] }],
  });
  const commands = createTripCommands({ db });

  const result = await commands.execute({
    action: "saveTrip",
    trip: { ...trip(), memberUids: ["fs_attacker"], title: "越权加入" },
    expectedVersion: 0,
    idempotencyKey: "member-membership",
  }, "fs_member");

  assert.deepEqual(result.trip.memberUids, ["fs_member"]);
  assert.deepEqual(db.data.trips.get("trip-2026-autumn").memberUids, ["fs_member"]);
});

test("saveTrip validates orders with the TripSchema contract", async () => {
  const db = createDb({ members: [member("fs_admin", "admin")] });
  const commands = createTripCommands({ db });

  await assert.rejects(
    () => commands.execute({
      action: "saveTrip",
      trip: { ...trip(), orders: [{ id: "flight-1", name: "机票" }] },
      expectedVersion: 0,
      idempotencyKey: "invalid-order",
    }, "fs_admin"),
    { code: "INVALID_REQUEST" },
  );
  assert.equal(db.data.trips.get("trip-2026-autumn").version, 0);
});

test("idempotency keys are bound to the original expected version", async () => {
  const db = createDb({ members: [member("fs_admin", "admin")], trips: [{ ...trip(), memberUids: ["fs_admin"] }] });
  const commands = createTripCommands({ db });
  const event = { action: "saveTrip", trip: trip(), expectedVersion: 0, idempotencyKey: "save-bound" };

  await commands.execute(event, "fs_admin");
  await assert.rejects(
    () => commands.execute({ ...event, expectedVersion: 1 }, "fs_admin"),
    { code: "IDEMPOTENCY_KEY_REUSED" },
  );
});

test("idempotency replay treats omitted TripSchema defaults as the same request", async () => {
  const db = createDb({ members: [member("fs_admin", "admin")], trips: [{ ...trip(), memberUids: ["fs_admin"] }] });
  const commands = createTripCommands({ db });
  db.data.idempotency.set("defaults-replay", {
    actorUid: "fs_admin",
    tripId: "trip-2026-autumn",
    expectedVersion: 0,
    trip: { ...trip(1), memberUids: ["fs_admin"], orders: undefined },
    createdAt: "2026-08-27T12:00:00.000Z",
  });
  const event = { action: "saveTrip", trip: trip(), expectedVersion: 0, idempotencyKey: "defaults-replay" };

  assert.deepEqual(await commands.execute(event, "fs_admin"), { trip: { ...trip(1), memberUids: ["fs_admin"], orders: undefined } });
});

test("removeMember revokes trip membership and sessions in the same transaction", async () => {
  const db = createDb({
    members: [member("fs_admin", "admin"), member("fs_member", "member")],
    trips: [
      { ...trip(), memberUids: ["fs_admin", "fs_member"] },
      { ...trip(), id: "other-trip", memberUids: ["fs_member"] },
    ],
    authSessions: [
      { _id: "session-1", uid: "fs_member", oauthState: "state-1", expiresAt: 9999999999999, revoked: false },
      { _id: "session-2", uid: "fs_other", oauthState: "state-2", expiresAt: 9999999999999, revoked: false },
    ],
  });
  db.data.members.get("fs_member").tripIds = ["trip-2026-autumn", "other-trip"];
  db.data.members.get("fs_member").sessionIds = ["session-1"];
  const commands = createTripCommands({ db, now: () => new Date("2026-08-27T12:00:00.000Z") });

  await commands.execute({ action: "removeMember", uid: "fs_member" }, "fs_admin");

  assert.deepEqual(db.data.trips.get("trip-2026-autumn").memberUids, ["fs_admin"]);
  assert.deepEqual(db.data.trips.get("other-trip").memberUids, []);
  assert.equal(db.data.auth_sessions.get("session-1").revoked, true);
  assert.equal(db.data.auth_sessions.get("session-1").expiresAt, Date.parse("2026-08-27T12:00:00.000Z"));
  assert.equal(db.data.auth_sessions.get("session-2").revoked, false);
});

test("removing a member returns confirmed candidates in their trip to tentative", async () => {
  const admin = { ...member("fs_admin", "admin"), tripIds: ["trip-2026-autumn"] };
  const removed = { ...member("fs_member", "member"), tripIds: ["trip-2026-autumn"] };
  const db = createDb({
    members: [admin, removed],
    trips: [{ ...trip(), memberUids: ["fs_admin", "fs_member"] }],
    candidates: [candidate({ decisionState: "confirmed", revision: 4 })],
  });
  db.data.trip_decision_indexes.set("trip-2026-autumn", { candidateIds: ["candidate-1"] });
  const commands = createTripCommands({ db, now: () => new Date("2026-08-28T09:00:00.000Z") });

  await commands.execute({ action: "removeMember", uid: "fs_member" }, "fs_admin");

  assert.equal(db.data.trip_candidates.get("candidate-1").decisionState, "tentative");
  assert.equal(db.data.trip_candidates.get("candidate-1").revision, 5);
});

test("removeMember fails closed when server-owned associations are missing", async () => {
  const db = createDb({
    members: [member("fs_admin", "admin"), { ...member("fs_member", "member"), tripIds: undefined }],
    trips: [{ ...trip(), memberUids: ["fs_admin", "fs_member"] }],
  });
  const commands = createTripCommands({ db });

  await assert.rejects(() => commands.execute({ action: "removeMember", uid: "fs_member" }, "fs_admin"), { code: "MEMBERSHIP_ASSOCIATIONS_UNAVAILABLE" });
  assert.equal(db.data.members.get("fs_member").role, "member");
  assert.deepEqual(db.data.trips.get("trip-2026-autumn").memberUids, ["fs_admin", "fs_member"]);
});

test("audit records include actor UID and safe changed fields only", async () => {
  const db = createDb({
    members: [{ ...member("fs_admin", "admin", "一鸣"), tripIds: ["trip-2026-autumn"] }, member("fs_pending", "pending", "美垚")],
    trips: [{ ...trip(), memberUids: ["fs_admin"] }],
  });
  const commands = createTripCommands({ db, now: () => new Date("2026-08-27T12:00:00.000Z") });

  await commands.execute({ action: "approveMember", uid: "fs_pending" }, "fs_admin");

  assert.deepEqual(db.data.audits[0], {
    actorUid: "fs_admin",
    actorName: "一鸣",
    action: "approveMember",
    targetName: "美垚",
    changedFields: ["role", "version", "approvedAt", "tripIds", "memberUids"],
    createdAt: "2026-08-27T12:00:00.000Z",
  });
  assert.equal("openId" in db.data.audits[0], false);
  assert.equal("openIdHash" in db.data.audits[0], false);
});

function expectMember(uid, role, displayName) {
  return { uid, role, displayName, version: 1, createdAt: "2026-08-27T00:00:00.000Z", approvedAt: "2026-08-27T12:00:00.000Z" };
}
