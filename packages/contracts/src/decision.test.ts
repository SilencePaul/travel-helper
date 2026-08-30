import { describe, expect, it } from "vitest";
import {
  AgentRunSchema,
  AgentCommandSchema,
  AgentProposalCandidateInputSchema,
  CandidateSchema,
  DecisionCommandSchema,
  DecisionWorkspaceSchema,
  EvidenceSnapshotSchema,
  PreferenceProfileSchema,
} from "./decision";

const candidate = {
  id: "candidate-1",
  tripId: "trip-1",
  category: "hotel" as const,
  entity: { name: "海边酒店", address: "香港" },
  applicability: { dates: { start: "2026-10-01", end: "2026-10-02" }, travelers: 2 },
  recommendation: { round: 1, reason: "交通方便", preferenceRevisionIds: ["p-1:1"], feedbackIds: [] },
  verificationState: "web_verified" as const,
  decisionState: "tentative" as const,
  currentEvidenceId: "evidence-1",
  revision: 2,
  updatedAt: "2026-08-28T00:00:00.000Z",
};

describe("decision contracts", () => {
  it("accepts an owner-scoped preference command", () => {
    expect(DecisionCommandSchema.parse({ action: "upsertPreference", tripId: "trip-1", expectedRevision: 0, idempotencyKey: "request-001", answers: { pace: "slow" } }).action).toBe("upsertPreference");
  });

  it("uses the candidate revision field defined by the architecture", () => {
    expect(DecisionCommandSchema.parse({
      action: "placeTentative",
      tripId: "trip-1",
      candidateId: "candidate-1",
      expectedCandidateRevision: 2,
      idempotencyKey: "request-001",
      placement: { tripDayId: "day-1", date: "2026-10-01", sortKey: "a0" },
    }).action).toBe("placeTentative");
  });

  it("rejects incomplete web evidence facts", () => {
    expect(EvidenceSnapshotSchema.safeParse({
      id: "evidence-1",
      tripId: "trip-1",
      candidateId: "candidate-1",
      sourceKind: "web",
      sourceName: "酒店官网",
      sourceUrl: "https://example.com/hotel",
      capturedAt: "2026-08-28T00:00:00.000Z",
      queryContext: { dates: { start: "2026-10-01", end: "2026-10-02" }, travelers: 2 },
      captureMethod: "detail_page",
      facts: { propertyName: "海边酒店", address: "香港" },
      fieldCompleteness: [],
      verificationOutcome: "web_verified",
      revision: 1,
      updatedAt: "2026-08-28T00:00:00.000Z",
    }).success).toBe(false);
  });

  it("parses a fully typed workspace without unknown resource arrays", () => {
    expect(DecisionWorkspaceSchema.parse({
      tripId: "trip-1",
      preferences: [],
      candidates: [candidate],
      evidence: [],
      feedback: [],
      placements: [],
      confirmations: [],
      workspaceCursor: "7",
      fetchedAt: "2026-08-28T00:00:00.000Z",
    }).candidates[0]?.entity.name).toBe("海边酒店");
  });

  it("keeps profiles revisioned without a client ACL field", () => {
    expect(PreferenceProfileSchema.parse({ id: "p-1", tripId: "trip-1", ownerUid: "user-1", answers: {}, status: "editing", revision: 0, updatedAt: "2026-08-28T00:00:00.000Z", updatedBy: "user-1" }).ownerUid).toBe("user-1");
  });

  it("accepts a complete candidate resource", () => {
    expect(CandidateSchema.parse(candidate).decisionState).toBe("tentative");
  });

  it("reserves signed sequential agent evidence commands", () => {
    expect(AgentCommandSchema.parse({
      agentRunId: "agent-run-1",
      sequence: 1,
      idempotencyKey: "request-001",
      signature: "signature",
      action: "reportVerificationBlocked",
      payload: { candidateId: "candidate-1", expectedCandidateRevision: 2, reason: "captcha" },
    }).sequence).toBe(1);
  });

  it("rejects secret or unknown fields in a safe agent run projection", () => {
    expect(AgentRunSchema.safeParse({
      agentRunId: "agent-run-1",
      tripId: "trip-1",
      status: "claimed",
      scope: ["submitProposalBatch", "reportVerificationBlocked"],
      revision: 2,
      nextSequence: 1,
      createdAt: "2026-08-28T00:00:00.000Z",
      claimedAt: "2026-08-28T00:01:00.000Z",
      expiresAt: "2026-08-28T00:15:00.000Z",
      publicKeyJwk: { kty: "EC" },
      pairingCodeHash: "secret-hash",
      clientNonce: "secret-nonce",
    }).success).toBe(false);
  });

  it("keeps the standard verification blockage reason on candidates", () => {
    expect(CandidateSchema.parse({
      ...candidate,
      verificationState: "needs_takeover",
      verificationBlockReason: "captcha",
    }).verificationBlockReason).toBe("captcha");
  });

  it.each(["candidate", "web_verified", "stale"] as const)("rejects a blockage reason on %s candidates", (verificationState) => {
    expect(CandidateSchema.safeParse({
      ...candidate,
      verificationState,
      verificationBlockReason: "captcha",
    }).success).toBe(false);
  });

  it("accepts legacy takeover candidates without a blockage reason", () => {
    expect(CandidateSchema.safeParse({
      ...candidate,
      verificationState: "needs_takeover",
      verificationBlockReason: undefined,
    }).success).toBe(true);
  });

  it("does not expose verification blockage reasons as proposal input", () => {
    const parsed = AgentProposalCandidateInputSchema.parse({
      category: candidate.category,
      entity: candidate.entity,
      applicability: candidate.applicability,
      recommendation: candidate.recommendation,
      verificationBlockReason: "captcha",
      evidence: [{
        sourceKind: "manual",
        sourceName: "成员提供",
        capturedAt: "2026-08-28T00:00:00.000Z",
        queryContext: {},
        captureMethod: "manual",
        facts: { name: "海边酒店", address: "香港", openInformation: "not_provided", priceSnapshot: "not_provided" },
      }],
    });
    expect(parsed).not.toHaveProperty("verificationBlockReason");
  });

  it("reserves a signed decision-context read without expanding write scope", () => {
    expect(AgentCommandSchema.parse({
      agentRunId: "agent-run-1",
      sequence: 2,
      idempotencyKey: "context-001",
      signature: "signature",
      action: "getDecisionContext",
      payload: {},
    }).action).toBe("getDecisionContext");
  });
});
