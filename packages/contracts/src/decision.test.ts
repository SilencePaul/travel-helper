import { describe, expect, it } from "vitest";
import {
  AgentDecisionContextSchema,
  AgentEvidenceInputSchema,
  AgentRunSchema,
  AgentCommandSchema,
  AgentProposalEvidenceInputSchema,
  AgentProposalCandidateInputSchema,
  AgentProposalApplicabilitySchema,
  AgentProposalAttractionEvidenceFactsSchema,
  AgentProposalDateRangeSchema,
  AgentProposalEntitySchema,
  AgentProposalHotelEvidenceFactsSchema,
  AgentProposalQueryContextSchema,
  AgentProposalRecommendationSchema,
  AgentProposalRestaurantEvidenceFactsSchema,
  AgentTripProjectionSchema,
  CandidateSchema,
  DecisionCommandSchema,
  DecisionWorkspaceSchema,
  EvidenceSnapshotSchema,
  PreferenceProfileSchema,
  OpaqueIdentifierSchema,
  ResearchBlockReasonSchema,
  ResearchErrorCodeSchema,
  ResearchPhaseSchema,
  ResearchResumeActionSchema,
  ResearchStatusSchema,
} from "./decision";
import type {
  AgentClaimResult,
  AgentCommandResult,
  DecisionCommandFailure,
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

const proposalEvidence = {
  sourceKind: "official" as const,
  sourceName: "酒店官网",
  sourceUrl: "https://hotel.example/rooms",
  capturedAt: "2026-08-28T00:00:00.000Z",
  queryContext: {},
  captureMethod: "detail_page" as const,
  facts: {
    propertyName: "海边酒店",
    address: "香港",
    checkInDate: "2026-10-01",
    checkOutDate: "2026-10-02",
    travelers: 2,
    roomTypeOrBed: "大床房",
    availability: "available" as const,
    priceAmount: 1000,
    currency: "CNY",
    priceDisplay: "total" as const,
    cancellationPolicy: "免费取消",
  },
};

const proposalCandidate = {
  category: candidate.category,
  entity: candidate.entity,
  applicability: candidate.applicability,
  recommendation: candidate.recommendation,
  evidence: [
    proposalEvidence,
    { ...proposalEvidence, sourceName: "旅行平台", sourceUrl: "https://travel.example/hotel" },
  ],
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

  it("accepts a strict safe trip and decision context projection", () => {
    const trip = AgentTripProjectionSchema.parse({
      version: 3,
      days: [{ id: "day-1", date: "2026-10-01", city: "香港" }],
      travelerNames: ["一鸣", "美垚"],
      travelerCount: 2,
    });
    expect(AgentDecisionContextSchema.parse({
      workspace: {
        tripId: "trip-1",
        preferences: [],
        candidates: [],
        evidence: [],
        feedback: [],
        placements: [],
        confirmations: [],
        workspaceCursor: "0",
        fetchedAt: "2026-08-28T00:00:00.000Z",
      },
      trip,
    }).trip.travelerNames).toEqual(["一鸣", "美垚"]);
    expect(AgentTripProjectionSchema.safeParse({ ...trip, memberUids: ["member-secret"] }).success).toBe(false);
    expect(AgentDecisionContextSchema.safeParse({ workspace: {}, trip, privateKey: "secret" }).success).toBe(false);
  });

  it("uses a strict discriminated research status without Codex internals", () => {
    expect(ResearchStatusSchema.parse({ phase: "idle" })).toEqual({ phase: "idle" });
    const blockedStatus = ResearchStatusSchema.parse({
      phase: "needs_owner_action",
      researchTaskId: "research-1",
      agentRunId: "agent-run-1",
      operationId: "operation-1",
      reconciliationState: "active",
      startedAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:01:00.000Z",
      blockedReason: "source_captcha",
      blockedHostname: "tickets.example",
    });
    if (blockedStatus.phase !== "needs_owner_action") throw new Error("unexpected research phase");
    expect(blockedStatus.blockedReason).toBe("source_captcha");

    for (const leakedField of ["codexThreadId", "log", "prompt", "path", "context"] as const) {
      expect(ResearchStatusSchema.safeParse({
        phase: "researching",
        researchTaskId: "research-1",
        agentRunId: "agent-run-1",
        operationId: "operation-1",
        reconciliationState: "active",
        startedAt: "2026-08-28T00:00:00.000Z",
        updatedAt: "2026-08-28T00:01:00.000Z",
        [leakedField]: "secret",
      }).success).toBe(false);
    }
    for (const missingField of ["agentRunId", "operationId", "reconciliationState"] as const) {
      const complete = {
        phase: "researching",
        researchTaskId: "research-1",
        agentRunId: "agent-run-1",
        operationId: "operation-1",
        reconciliationState: "self_revoke_reconciling",
        startedAt: "2026-08-28T00:00:00.000Z",
        updatedAt: "2026-08-28T00:01:00.000Z",
      };
      delete (complete as Partial<typeof complete>)[missingField];
      expect(ResearchStatusSchema.safeParse(complete).success).toBe(false);
    }
  });

  it("uses one bounded opaque identifier contract at the public protocol edge", () => {
    expect(OpaqueIdentifierSchema.parse("agent-run_1:resume.2")).toBe("agent-run_1:resume.2");
    expect(OpaqueIdentifierSchema.safeParse(`a${"b".repeat(255)}`).success).toBe(true);
    expect(OpaqueIdentifierSchema.safeParse(`a${"b".repeat(256)}`).success).toBe(false);
    expect(OpaqueIdentifierSchema.safeParse("-leading-dash").success).toBe(false);
    expect(OpaqueIdentifierSchema.safeParse("contains space").success).toBe(false);
  });

  it("exposes self-revoke reconciliation only while an operation is active", () => {
    const base = {
      researchTaskId: "research-1",
      agentRunId: "agent-run-1",
      operationId: "operation-1",
      reconciliationState: "self_revoke_reconciling",
      startedAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:01:00.000Z",
    } as const;

    for (const phase of ["researching", "resuming", "validating", "writing", "cancelling"] as const) {
      expect(ResearchStatusSchema.safeParse({ phase, ...base }).success).toBe(true);
    }
    for (const terminal of [
      { phase: "completed" },
      { phase: "failed", errorCode: "CODEX_RESEARCH_FAILED" },
      { phase: "cancelled", errorCode: "CODEX_RESEARCH_CANCELLED" },
      { phase: "superseded", errorCode: "DISCLOSURE_CONTEXT_CHANGED" },
      { phase: "needs_owner_action", blockedReason: "codex_auth_required" },
    ] as const) {
      expect(ResearchStatusSchema.safeParse({ ...terminal, ...base }).success).toBe(false);
    }
  });

  it("requires source hostnames while forbidding them for Codex authentication blockers", () => {
    const base = {
      phase: "needs_owner_action",
      researchTaskId: "research-1",
      agentRunId: "agent-run-1",
      operationId: "operation-1",
      reconciliationState: "active",
      startedAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:01:00.000Z",
    };

    expect(ResearchStatusSchema.safeParse({
      ...base,
      blockedReason: "codex_auth_required",
    }).success).toBe(true);
    expect(ResearchStatusSchema.safeParse({
      ...base,
      blockedReason: "codex_auth_required",
      blockedHostname: "chatgpt.com",
    }).success).toBe(false);
    for (const blockedReason of ["source_login_required", "source_captcha", "source_risk_control"] as const) {
      expect(ResearchStatusSchema.safeParse({ ...base, blockedReason }).success).toBe(false);
      expect(ResearchStatusSchema.safeParse({
        ...base,
        blockedReason,
        blockedHostname: "tickets.example",
      }).success).toBe(true);
      expect(ResearchStatusSchema.safeParse({
        ...base,
        blockedReason,
        blockedHostname: "https://tickets.example/path",
      }).success).toBe(false);
    }
  });

  it("keeps authentication, disclosure changes, and cancellation out of failed status", () => {
    const failed = {
      phase: "failed",
      researchTaskId: "research-1",
      agentRunId: "agent-run-1",
      operationId: "operation-1",
      reconciliationState: "active",
      startedAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:01:00.000Z",
    };

    for (const errorCode of [
      "CODEX_NOT_AUTHENTICATED",
      "DISCLOSURE_CONTEXT_CHANGED",
      "CODEX_RESEARCH_CANCELLED",
    ] as const) {
      expect(ResearchStatusSchema.safeParse({ ...failed, errorCode }).success).toBe(false);
    }
    expect(ResearchStatusSchema.safeParse({
      ...failed,
      errorCode: "CODEX_RESEARCH_FAILED",
    }).success).toBe(true);
    expect(ResearchStatusSchema.safeParse({
      ...failed,
      phase: "needs_owner_action",
      blockedReason: "codex_auth_required",
    }).success).toBe(true);
    expect(ResearchStatusSchema.safeParse({
      ...failed,
      phase: "superseded",
      errorCode: "DISCLOSURE_CONTEXT_CHANGED",
    }).success).toBe(true);
    expect(ResearchStatusSchema.safeParse({
      ...failed,
      phase: "cancelled",
      errorCode: "CODEX_RESEARCH_CANCELLED",
    }).success).toBe(true);
  });

  it("fixes the research error, blockage, and resume vocabularies", () => {
    expect(ResearchPhaseSchema.options).toEqual([
      "idle",
      "researching",
      "needs_owner_action",
      "resuming",
      "superseded",
      "validating",
      "writing",
      "completed",
      "failed",
      "cancelling",
      "cancelled",
    ]);
    expect(ResearchBlockReasonSchema.options).toEqual([
      "codex_auth_required",
      "source_login_required",
      "source_captcha",
      "source_risk_control",
    ]);
    expect(ResearchErrorCodeSchema.options).toEqual([
      "CODEX_NOT_AVAILABLE",
      "CODEX_NOT_AUTHENTICATED",
      "CODEX_ISOLATION_UNAVAILABLE",
      "CODEX_USAGE_UNAVAILABLE",
      "CODEX_RESEARCH_TIMEOUT",
      "CODEX_OUTPUT_INVALID",
      "CODEX_INSUFFICIENT_EVIDENCE",
      "INVALID_RESEARCH_TARGET",
      "DISCLOSURE_CONTEXT_CHANGED",
      "CODEX_RESEARCH_CANCELLED",
      "AGENT_RUN_INACTIVE",
      "AGENT_TRANSPORT_UNAVAILABLE",
      "CODEX_RESEARCH_FAILED",
    ]);
    expect(ResearchResumeActionSchema.options).toEqual(["retry_codex_auth", "skip_blocked_source"]);
  });

  it("types claim expiry, safe context, self-revoke success, and admin failures", () => {
    const claimResult = {
      ok: true,
      data: {
        agentRunId: "agent-run-1",
        claimedAt: "2026-08-28T00:00:00.000Z",
        expiresAt: "2026-08-28T00:15:00.000Z",
        nextSequence: 1,
      },
    } satisfies AgentClaimResult;
    const contextResult = {
      ok: true,
      action: "getDecisionContext",
      data: {
        workspace: {
          tripId: "trip-1",
          preferences: [],
          candidates: [],
          evidence: [],
          feedback: [],
          placements: [],
          confirmations: [],
          workspaceCursor: "0",
          fetchedAt: "2026-08-28T00:00:00.000Z",
        },
        trip: {
          version: 3,
          days: [{ id: "day-1", date: "2026-10-01", city: "香港" }],
          travelerNames: ["一鸣", "美垚"],
          travelerCount: 2,
        },
      },
    } satisfies AgentCommandResult;
    const revokeResult = {
      ok: true,
      action: "revokeAgentRunSelf",
      data: { agentRunId: "agent-run-1", revokedAt: "2026-08-28T00:01:00.000Z" },
    } satisfies AgentCommandResult;
    const adminFailure = { ok: false, error: "ADMIN_REQUIRED" } satisfies DecisionCommandFailure;

    expect(claimResult.data.expiresAt).toBe("2026-08-28T00:15:00.000Z");
    expect(contextResult.data.trip.travelerCount).toBe(2);
    expect(revokeResult.action).toBe("revokeAgentRunSelf");
    expect(adminFailure.error).toBe("ADMIN_REQUIRED");
  });

  it("limits createAgentRun to the proposal-batch scope tuple", () => {
    const input = {
      action: "createAgentRun" as const,
      tripId: "trip-1",
      idempotencyKey: "request-001",
      publicKeyJwk: { kty: "EC" as const, crv: "P-256" as const, x: "x", y: "y" },
      pairingCodeHash: "x".repeat(43),
    };

    const parsed = DecisionCommandSchema.parse({ ...input, scope: ["submitProposalBatch"] });
    if (parsed.action !== "createAgentRun") throw new Error("unexpected command action");
    expect(parsed.scope).toEqual(["submitProposalBatch"]);
    expect(DecisionCommandSchema.safeParse({
      ...input,
      scope: ["submitProposalBatch", "appendEvidenceSnapshot"],
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

  it("requires two strict HTTPS evidence records for proposal candidates", () => {
    expect(AgentProposalCandidateInputSchema.parse(proposalCandidate).evidence).toHaveLength(2);
    expect(AgentProposalCandidateInputSchema.safeParse({
      ...proposalCandidate,
      verificationBlockReason: "captcha",
    }).success).toBe(false);
    expect(AgentProposalCandidateInputSchema.safeParse({
      ...proposalCandidate,
      evidence: [proposalEvidence],
    }).success).toBe(false);
    expect(AgentProposalEvidenceInputSchema.safeParse({
      ...proposalEvidence,
      sourceUrl: "http://hotel.example/rooms",
    }).success).toBe(false);
    expect(AgentProposalEvidenceInputSchema.safeParse({
      ...proposalEvidence,
      unknown: "not allowed",
    }).success).toBe(false);
  });

  it("rejects unknown keys at every proposal-only nested boundary", () => {
    const unknown = { leaked: "secret" };
    expect(AgentProposalDateRangeSchema.safeParse({
      start: "2026-10-01",
      end: "2026-10-02",
      ...unknown,
    }).success).toBe(false);
    expect(AgentProposalQueryContextSchema.safeParse({
      dates: { start: "2026-10-01", end: "2026-10-02" },
      travelers: 2,
      ...unknown,
    }).success).toBe(false);
    expect(AgentProposalHotelEvidenceFactsSchema.safeParse({
      ...proposalEvidence.facts,
      ...unknown,
    }).success).toBe(false);
    const restaurantFacts = {
      name: "海鲜餐厅",
      address: "香港",
      openInformation: "18:00-22:00",
      priceSnapshot: "CNY 300",
    };
    expect(AgentProposalRestaurantEvidenceFactsSchema.safeParse({
      ...restaurantFacts,
      ...unknown,
    }).success).toBe(false);
    expect(AgentProposalAttractionEvidenceFactsSchema.safeParse({
      ...restaurantFacts,
      ticketType: "成人票",
      ...unknown,
    }).success).toBe(false);
    expect(AgentProposalEntitySchema.safeParse({ ...candidate.entity, ...unknown }).success).toBe(false);
    expect(AgentProposalApplicabilitySchema.safeParse({
      ...candidate.applicability,
      ...unknown,
    }).success).toBe(false);
    expect(AgentProposalRecommendationSchema.safeParse({
      ...candidate.recommendation,
      ...unknown,
    }).success).toBe(false);
    expect(AgentProposalEvidenceInputSchema.safeParse({
      ...proposalEvidence,
      queryContext: { ...proposalEvidence.queryContext, ...unknown },
    }).success).toBe(false);
    expect(AgentProposalEvidenceInputSchema.safeParse({ ...proposalEvidence, ...unknown }).success).toBe(false);
    expect(AgentProposalCandidateInputSchema.safeParse({
      ...proposalCandidate,
      entity: { ...proposalCandidate.entity, ...unknown },
    }).success).toBe(false);
    expect(AgentProposalCandidateInputSchema.safeParse({ ...proposalCandidate, ...unknown }).success).toBe(false);

    const command = {
      agentRunId: "agent-run-1",
      sequence: 4,
      idempotencyKey: "proposal-001",
      signature: "signature",
      action: "submitProposalBatch" as const,
      payload: { round: 2, candidates: [proposalCandidate, proposalCandidate] },
    };
    expect(AgentCommandSchema.safeParse({ ...command, leaked: "secret" }).success).toBe(false);
    expect(AgentCommandSchema.safeParse({
      ...command,
      payload: { ...command.payload, leaked: "secret" },
    }).success).toBe(false);
  });

  it("preserves optional URLs for manual and appended evidence", () => {
    const manualEvidence = Object.fromEntries(
      Object.entries(proposalEvidence).filter(([key]) => key !== "sourceUrl"),
    );
    expect(AgentEvidenceInputSchema.safeParse(manualEvidence).success).toBe(true);
    expect(AgentEvidenceInputSchema.safeParse({ ...manualEvidence, legacyExtra: "preserved-compatibility" }).success).toBe(true);
    expect(AgentCommandSchema.safeParse({
      agentRunId: "agent-run-1",
      sequence: 2,
      idempotencyKey: "append-001",
      signature: "signature",
      action: "appendEvidenceSnapshot",
      payload: { candidateId: "candidate-1", expectedCandidateRevision: 2, evidence: manualEvidence },
    }).success).toBe(true);
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

  it("reserves self-revocation as a signed control action, not an agent scope", () => {
    expect(AgentCommandSchema.parse({
      agentRunId: "agent-run-1",
      sequence: 3,
      idempotencyKey: "revoke-001",
      signature: "signature",
      action: "revokeAgentRunSelf",
      payload: {},
    }).action).toBe("revokeAgentRunSelf");
    expect(AgentRunSchema.safeParse({
      agentRunId: "agent-run-1",
      tripId: "trip-1",
      status: "claimed",
      scope: ["revokeAgentRunSelf"],
      revision: 2,
      nextSequence: 1,
      createdAt: "2026-08-28T00:00:00.000Z",
      expiresAt: "2026-08-28T00:15:00.000Z",
    }).success).toBe(false);
  });
});
