/// <reference types="node" />

import { spawnSync } from "node:child_process";
import { createHash, webcrypto } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildResearchDisclosure,
  buildResearchTargetScopes,
  canonicalJson,
  computeDisclosureFingerprint,
} from "./decision-research.mjs";
import type { AgentDecisionContext } from "./decision";
import type { CryptoLike, DecisionResearchContext } from "./decision-research.mjs";

const asBrowserCryptoProvider = (subtle: SubtleCrypto): CryptoLike => ({ subtle });
const asAgentDecisionContext = (context: DecisionResearchContext): AgentDecisionContext => context;
const asDecisionResearchContext = (context: AgentDecisionContext): DecisionResearchContext => context;
void asBrowserCryptoProvider;
void asAgentDecisionContext;
void asDecisionResearchContext;

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

type ContextCandidate = AgentDecisionContext["workspace"]["candidates"][number];
type ContextEvidence = AgentDecisionContext["workspace"]["evidence"][number];
type ContextFeedback = AgentDecisionContext["workspace"]["feedback"][number];

const categoryNames = {
  hotel: ["深圳湾酒店", "南山花园酒店"],
  restaurant: ["海鲜餐厅", "深圳风味馆"],
  attraction: ["深圳湾公园", "南山博物馆"],
} as const;

function candidateFixture(category: ContextCandidate["category"], index: number): ContextCandidate {
  const suffix = `${category}-${index}`;
  const id = category === "hotel" && index === 0 ? "candidate-business-id-secret" : `candidate-${suffix}-secret`;
  return {
    id,
    tripId: "trip-business-id-secret",
    category,
    entity: { name: categoryNames[category][index]!, address: "深圳市南山区" },
    applicability: { dates: { start: "2026-10-03", end: "2026-10-03" }, travelers: 2 },
    recommendation: {
      round: 1,
      reason: `推荐理由 ${suffix}`,
      preferenceRevisionIds: ["preference-business-id-secret:3"],
      feedbackIds: [category === "hotel" && index === 0 ? "feedback-business-id-secret" : `feedback-${suffix}-secret`],
    },
    verificationState: "web_verified",
    decisionState: "tentative",
    currentEvidenceId: category === "hotel" && index === 0 ? "evidence-business-id-secret" : `evidence-${suffix}-0-secret`,
    revision: index + 1,
    updatedAt: "2026-08-28T00:00:00.000Z",
  };
}

function evidenceFacts(category: ContextCandidate["category"], index: number) {
  if (category === "hotel") {
    return {
      propertyName: categoryNames.hotel[index]!,
      address: "深圳市南山区",
      checkInDate: "2026-10-03",
      checkOutDate: "2026-10-03",
      travelers: 2,
      roomTypeOrBed: "大床房",
      availability: "available" as const,
      priceAmount: 900 + index * 100,
      currency: "CNY",
      priceDisplay: "total" as const,
      cancellationPolicy: "免费取消",
    };
  }
  if (category === "restaurant") {
    return {
      name: categoryNames.restaurant[index]!,
      address: "深圳市南山区",
      openInformation: "11:00-22:00",
      priceSnapshot: `CNY ${200 + index * 50}`,
    };
  }
  return {
    name: categoryNames.attraction[index]!,
    address: "深圳市南山区",
    openInformation: "09:00-18:00",
    priceSnapshot: index === 0 ? "免费" : "CNY 80",
    ticketType: "成人票",
  };
}

function evidenceFixture(candidate: ContextCandidate, candidateIndex: number, sourceIndex: number): ContextEvidence {
  const primaryHotel = candidate.category === "hotel" && candidateIndex === 0 && sourceIndex === 0;
  return {
    id: primaryHotel ? "evidence-business-id-secret" : `evidence-${candidate.category}-${candidateIndex}-${sourceIndex}-secret`,
    tripId: "trip-business-id-secret",
    candidateId: candidate.id,
    sourceKind: sourceIndex === 0 ? "official" : "web",
    sourceName: primaryHotel ? "酒店官网" : `${candidate.entity.name}来源 ${sourceIndex + 1}`,
    sourceUrl: primaryHotel
      ? "https://hotel.example/rooms"
      : `https://${candidate.category}-${candidateIndex}-${sourceIndex}.example/details`,
    capturedAt: "2026-08-28T00:00:00.000Z",
    queryContext: { dates: { start: "2026-10-03", end: "2026-10-03" }, travelers: 2 },
    captureMethod: sourceIndex === 0 ? "detail_page" : "search_result",
    facts: evidenceFacts(candidate.category, candidateIndex),
    fieldCompleteness: [],
    verificationOutcome: "web_verified",
    revision: sourceIndex + 1,
    updatedAt: "2026-08-28T00:00:00.000Z",
  };
}

