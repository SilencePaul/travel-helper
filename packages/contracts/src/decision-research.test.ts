import { describe, expect, it } from "vitest";
import {
  buildResearchDisclosure,
  buildResearchTargetScopes,
  canonicalJson,
  computeDisclosureFingerprint,
} from "./decision-research.mjs";
import type { DecisionResearchContext } from "./decision-research.mjs";

const safeTrip = {
  version: 7,
  days: [
    { id: "day-hk-3", date: "2026-10-06", city: "香港" },
    { id: "day-sz-1", date: "2026-10-03", city: "深圳" },
    { id: "day-hk-1", date: "2026-10-04", city: "香港" },
    { id: "day-hk-2", date: "2026-10-05", city: "香港" },
  ],
  travelerNames: ["美垚", "一鸣"],
  travelerCount: 2,
};

const hotelEvidenceFacts = {
  propertyName: "深圳湾酒店",
  address: "深圳市南山区",
  checkInDate: "2026-10-03",
  checkOutDate: "2026-10-03",
  travelers: 2,
  roomTypeOrBed: "大床房",
  availability: "available",
  priceAmount: 900,
  currency: "CNY",
  priceDisplay: "total",
  cancellationPolicy: "免费取消",
} as const;

function decisionContext(overrides: {
  tripVersion?: number;
  preferenceId?: string;
  preferenceRevision?: number;
} = {}): DecisionResearchContext {
  return {
    trip: {
      ...safeTrip,
      version: overrides.tripVersion ?? safeTrip.version,
    },
    workspace: {
      tripId: "trip-business-id-secret",
      preferences: [{
        id: overrides.preferenceId ?? "preference-business-id-secret",
        tripId: "trip-business-id-secret",
        ownerUid: "member-uid-secret",
        answers: { pace: "slow", interests: ["food", "views"] },
        freeText: { mustHave: "安静" },
        status: "completed",
        revision: overrides.preferenceRevision ?? 3,
        updatedAt: "2026-08-28T00:00:00.000Z",
        updatedBy: "member-uid-secret",
      }, {
        id: "editing-preference-id-secret",
        tripId: "trip-business-id-secret",
        ownerUid: "other-member-uid-secret",
        answers: { pace: "fast" },
        status: "editing",
        revision: 1,
        updatedAt: "2026-08-28T00:00:00.000Z",
        updatedBy: "other-member-uid-secret",
      }],
      summary: {
        id: "summary-business-id-secret",
        tripId: "trip-business-id-secret",
        revision: 4,
        updatedAt: "2026-08-28T00:00:00.000Z",
        sourcePreferenceRevisions: { "member-uid-secret": 3 },
        common: ["看风景", "美食"],
        disagreements: ["预算"],
        tradeoffs: ["位置与价格"],
        status: "ready",
        generatedAt: "2026-08-28T00:00:00.000Z",
      },
      candidates: [{
        id: "candidate-business-id-secret",
        tripId: "trip-business-id-secret",
        category: "hotel",
        entity: { name: "深圳湾酒店", address: "深圳市南山区" },
        applicability: { dates: { start: "2026-10-03", end: "2026-10-03" }, travelers: 2 },
        recommendation: {
          round: 1,
          reason: "交通方便",
          preferenceRevisionIds: ["preference-business-id-secret:3"],
          feedbackIds: ["feedback-business-id-secret"],
        },
        verificationState: "web_verified",
        decisionState: "tentative",
        currentEvidenceId: "evidence-business-id-secret",
        revision: 2,
        updatedAt: "2026-08-28T00:00:00.000Z",
      }, {
        id: "restaurant-candidate-id-secret",
        tripId: "trip-business-id-secret",
        category: "restaurant",
        entity: { name: "海鲜餐厅", address: "深圳" },
        applicability: {},
        recommendation: { round: 1, reason: "本地风味", preferenceRevisionIds: [], feedbackIds: [] },
        verificationState: "candidate",
        decisionState: "none",
        revision: 1,
        updatedAt: "2026-08-28T00:00:00.000Z",
      }],
      evidence: [{
        id: "evidence-business-id-secret",
        tripId: "trip-business-id-secret",
        candidateId: "candidate-business-id-secret",
        sourceKind: "official",
        sourceName: "酒店官网",
        sourceUrl: "https://hotel.example/rooms",
        capturedAt: "2026-08-28T00:00:00.000Z",
        queryContext: {
          dates: { start: "2026-10-03", end: "2026-10-03" },
          travelers: 2,
        },
        captureMethod: "detail_page",
        facts: hotelEvidenceFacts,
        fieldCompleteness: [],
        verificationOutcome: "web_verified",
        revision: 5,
        updatedAt: "2026-08-28T00:00:00.000Z",
      }],
      feedback: [{
        id: "feedback-business-id-secret",
        tripId: "trip-business-id-secret",
        candidateId: "candidate-business-id-secret",
        actorUid: "member-uid-secret",
        kind: "like",
        reason: "离地铁近",
        createdAt: "2026-08-28T00:00:00.000Z",
        revision: 2,
        updatedAt: "2026-08-28T00:00:00.000Z",
      }],
      placements: [],
      confirmations: [],
      workspaceCursor: "cursor-secret",
      fetchedAt: "2026-08-28T00:00:00.000Z",
    },
  };
}

