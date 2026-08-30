import { z } from "zod";
import type { Trip } from "./trip";

export const CandidateCategorySchema = z.enum(["hotel", "restaurant", "attraction"]);
export const SummaryStatusSchema = z.enum(["ready", "outdated"]);
export const VerificationStateSchema = z.enum(["candidate", "web_verified", "needs_takeover", "stale"]);
export const DecisionStateSchema = z.enum(["none", "tentative", "confirmed"]);
export const FeedbackKindSchema = z.enum(["like", "dislike", "comment"]);
export const EvidenceSourceKindSchema = z.enum(["flyai", "amap", "web", "official", "manual"]);

export const RevisionSchema = z.object({
  id: z.string().min(1),
  tripId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
});

export const PreferenceAnswersSchema = z.record(
  z.string(),
  z.union([z.string(), z.array(z.string()), z.number(), z.boolean(), z.null()]),
);

export const PreferenceProfileSchema = RevisionSchema.extend({
  ownerUid: z.string().min(1),
  answers: PreferenceAnswersSchema,
  freeText: z.object({
    mustHave: z.string().optional(),
    mustAvoid: z.string().optional(),
    note: z.string().optional(),
  }).optional(),
  status: z.enum(["editing", "completed", "skipped"]),
  updatedBy: z.string().min(1),
});

export const SharedPreferenceSummarySchema = RevisionSchema.extend({
  sourcePreferenceRevisions: z.record(z.string(), z.number().int().nonnegative()),
  common: z.array(z.string()),
  disagreements: z.array(z.string()),
  tradeoffs: z.array(z.string()),
  status: SummaryStatusSchema,
  generatedAt: z.string().datetime(),
});

const DateRangeSchema = z.object({ start: z.string().date(), end: z.string().date() });

export const CandidateSchema = RevisionSchema.extend({
  category: CandidateCategorySchema,
  entity: z.object({
    name: z.string().min(1),
    address: z.string().optional(),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
  }),
  applicability: z.object({
    dates: DateRangeSchema.optional(),
    travelers: z.number().int().positive().optional(),
  }),
  recommendation: z.object({
    round: z.number().int().positive(),
    reason: z.string().min(1),
    preferenceRevisionIds: z.array(z.string()),
    feedbackIds: z.array(z.string()),
  }),
  verificationState: VerificationStateSchema,
  decisionState: DecisionStateSchema,
  currentEvidenceId: z.string().min(1).optional(),
});

export const HotelEvidenceFactsSchema = z.object({
  propertyName: z.string().min(1),
  address: z.string().min(1),
  checkInDate: z.string().date(),
  checkOutDate: z.string().date(),
  travelers: z.number().int().positive(),
  roomTypeOrBed: z.string().min(1),
  availability: z.enum(["available", "unavailable", "unknown"]),
  priceAmount: z.union([z.number().nonnegative(), z.literal("not_provided")]),
  currency: z.union([z.string().min(1), z.literal("not_provided")]),
  priceDisplay: z.enum(["total", "per_night", "per_person", "not_provided"]),
  cancellationPolicy: z.union([z.string().min(1), z.literal("not_provided")]),
});

export const RestaurantEvidenceFactsSchema = z.object({
  name: z.string().min(1),
  address: z.string().min(1),
  openInformation: z.union([z.string().min(1), z.literal("not_provided")]),
  priceSnapshot: z.union([z.string().min(1), z.literal("not_provided")]),
});

export const AttractionEvidenceFactsSchema = RestaurantEvidenceFactsSchema.extend({
  ticketType: z.union([z.string().min(1), z.literal("not_provided")]),
});

