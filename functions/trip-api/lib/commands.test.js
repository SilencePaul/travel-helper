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

test("a trip member creates and revokes a scoped expiring agent run", async () => {
  const db = createDb({
    members: [member("fs_member", "member")],
    trips: [{ ...trip(), memberUids: ["fs_member"] }],
  });
  const commands = createTripCommands({
    db,
    now: () => new Date("2026-08-28T07:00:00.000Z"),
    randomId: () => "agent-run-1",
  });
  const created = await commands.execute({
    action: "createAgentRun",
    tripId: "trip-2026-autumn",
    publicKeyJwk: { kty: "EC", crv: "P-256", x: "x-coordinate", y: "y-coordinate" },
    pairingCodeHash: "2g8DdGhJvqg00hyxT13Po40J6lVT92CRPLHZfoW3szI",
    scope: ["submitProposalBatch", "appendEvidenceSnapshot"],
    idempotencyKey: "create-agent-run-001",
  }, "fs_member");

  assert.deepEqual(created, { agentRunId: "agent-run-1", expiresAt: "2026-08-28T07:15:00.000Z" });
  assert.equal(db.data.trip_agent_runs.get("agent-run-1").status, "pending_claim");
  assert.equal(db.data.trip_agent_runs.get("agent-run-1").lastSequence, 0);

  const revoked = await commands.execute({
    action: "revokeAgentRun",
    tripId: "trip-2026-autumn",
    agentRunId: "agent-run-1",
    expectedRevision: 1,
    idempotencyKey: "revoke-agent-run-001",
  }, "fs_member");
  assert.deepEqual(revoked, { agentRunId: "agent-run-1", revokedAt: "2026-08-28T07:00:00.000Z" });
  assert.equal(db.data.trip_agent_runs.get("agent-run-1").status, "revoked");
  assert.equal(db.data.trip_agent_runs.get("agent-run-1").revision, 2);
  assert.deepEqual(db.data.decisionAudits.map(({ command }) => command), ["createAgentRun", "revokeAgentRun"]);
  assert.equal(JSON.stringify(db.data.decisionAudits).includes("pairingCodeHash"), false);
  assert.equal(JSON.stringify(db.data.decisionAudits).includes("publicKeyJwk"), false);
});

test("a claimed scoped agent submits an atomic two-candidate proposal batch", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const ids = ["agent-run-1", "candidate-1", "evidence-1", "candidate-2", "evidence-2"];
  const db = createDb({
    members: [member("fs_member", "member")],
    trips: [{ ...trip(), memberUids: ["fs_member"] }],
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
  }, "fs_member");
  const claim = { action: "claimAgentRun", agentRunId: "agent-run-1", pairingCode: "pairing-code", clientNonce: "nonce-001" };
  await commands.executeAgent({ ...claim, signature: agentSignature(privateKey, { agentRunId: claim.agentRunId, pairingCode: claim.pairingCode, clientNonce: claim.clientNonce }) });

  const proposal = (name) => ({
    category: "restaurant",
    entity: { name, address: "香港" },
    applicability: { dates: { start: "2026-10-01", end: "2026-10-01" }, travelers: 2 },
    recommendation: { round: 1, reason: "符合共同偏好", preferenceRevisionIds: [], feedbackIds: [] },
    evidence: [{
      sourceKind: "flyai",
      sourceName: "FlyAI",
      capturedAt: "2026-08-28T07:00:00.000Z",
      queryContext: { dates: { start: "2026-10-01", end: "2026-10-01" }, travelers: 2 },
      captureMethod: "api_result",
      facts: { name, address: "香港", openInformation: "晚餐营业", priceSnapshot: "约 HK$200/人" },
    }],
  });
  const signed = {
    agentRunId: "agent-run-1",
    sequence: 1,
    idempotencyKey: "proposal-batch-001",
    action: "submitProposalBatch",
    payload: { round: 1, candidates: [proposal("餐厅 A"), proposal("餐厅 B")] },
  };
  const result = await commands.executeAgent({ ...signed, signature: agentSignature(privateKey, signed) });

  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0].verificationState, "candidate");
  assert.equal(result.candidates[0].decisionState, "none");
  assert.equal(db.data.trip_candidates.size, 2);
  assert.equal(db.data.trip_evidence_snapshots.size, 2);
  assert.equal(db.data.trip_agent_runs.get("agent-run-1").lastSequence, 1);
  const workspace = await commands.execute({ action: "getDecisionWorkspace", tripId: "trip-2026-autumn" }, "fs_member");
  assert.equal(workspace.candidates.length, 2);
  assert.equal(workspace.evidence.length, 2);
});

test("agent web evidence is server-verified and a later blockage is explicit", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const db = createDb({
    members: [member("fs_member", "member")],
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
  const commands = createTripCommands({ db, now: () => new Date("2026-08-28T07:10:00.000Z"), randomId: () => "evidence-web-1" });
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

  const blockedCommand = {
    agentRunId: "agent-run-1",
    sequence: 2,
    idempotencyKey: "web-blocked-001",
    action: "reportVerificationBlocked",
    payload: { candidateId: "candidate-1", expectedCandidateRevision: 3, reason: "captcha" },
  };
  const blocked = await commands.executeAgent({ ...blockedCommand, signature: agentSignature(privateKey, blockedCommand) });
  assert.equal(blocked.candidate.verificationState, "needs_takeover");
  assert.equal(blocked.candidate.changeReason, "captcha");
  assert.equal(blocked.candidate.revision, 4);
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