function feedbackFixture(candidate: ContextCandidate, index: number): ContextFeedback {
  const primaryHotel = candidate.category === "hotel" && index === 0;
  return {
    id: primaryHotel ? "feedback-business-id-secret" : `feedback-${candidate.category}-${index}-secret`,
    tripId: "trip-business-id-secret",
    candidateId: candidate.id,
    actorUid: index === 0 ? "member-uid-secret" : "other-member-uid-secret",
    kind: index === 0 ? "like" : "comment",
    reason: index === 0 ? "离地铁近" : "备选方案",
    createdAt: "2026-08-28T00:00:00.000Z",
    revision: index + 1,
    updatedAt: "2026-08-28T00:00:00.000Z",
  };
}

function decisionContext(overrides: {
  tripVersion?: number;
  preferenceId?: string;
  preferenceRevision?: number;
} = {}): DecisionResearchContext {
  const candidates = (["hotel", "restaurant", "attraction"] as const)
    .flatMap((category) => [candidateFixture(category, 0), candidateFixture(category, 1)]);
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
        id: "second-preference-business-id-secret",
        tripId: "trip-business-id-secret",
        ownerUid: "other-member-uid-secret",
        answers: { pace: "balanced", interests: ["culture", "food"] },
        freeText: { mustAvoid: "太远" },
        status: "completed",
        revision: 2,
        updatedAt: "2026-08-28T00:00:00.000Z",
        updatedBy: "other-member-uid-secret",
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
        disagreements: ["位置", "预算"],
        tradeoffs: ["位置与价格", "时间与体力"],
        status: "ready",
        generatedAt: "2026-08-28T00:00:00.000Z",
      },
      candidates,
      evidence: candidates.flatMap((candidate, index) => [
        evidenceFixture(candidate, index % 2, 0),
        evidenceFixture(candidate, index % 2, 1),
      ]),
      feedback: candidates.map((candidate, index) => feedbackFixture(candidate, index % 2)),
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
        targetScopeId: "scope_b64667f2ad33dd723ef9947c9a3531f105ecd42f01d42c7b559e9712e2764e57",
        city: "深圳",
        startDate: "2026-10-03",
        endDate: "2026-10-03",
        travelerCount: 2,
      },
      {
        targetScopeId: expect.stringMatching(/^scope_[0-9a-f]{64}$/),
        city: "香港",
        startDate: "2026-10-04",
        endDate: "2026-10-06",
        travelerCount: 2,
      },
    ]);
  });

  it("cross-checks the hard-coded scope vector with Node SHA-256 and invalidates changed identities", () => {
    const canonicalScopeIdentity = '{"days":[{"city":"深圳","date":"2026-10-03","id":"day-sz-1"}],"ordinal":0,"travelerCount":2,"tripVersion":7}';
    const expected = "b64667f2ad33dd723ef9947c9a3531f105ecd42f01d42c7b559e9712e2764e57";
    const baseScopeId = buildResearchTargetScopes(safeTrip)[0]?.targetScopeId;
    const versionScopeId = buildResearchTargetScopes({ ...safeTrip, version: 8 })[0]?.targetScopeId;
    const identityScopeId = buildResearchTargetScopes({
      ...safeTrip,
      days: safeTrip.days.map((day) => day.id === "day-sz-1" ? { ...day, id: "day-sz-replacement" } : day),
    })[0]?.targetScopeId;

    expect(createHash("sha256").update(canonicalScopeIdentity).digest("hex")).toBe(expected);
    expect(baseScopeId).toBe(`scope_${expected}`);
    expect(baseScopeId).not.toContain("day-sz-1");
    expect(versionScopeId).not.toBe(baseScopeId);
    expect(identityScopeId).not.toBe(baseScopeId);
  });

  it("matches Node SHA-256 around padding boundaries and for long Unicode scope identities", () => {
    const encoder = new TextEncoder();
    const vector = (dayId: string) => ({
      trip: {
        version: 1,
        days: [{ id: dayId, date: "2026-10-03", city: "A" }],
        travelerNames: ["A"],
        travelerCount: 1,
      },
      identity: canonicalJson({
        days: [{ city: "A", date: "2026-10-03", id: dayId }],
        ordinal: 0,
        travelerCount: 1,
        tripVersion: 1,
      }),
    });
    const boundaryVectors = [55, 56, 63, 0].map((remainder) => {
      for (let length = 1; length < 256; length += 1) {
        const candidate = vector("x".repeat(length));
        if (encoder.encode(candidate.identity).length % 64 === remainder) return candidate;
      }
      throw new Error(`missing SHA boundary fixture ${remainder}`);
    });
    const cases = [
      ...boundaryVectors,
      vector("x".repeat(1024)),
      vector("旅".repeat(160)),
    ];

    for (const { trip, identity } of cases) {
      const expected = createHash("sha256").update(identity).digest("hex");
      expect(buildResearchTargetScopes(trip)[0]?.targetScopeId).toBe(`scope_${expected}`);
    }
    expect(boundaryVectors.map(({ identity }) => encoder.encode(identity).length % 64)).toEqual([55, 56, 63, 0]);
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

  it("matches the hard-coded SHA-256 vector through separate Node and browser-shaped providers", async () => {
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
    const browserCalls: Array<{ algorithm: string; input: string }> = [];
    const browserCrypto = {
      subtle: {
        async digest(algorithm: AlgorithmIdentifier, data: BufferSource) {
          const algorithmName = typeof algorithm === "string" ? algorithm : algorithm.name;
          const bytes = data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          browserCalls.push({ algorithm: algorithmName, input: new TextDecoder().decode(bytes) });
          return Uint8Array.from(createHash("sha256").update(bytes).digest()).buffer;
        },
      },
    };

    expect(await computeDisclosureFingerprint(fixedDisclosure, webcrypto)).toBe(expected);
    expect(await computeDisclosureFingerprint(fixedDisclosure, browserCrypto)).toBe(expected);
    expect(browserCalls).toEqual([{ algorithm: "SHA-256", input: canonical }]);
  });

  it("resolves the declaration subpath for a strict NodeNext consumer without any leakage", () => {
    const temporary = mkdtempSync(join(tmpdir(), "travel-contracts-nodenext-"));
    const packageRoot = fileURLToPath(new URL("../", import.meta.url));
    const packageLink = join(temporary, "node_modules", "@travel", "contracts");
    const nodeTypesLink = join(temporary, "node_modules", "@types", "node");
    mkdirSync(dirname(packageLink), { recursive: true });
    mkdirSync(dirname(nodeTypesLink), { recursive: true });
    symlinkSync(packageRoot, packageLink, "dir");
    symlinkSync(join(packageRoot, "node_modules", "@types", "node"), nodeTypesLink, "dir");
    writeFileSync(join(temporary, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(temporary, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        lib: ["ES2022"],
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        skipLibCheck: false,
        strict: true,
        types: ["node"],
      },
      files: ["consumer.ts"],
    }));
    writeFileSync(join(temporary, "consumer.ts"), `
      import { webcrypto } from "node:crypto";
      import {
        buildResearchTargetScopes,
        type CryptoLike,
        type DecisionResearchContext,
      } from "@travel/contracts/decision-research";
      type IsAny<Value> = 0 extends (1 & Value) ? true : false;
      const scopes = buildResearchTargetScopes({
        version: 1,
        days: [{ id: "day-1", date: "2026-10-03", city: "深圳" }],
        travelerNames: ["一鸣"],
        travelerCount: 1,
      });
      const noAny: IsAny<typeof scopes> extends false ? true : never = true;
      const contextNoAny: IsAny<DecisionResearchContext> extends false ? true : never = true;
      const nodeCryptoProvider: CryptoLike = webcrypto;
      const context: DecisionResearchContext | undefined = undefined;
      void noAny;
      void contextNoAny;
      void nodeCryptoProvider;
      void context;
    `);

    try {
      const compilation = spawnSync(process.execPath, [
        join(packageRoot, "node_modules", "typescript", "bin", "tsc"),
        "-p",
        temporary,
      ], {
        cwd: temporary,
        encoding: "utf8",
      });
      expect(compilation.status, compilation.stderr || compilation.stdout).toBe(0);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
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
    expect(disclosure.preferences).toHaveLength(2);
    expect(disclosure.existingCandidates).toHaveLength(2);
    expect(disclosure.feedback).toHaveLength(2);
    expect(disclosure.resourceCommitments.length).toBeGreaterThan(0);
  });

  it("omits unsafe evidence URLs while preserving safe evidence summaries and commitments", async () => {
    const unsafeUrls = [
      "http://hotel.example/rooms",
      "file:///Users/example/.codex/credentials.json",
      "https://alice:password@hotel.example/rooms",
      "https://hotel.example/rooms#secret-fragment",
      "https://hotel.example/rooms#",
      "https://hotel.example/rooms?access-token=secret-token",
      "https://hotel.example/rooms?API_KEY=secret-key",
      "https://hotel.example/rooms?session.id=secret-session",
      "https://hotel.example/rooms?auth_signature=secret-signature",
    ];

    for (const sourceUrl of unsafeUrls) {
      const context = decisionContext();
      const evidence = context.workspace.evidence[0];
      if (!evidence) throw new Error("missing evidence fixture");
      evidence.sourceUrl = sourceUrl;
      const scope = buildResearchTargetScopes(context.trip)[0];
      if (!scope) throw new Error("missing scope fixture");
      const disclosure = await buildResearchDisclosure(context, {
        category: "hotel",
        targetScopeId: scope.targetScopeId,
      });
      const disclosedEvidence = disclosure.existingCandidates
        .flatMap((candidate) => candidate.evidence)
        .find((evidence) => evidence.sourceName === "酒店官网");
      expect(disclosedEvidence?.sourceName).toBe("酒店官网");
      expect(disclosedEvidence).not.toHaveProperty("sourceUrl");
      expect(disclosure.resourceCommitments.some(({ resourceType }) => resourceType === "evidence")).toBe(true);
      const serialized = JSON.stringify(disclosure);
      expect(serialized).not.toContain(sourceUrl);
      expect(serialized).not.toContain("/Users/example/.codex");
      expect(serialized).not.toContain("secret-");
      expect(serialized).not.toContain("alice:password");
    }

    const safeContext = decisionContext();
    const safeEvidence = safeContext.workspace.evidence[0];
    if (!safeEvidence) throw new Error("missing evidence fixture");
    safeEvidence.sourceUrl = "https://hotel.example/rooms?date=2026-10-03";
    const safeScope = buildResearchTargetScopes(safeContext.trip)[0];
    if (!safeScope) throw new Error("missing scope fixture");
    const safeDisclosure = await buildResearchDisclosure(safeContext, {
      category: "hotel",
      targetScopeId: safeScope.targetScopeId,
    });
    const disclosedSafeEvidence = safeDisclosure.existingCandidates
      .flatMap((candidate) => candidate.evidence)
      .find((evidence) => evidence.sourceName === "酒店官网");
    expect(disclosedSafeEvidence?.sourceUrl).toBe(safeEvidence.sourceUrl);
  });

  it("keeps disclosures and fingerprints stable under reversed source ordering for every populated category", async () => {
    const original = decisionContext();
    const reversed = structuredClone(original);
    reversed.trip.days.reverse();
    reversed.trip.travelerNames.reverse();
    reversed.workspace.preferences.reverse();
    reversed.workspace.candidates.reverse();
    reversed.workspace.evidence.reverse();
    reversed.workspace.feedback.reverse();
    for (const preference of reversed.workspace.preferences) {
      for (const [key, answer] of Object.entries(preference.answers)) {
        if (Array.isArray(answer)) preference.answers[key] = [...answer].reverse();
      }
    }
    reversed.workspace.summary?.common.reverse();
    reversed.workspace.summary?.disagreements.reverse();
    reversed.workspace.summary?.tradeoffs.reverse();

    for (const category of ["hotel", "restaurant", "attraction"] as const) {
      const originalScope = buildResearchTargetScopes(original.trip)[0];
      const reversedScope = buildResearchTargetScopes(reversed.trip)[0];
      if (!originalScope || !reversedScope) throw new Error("missing scope fixture");
      expect(reversedScope.targetScopeId).toBe(originalScope.targetScopeId);
      const first = await buildResearchDisclosure(original, {
        category,
        targetScopeId: originalScope.targetScopeId,
      });
      const second = await buildResearchDisclosure(reversed, {
        category,
        targetScopeId: reversedScope.targetScopeId,
      });

      expect(first.existingCandidates.length).toBeGreaterThanOrEqual(2);
      expect(first.existingCandidates.every((candidate) => candidate.category === category)).toBe(true);
      expect(first.existingCandidates.every((candidate) => candidate.evidence.length >= 2)).toBe(true);
      expect(first.feedback.length).toBeGreaterThanOrEqual(2);
      expect(first).toEqual(second);
      expect(await computeDisclosureFingerprint(first)).toBe(await computeDisclosureFingerprint(second));
    }
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