describe("decision research projection", () => {
  it("canonicalizes object keys recursively without reordering arrays", () => {
    expect(canonicalJson({ z: 1, nested: { b: true, a: null }, items: ["b", "a"] })).toBe(
      '{"items":["b","a"],"nested":{"a":null,"b":true},"z":1}',
    );
  });

  it("merges date-contiguous same-city days after deterministic sorting", () => {
    expect(buildResearchTargetScopes(safeTrip)).toEqual([
      {
        targetScopeId: expect.stringMatching(/^scope_[0-9a-f]{16}$/),
        city: "深圳",
        startDate: "2026-10-03",
        endDate: "2026-10-03",
        travelerCount: 2,
      },
      {
        targetScopeId: expect.stringMatching(/^scope_[0-9a-f]{16}$/),
        city: "香港",
        startDate: "2026-10-04",
        endDate: "2026-10-06",
        travelerCount: 2,
      },
    ]);
  });

  it("keeps non-contiguous visits to the same city as separate targets", () => {
    const scopes = buildResearchTargetScopes({
      ...safeTrip,
      days: [
        { id: "sz-1", date: "2026-10-03", city: "深圳" },
        { id: "hk-1", date: "2026-10-04", city: "香港" },
        { id: "sz-2", date: "2026-10-05", city: "深圳" },
      ],
    });

    expect(scopes.map(({ city, startDate, endDate }) => ({ city, startDate, endDate }))).toEqual([
      { city: "深圳", startDate: "2026-10-03", endDate: "2026-10-03" },
      { city: "香港", startDate: "2026-10-04", endDate: "2026-10-04" },
      { city: "深圳", startDate: "2026-10-05", endDate: "2026-10-05" },
    ]);
    expect(new Set(scopes.map((scope) => scope.targetScopeId)).size).toBe(3);
  });

  it("matches the hard-coded SHA-256 vector in both Web Crypto and Node", async () => {
    const fixedDisclosure = {
      category: "hotel",
      segment: { city: "深圳", startDate: "2026-10-03", endDate: "2026-10-03", travelerCount: 2 },
      travelerNames: ["一鸣", "美垚"],
    };
    const expected = "df062aeeb358e2fa0c60e5b90479c433e71f12a70def1b3f0579effd19805635";
    const canonical = canonicalJson(fixedDisclosure);

    expect(canonical).toBe(
      '{"category":"hotel","segment":{"city":"深圳","endDate":"2026-10-03","startDate":"2026-10-03","travelerCount":2},"travelerNames":["一鸣","美垚"]}',
    );
    expect(await computeDisclosureFingerprint(fixedDisclosure)).toBe(expected);
    expect(await computeDisclosureFingerprint(fixedDisclosure, globalThis.crypto)).toBe(expected);
  });

  it.each(["hotel", "restaurant", "attraction"] as const)(
    "builds a deterministic %s disclosure while preserving member names",
    async (category) => {
      const context = decisionContext();
      const [scope] = buildResearchTargetScopes(context.trip);
      if (!scope) throw new Error("missing scope fixture");

      const first = await buildResearchDisclosure(context, { category, targetScopeId: scope.targetScopeId });
      const second = await buildResearchDisclosure(context, { category, targetScopeId: scope.targetScopeId });

      expect(first).toEqual(second);
      expect(first.category).toBe(category);
      expect(first.travelerNames).toEqual(["一鸣", "美垚"]);
      expect(first.existingCandidates.every((candidate) => candidate.category === category)).toBe(true);
    },
  );

  it("excludes UIDs, raw business IDs, cursors, and network timestamps", async () => {
    const context = decisionContext();
    const [scope] = buildResearchTargetScopes(context.trip);
    if (!scope) throw new Error("missing scope fixture");

    const disclosure = await buildResearchDisclosure(context, {
      category: "hotel",
      targetScopeId: scope.targetScopeId,
    });
    const serialized = JSON.stringify(disclosure);

    for (const secret of [
      "member-uid-secret",
      "other-member-uid-secret",
      "trip-business-id-secret",
      "preference-business-id-secret",
      "candidate-business-id-secret",
      "evidence-business-id-secret",
      "feedback-business-id-secret",
      "cursor-secret",
      "2026-08-28T00:00:00.000Z",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(disclosure.preferences).toHaveLength(1);
    expect(disclosure.existingCandidates).toHaveLength(1);
    expect(disclosure.feedback).toHaveLength(1);
    expect(disclosure.resourceCommitments.length).toBeGreaterThan(0);
  });

  it("changes the fingerprint when a hidden resource identity or revision changes", async () => {
    const base = decisionContext();
    const changedId = decisionContext({ preferenceId: "replacement-preference-id-secret" });
    const changedRevision = decisionContext({ preferenceRevision: 4 });
    const [scope] = buildResearchTargetScopes(base.trip);
    if (!scope) throw new Error("missing scope fixture");

    const options = { category: "hotel" as const, targetScopeId: scope.targetScopeId };
    const baseDisclosure = await buildResearchDisclosure(base, options);
    const changedIdDisclosure = await buildResearchDisclosure(changedId, options);
    const changedRevisionDisclosure = await buildResearchDisclosure(changedRevision, options);

    expect(await computeDisclosureFingerprint(changedIdDisclosure)).not.toBe(
      await computeDisclosureFingerprint(baseDisclosure),
    );
    expect(await computeDisclosureFingerprint(changedRevisionDisclosure)).not.toBe(
      await computeDisclosureFingerprint(baseDisclosure),
    );
  });

  it("rejects a target scope that is not present in the latest trip projection", async () => {
    await expect(buildResearchDisclosure(decisionContext(), {
      category: "hotel",
      targetScopeId: "scope_stale",
    })).rejects.toThrow("INVALID_RESEARCH_TARGET");
  });
});
