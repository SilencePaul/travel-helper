export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ResearchCategory = "hotel" | "restaurant" | "attraction";

export interface CryptoLike {
  readonly subtle: {
    digest(algorithm: "SHA-256", data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer>;
  };
}

export interface ResearchTripProjection {
  version: number;
  days: Array<{ id: string; date: string; city: string }>;
  travelerNames: string[];
  travelerCount: number;
}

export interface ResearchTargetScope {
  targetScopeId: string;
  city: string;
  startDate: string;
  endDate: string;
  travelerCount: number;
}

export type PreferenceAnswer = string | string[] | number | boolean | null;

export interface ResearchRevision {
  id: string;
  tripId: string;
  revision: number;
  updatedAt: string;
}

export interface ResearchPreferenceProfile extends ResearchRevision {
  ownerUid: string;
  answers: Record<string, PreferenceAnswer>;
  freeText?: { mustHave?: string; mustAvoid?: string; note?: string };
  status: "editing" | "completed" | "skipped";
  updatedBy: string;
}

export interface ResearchSharedPreferenceSummary extends ResearchRevision {
  sourcePreferenceRevisions: Record<string, number>;
  common: string[];
  disagreements: string[];
  tradeoffs: string[];
  status: "ready" | "outdated";
  generatedAt: string;
}

export interface ResearchCandidate extends ResearchRevision {
  category: ResearchCategory;
  entity: { name: string; address?: string; latitude?: number; longitude?: number };
  applicability: { dates?: { start: string; end: string }; travelers?: number };
  recommendation: {
    round: number;
    reason: string;
    preferenceRevisionIds: string[];
    feedbackIds: string[];
  };
  verificationState: "candidate" | "web_verified" | "needs_takeover" | "stale";
  decisionState: "none" | "tentative" | "confirmed";
  currentEvidenceId?: string;
  verificationBlockReason?: "login" | "captcha" | "risk_control" | "load_failed" | "field_missing";
}

export interface ResearchHotelEvidenceFacts {
  propertyName: string;
  address: string;
  checkInDate: string;
  checkOutDate: string;
  travelers: number;
  roomTypeOrBed: string;
  availability: "available" | "unavailable" | "unknown";
  priceAmount: number | "not_provided";
  currency: string;
  priceDisplay: "total" | "per_night" | "per_person" | "not_provided";
  cancellationPolicy: string;
}

export interface ResearchRestaurantEvidenceFacts {
  name: string;
  address: string;
  openInformation: string;
  priceSnapshot: string;
}

export interface ResearchAttractionEvidenceFacts extends ResearchRestaurantEvidenceFacts {
  ticketType: string;
}

export type ResearchEvidenceFacts =
  | ResearchHotelEvidenceFacts
  | ResearchRestaurantEvidenceFacts
  | ResearchAttractionEvidenceFacts;

export interface ResearchEvidenceSnapshot extends ResearchRevision {
  candidateId: string;
  sourceKind: "flyai" | "amap" | "web" | "official" | "manual";
  sourceName: string;
  sourceUrl?: string;
  capturedAt: string;
  queryContext: { dates?: { start: string; end: string }; travelers?: number; roomOrTicket?: string };
  captureMethod: "detail_page" | "search_result" | "api_result" | "manual";
  facts: ResearchEvidenceFacts;
  fieldCompleteness: string[];
  verificationOutcome: "candidate" | "web_verified" | "blocked" | "stale";
  supersedesEvidenceId?: string;
  changeReason?: string;
}

export interface ResearchCandidateFeedback extends ResearchRevision {
  candidateId: string;
  actorUid: string;
  kind: "like" | "dislike" | "comment";
  reason?: string;
  createdAt: string;
}

export interface ResearchTentativePlacement extends ResearchRevision {
  candidateId: string;
  tripDayId: string;
  date: string;
  sortKey: string;
  status: "planned" | "linked" | "detached";
  legacyTripItemId?: string;
}

export interface ResearchConfirmationReceipt extends ResearchRevision {
  candidateId: string;
  memberUid: string;
  active: boolean;
  reason?: string;
  actedAt: string;
}

export interface ResearchDecisionWorkspace {
  tripId: string;
  preferences: ResearchPreferenceProfile[];
  summary?: ResearchSharedPreferenceSummary;
  candidates: ResearchCandidate[];
  placements: ResearchTentativePlacement[];
  evidence: ResearchEvidenceSnapshot[];
  feedback: ResearchCandidateFeedback[];
  confirmations: ResearchConfirmationReceipt[];
  workspaceCursor: string;
  fetchedAt: string;
}

export interface DecisionResearchContext {
  workspace: ResearchDecisionWorkspace;
  trip: ResearchTripProjection;
}

export interface ResearchResourceCommitment {
  resourceType: "trip_day" | "preference" | "summary" | "candidate" | "evidence" | "feedback";
  digest: string;
}

export interface ResearchDisclosure {
  category: ResearchCategory;
  segment: { city: string; startDate: string; endDate: string; travelerCount: number };
  travelerNames: string[];
  preferences: Array<{
    answers: Record<string, PreferenceAnswer>;
    freeText?: { mustHave?: string; mustAvoid?: string; note?: string };
  }>;
  summary: null | {
    common: string[];
    disagreements: string[];
    tradeoffs: string[];
    status: "ready" | "outdated";
  };
  feedback: Array<{
    candidateName: string;
    kind: "like" | "dislike" | "comment";
    reason?: string;
  }>;
  existingCandidates: Array<{
    category: ResearchCategory;
    entity: { name: string; address?: string };
    applicability: { dates?: { start: string; end: string }; travelers?: number };
    recommendation: { reason: string };
    evidence: Array<{
      sourceKind: "flyai" | "amap" | "web" | "official" | "manual";
      sourceName: string;
      sourceUrl?: string;
      queryContext: { dates?: { start: string; end: string }; travelers?: number; roomOrTicket?: string };
      captureMethod: "detail_page" | "search_result" | "api_result" | "manual";
      facts: ResearchEvidenceFacts;
    }>;
  }>;
  resourceCommitments: ResearchResourceCommitment[];
}

export function canonicalJson(value: unknown): string;
export function buildResearchTargetScopes(trip: ResearchTripProjection): ResearchTargetScope[];
export function computeDisclosureFingerprint(
  disclosure: unknown,
  cryptoProvider?: CryptoLike,
): Promise<string>;
export function buildResearchDisclosure(
  context: DecisionResearchContext,
  options: { category: ResearchCategory; targetScopeId: string },
  cryptoProvider?: CryptoLike,
): Promise<ResearchDisclosure>;
