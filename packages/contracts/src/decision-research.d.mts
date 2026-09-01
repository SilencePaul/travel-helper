import type { AgentDecisionContext } from "./decision.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ResearchCategory = "hotel" | "restaurant" | "attraction";

export interface CryptoLike {
  readonly subtle: Pick<SubtleCrypto, "digest">;
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

export type DecisionResearchContext = AgentDecisionContext;

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
      facts: JsonValue;
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