export const EvidenceSnapshotSchema = RevisionSchema.extend({
  candidateId: z.string().min(1),
  sourceKind: EvidenceSourceKindSchema,
  sourceName: z.string().min(1),
  sourceUrl: z.url().optional(),
  capturedAt: z.string().datetime(),
  queryContext: z.object({
    dates: DateRangeSchema.optional(),
    travelers: z.number().int().positive().optional(),
    roomOrTicket: z.string().optional(),
  }),
  captureMethod: z.enum(["detail_page", "search_result", "api_result", "manual"]),
  facts: z.union([HotelEvidenceFactsSchema, AttractionEvidenceFactsSchema, RestaurantEvidenceFactsSchema]),
  fieldCompleteness: z.array(z.string()),
  verificationOutcome: z.enum(["candidate", "web_verified", "blocked", "stale"]),
  supersedesEvidenceId: z.string().min(1).optional(),
  changeReason: z.string().optional(),
});

export const CandidateFeedbackSchema = RevisionSchema.extend({
  candidateId: z.string().min(1),
  actorUid: z.string().min(1),
  kind: FeedbackKindSchema,
  reason: z.string().max(2000).optional(),
  createdAt: z.string().datetime(),
});

export const TentativePlacementSchema = RevisionSchema.extend({
  candidateId: z.string().min(1),
  tripDayId: z.string().min(1),
  date: z.string().date(),
  sortKey: z.string().min(1),
  status: z.enum(["planned", "linked", "detached"]),
  legacyTripItemId: z.string().min(1).optional(),
});

export const ConfirmationReceiptSchema = RevisionSchema.extend({
  candidateId: z.string().min(1),
  memberUid: z.string().min(1),
  active: z.boolean(),
  reason: z.string().max(2000).optional(),
  actedAt: z.string().datetime(),
});

export const DecisionResourceTypeSchema = z.enum([
  "preference", "summary", "candidate", "evidence", "feedback", "confirmation", "placement",
]);

export const DecisionTombstoneSchema = z.object({
  tripId: z.string().min(1),
  resourceType: DecisionResourceTypeSchema,
  resourceId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  deletedAt: z.string().datetime(),
});

export const DecisionResourceSchema = z.union([
  PreferenceProfileSchema,
  SharedPreferenceSummarySchema,
  CandidateSchema,
  EvidenceSnapshotSchema,
  CandidateFeedbackSchema,
  ConfirmationReceiptSchema,
  TentativePlacementSchema,
  DecisionTombstoneSchema,
]);

export const DecisionEventSchema = z.object({
  tripId: z.string().min(1),
  sequence: z.number().int().positive(),
  resourceType: DecisionResourceTypeSchema,
  resourceId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  operation: z.enum(["upsert", "tombstone"]),
  occurredAt: z.string().datetime(),
  resource: DecisionResourceSchema,
});

export const DecisionWorkspaceSchema = z.object({
  tripId: z.string().min(1),
  preferences: z.array(PreferenceProfileSchema),
  summary: SharedPreferenceSummarySchema.optional(),
  candidates: z.array(CandidateSchema),
  placements: z.array(TentativePlacementSchema),
  evidence: z.array(EvidenceSnapshotSchema),
  feedback: z.array(CandidateFeedbackSchema),
  confirmations: z.array(ConfirmationReceiptSchema),
  workspaceCursor: z.string(),
  fetchedAt: z.string().datetime(),
});

const CommandBase = {
  tripId: z.string().min(1),
  idempotencyKey: z.string().min(8).max(128),
};

