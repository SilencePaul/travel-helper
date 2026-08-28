import { z } from "zod";

export const RevisionSchema = z.object({ id: z.string().min(1), tripId: z.string().min(1), revision: z.number().int().nonnegative(), updatedAt: z.string().datetime() });
export const PreferenceProfileSchema = RevisionSchema.extend({ ownerUid: z.string().min(1), answers: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.number(), z.boolean(), z.null()])), freeText: z.object({ mustHave: z.string().optional(), mustAvoid: z.string().optional(), note: z.string().optional() }).optional(), status: z.enum(["editing", "completed", "skipped"]), updatedBy: z.string().min(1) });
export const TentativePlacementSchema = RevisionSchema.extend({ candidateId: z.string().min(1), tripDayId: z.string().min(1), date: z.string().date(), sortKey: z.string().min(1), status: z.enum(["planned", "linked", "detached"]), legacyTripItemId: z.string().optional() });
const Base = { tripId: z.string().min(1), idempotencyKey: z.string().min(8).max(128) };
export const DecisionCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("getDecisionWorkspace"), tripId: Base.tripId }),
  z.object({ action: z.literal("upsertPreference"), ...Base, expectedRevision: z.number().int().nonnegative(), answers: PreferenceProfileSchema.shape.answers, freeText: PreferenceProfileSchema.shape.freeText }),
  z.object({ action: z.enum(["completePreference", "skipPreference"]), ...Base, expectedRevision: z.number().int().nonnegative() }),
  z.object({ action: z.literal("recordFeedback"), ...Base, candidateId: z.string().min(1), kind: z.enum(["like", "dislike", "comment"]), reason: z.string().max(2000).optional() }),
  z.object({ action: z.literal("placeTentative"), ...Base, candidateId: z.string().min(1), expectedRevision: z.number().int().nonnegative(), placement: z.object({ tripDayId: z.string().min(1), date: z.string().date(), sortKey: z.string().min(1) }) }),
  z.object({ action: z.literal("setConfirmationReceipt"), ...Base, candidateId: z.string().min(1), expectedRevision: z.number().int().nonnegative(), active: z.boolean(), reason: z.string().max(2000).optional() }),
]);
export type PreferenceProfile = z.infer<typeof PreferenceProfileSchema>;
export type TentativePlacement = z.infer<typeof TentativePlacementSchema>;
export type DecisionCommand = z.infer<typeof DecisionCommandSchema>;
export type Candidate = { id: string; tripId: string; category: "hotel" | "restaurant" | "attraction"; name: string; revision: number; verificationState: "candidate" | "web_verified" | "needs_takeover" | "stale"; decisionState: "none" | "tentative" | "confirmed"; updatedAt: string };
export type EvidenceSnapshot = { id: string; tripId: string; candidateId: string; sourceKind: "flyai" | "amap" | "web" | "official" | "manual"; capturedAt: string; revision: number };
export type CandidateFeedback = { id: string; tripId: string; candidateId: string; actorUid: string; kind: "like" | "dislike" | "comment"; reason?: string; revision: number; createdAt: string };
export type ConfirmationReceipt = { id: string; tripId: string; candidateId: string; memberUid: string; active: boolean; revision: number; actedAt: string };
export type SharedPreferenceSummary = { id: string; tripId: string; sourcePreferenceRevisions: Record<string, number>; common: string[]; disagreements: string[]; tradeoffs: string[]; status: "ready" | "outdated"; revision: number; updatedAt: string };
export type DecisionResource = PreferenceProfile | TentativePlacement | Candidate | EvidenceSnapshot | CandidateFeedback | ConfirmationReceipt | SharedPreferenceSummary;
export type DecisionWorkspace = { tripId: string; preferences: PreferenceProfile[]; summary?: SharedPreferenceSummary; candidates: Candidate[]; evidence: EvidenceSnapshot[]; feedback: CandidateFeedback[]; placements: TentativePlacement[]; confirmations: ConfirmationReceipt[]; workspaceCursor: number; fetchedAt: string };
export type CommandResult = { ok: true; data: DecisionResource | DecisionWorkspace; replayed?: boolean } | { ok: false; error: "VERSION_CONFLICT" | "IDEMPOTENCY_KEY_REUSED" | "FORBIDDEN" | "INVALID_CONFIRMATION_STATE"; latest?: DecisionResource };
export interface DecisionWorkspaceRepository { load(tripId: string): Promise<DecisionWorkspace>; command(input: DecisionCommand): Promise<CommandResult>; }
