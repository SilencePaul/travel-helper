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
    mkdirSync(dirname(packageLink), { recursive: true });
    symlinkSync(packageRoot, packageLink, "dir");
    writeFileSync(join(temporary, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(temporary, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        lib: ["ES2022", "DOM"],
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        skipLibCheck: false,
        strict: true,
        types: [],
      },
      files: ["consumer.ts"],
    }));
    writeFileSync(join(temporary, "consumer.ts"), `
      import { buildResearchTargetScopes, type DecisionResearchContext } from "@travel/contracts/decision-research";
      type IsAny<Value> = 0 extends (1 & Value) ? true : false;
      const scopes = buildResearchTargetScopes({
        version: 1,
        days: [{ id: "day-1", date: "2026-10-03", city: "深圳" }],
        travelerNames: ["一鸣"],
        travelerCount: 1,
      });
      const noAny: IsAny<typeof scopes> extends false ? true : never = true;
      const contextNoAny: IsAny<DecisionResearchContext> extends false ? true : never = true;
      const context: DecisionResearchContext | undefined = undefined;
      void noAny;
      void contextNoAny;
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