export const DecisionCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("upsertPreference"), ...CommandBase, expectedRevision: z.number().int().nonnegative(), answers: PreferenceAnswersSchema, freeText: PreferenceProfileSchema.shape.freeText }),
  z.object({ action: z.enum(["completePreference", "skipPreference"]), ...CommandBase, expectedRevision: z.number().int().nonnegative() }),
  z.object({ action: z.literal("generatePreferenceSummary"), ...CommandBase, sourcePreferenceRevisions: z.record(z.string(), z.number().int().nonnegative()) }),
  z.object({ action: z.literal("placeTentative"), ...CommandBase, candidateId: z.string().min(1), expectedCandidateRevision: z.number().int().nonnegative(), placement: z.object({ tripDayId: z.string().min(1), date: z.string().date(), sortKey: z.string().min(1) }) }),
  z.object({ action: z.literal("attachTentativeToLegacyTrip"), ...CommandBase, placementId: z.string().min(1), legacyItemId: z.string().min(1), expectedPlacementRevision: z.number().int().nonnegative(), expectedTripVersion: z.number().int().nonnegative() }),
  z.object({ action: z.literal("detachTentativeFromLegacyTrip"), ...CommandBase, placementId: z.string().min(1), expectedPlacementRevision: z.number().int().nonnegative(), expectedTripVersion: z.number().int().nonnegative() }),
  z.object({ action: z.literal("recordFeedback"), ...CommandBase, candidateId: z.string().min(1), kind: FeedbackKindSchema, reason: z.string().max(2000).optional() }),
  z.object({ action: z.literal("setConfirmationReceipt"), ...CommandBase, candidateId: z.string().min(1), expectedCandidateRevision: z.number().int().nonnegative(), active: z.boolean(), reason: z.string().max(2000).optional() }),
  z.object({ action: z.literal("createAgentRun"), ...CommandBase, publicKeyJwk: z.object({ kty: z.literal("EC"), crv: z.literal("P-256"), x: z.string().min(1), y: z.string().min(1) }), pairingCodeHash: z.string().length(43), scope: z.array(z.enum(["submitProposalBatch", "appendEvidenceSnapshot", "reportVerificationBlocked", "generatePreferenceSummary"])).min(1).max(4) }),
  z.object({ action: z.literal("revokeAgentRun"), ...CommandBase, agentRunId: z.string().min(1), expectedRevision: z.number().int().nonnegative() }),
]);

export const AgentEvidenceInputSchema = EvidenceSnapshotSchema.omit({
  id: true,
  tripId: true,
  candidateId: true,
  revision: true,
  updatedAt: true,
  verificationOutcome: true,
  fieldCompleteness: true,
});

export const AgentProposalCandidateInputSchema = CandidateSchema.omit({
  id: true,
  tripId: true,
  revision: true,
  updatedAt: true,
  verificationState: true,
  decisionState: true,
  currentEvidenceId: true,
}).extend({ evidence: z.array(AgentEvidenceInputSchema).min(1) });

const AgentEnvelope = {
  agentRunId: z.string().min(1),
  sequence: z.number().int().positive(),
  idempotencyKey: z.string().min(8).max(128),
  signature: z.string().min(1),
};

export const AgentCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("submitProposalBatch"), ...AgentEnvelope, payload: z.object({ round: z.number().int().positive(), candidates: z.array(AgentProposalCandidateInputSchema).min(2).max(4) }) }),
  z.object({ action: z.literal("appendEvidenceSnapshot"), ...AgentEnvelope, payload: z.object({ candidateId: z.string().min(1), expectedCandidateRevision: z.number().int().nonnegative(), evidence: AgentEvidenceInputSchema }) }),
  z.object({ action: z.literal("reportVerificationBlocked"), ...AgentEnvelope, payload: z.object({ candidateId: z.string().min(1), expectedCandidateRevision: z.number().int().nonnegative(), reason: z.enum(["login", "captcha", "risk_control", "load_failed", "field_missing"]) }) }),
  z.object({ action: z.literal("generatePreferenceSummary"), ...AgentEnvelope, payload: z.object({ sourcePreferenceRevisions: z.record(z.string(), z.number().int().nonnegative()) }) }),
]);

export const AgentClaimSchema = z.object({
  action: z.literal("claimAgentRun"),
  agentRunId: z.string().min(1),
  pairingCode: z.string().min(1),
  clientNonce: z.string().min(8),
  signature: z.string().min(1),
});

export type CandidateCategory = z.infer<typeof CandidateCategorySchema>;
export type SummaryStatus = z.infer<typeof SummaryStatusSchema>;
export type VerificationState = z.infer<typeof VerificationStateSchema>;
export type DecisionState = z.infer<typeof DecisionStateSchema>;
export type FeedbackKind = z.infer<typeof FeedbackKindSchema>;
export type EvidenceSourceKind = z.infer<typeof EvidenceSourceKindSchema>;
export type PreferenceProfile = z.infer<typeof PreferenceProfileSchema>;
export type SharedPreferenceSummary = z.infer<typeof SharedPreferenceSummarySchema>;
export type Candidate = z.infer<typeof CandidateSchema>;
export type EvidenceSnapshot = z.infer<typeof EvidenceSnapshotSchema>;
export type CandidateFeedback = z.infer<typeof CandidateFeedbackSchema>;
export type TentativePlacement = z.infer<typeof TentativePlacementSchema>;
export type ConfirmationReceipt = z.infer<typeof ConfirmationReceiptSchema>;
export type DecisionTombstone = z.infer<typeof DecisionTombstoneSchema>;
export type DecisionResource = z.infer<typeof DecisionResourceSchema>;
export type DecisionResourceType = z.infer<typeof DecisionResourceTypeSchema>;
export type DecisionEvent = z.infer<typeof DecisionEventSchema>;
export type DecisionWorkspace = z.infer<typeof DecisionWorkspaceSchema>;
export type DecisionCommand = z.infer<typeof DecisionCommandSchema>;
export type AgentEvidenceInput = z.infer<typeof AgentEvidenceInputSchema>;
export type AgentProposalCandidateInput = z.infer<typeof AgentProposalCandidateInputSchema>;
export type AgentCommand = z.infer<typeof AgentCommandSchema>;
export type AgentClaim = z.infer<typeof AgentClaimSchema>;

export type DecisionCommandSuccess =
  | { ok: true; action: "upsertPreference" | "completePreference" | "skipPreference"; data: PreferenceProfile; replayed?: boolean }
  | { ok: true; action: "generatePreferenceSummary"; data: SharedPreferenceSummary; replayed?: boolean }
  | { ok: true; action: "placeTentative" | "attachTentativeToLegacyTrip" | "detachTentativeFromLegacyTrip"; data: TentativePlacement; tripVersion?: number; replayed?: boolean }
  | { ok: true; action: "recordFeedback"; data: CandidateFeedback; replayed?: boolean }
  | { ok: true; action: "setConfirmationReceipt"; data: { receipt: ConfirmationReceipt; candidate: Candidate }; replayed?: boolean }
  | { ok: true; action: "createAgentRun"; data: { agentRunId: string; expiresAt: string }; replayed?: boolean }
  | { ok: true; action: "revokeAgentRun"; data: { agentRunId: string; revokedAt: string }; replayed?: boolean };

export type DecisionCommandFailure = {
  ok: false;
  error: "AUTH_REQUIRED" | "MEMBERSHIP_REQUIRED" | "FORBIDDEN" | "INVALID_REQUEST"
    | "VERSION_CONFLICT" | "IDEMPOTENCY_KEY_REUSED" | "SUMMARY_NOT_READY"
    | "AGENT_RUN_EXPIRED" | "AGENT_SCOPE_FORBIDDEN" | "INVALID_AGENT_CLAIM"
    | "INVALID_CONFIRMATION_STATE" | "INVALID_PLACEMENT" | "INVALID_PLACEMENT_STATE"
    | "VERIFICATION_INCOMPLETE" | "CURSOR_EXPIRED";
  latest?: DecisionResource | { tripVersion: number; trip: Trip };
};

export type DecisionCommandResult = DecisionCommandSuccess | DecisionCommandFailure;

export type AgentClaimResult =
  | { ok: true; data: { agentRunId: string; claimedAt: string; nextSequence: number } }
  | DecisionCommandFailure;

export type AgentCommandResult =
  | { ok: true; action: AgentCommand["action"]; data: Candidate[] | Candidate | SharedPreferenceSummary; replayed?: boolean }
  | DecisionCommandFailure;

export interface DecisionWorkspaceRepository {
  load(tripId: string): Promise<DecisionWorkspace>;
  refresh(tripId: string): Promise<DecisionWorkspace>;
  command(input: DecisionCommand): Promise<DecisionCommandResult>;
  events(tripId: string, afterCursor: number): Promise<{ events: DecisionEvent[]; cursor: number }>;
  subscribe(tripId: string, onChange: (workspace: DecisionWorkspace) => void): () => void;
}
