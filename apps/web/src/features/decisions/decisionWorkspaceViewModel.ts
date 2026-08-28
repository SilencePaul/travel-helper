export type PreferenceCompletion = "editing" | "completed" | "skipped";
export type SummaryPresentationState = "ready" | "outdated";
export type VerificationPresentationState = "candidate" | "web_verified" | "needs_takeover" | "stale";
export type DecisionPresentationState = "none" | "tentative" | "confirmed";

export type TravelerPreferenceViewModel = {
  id: string;
  name: string;
  status: PreferenceCompletion;
  updatedAt: string;
  preferences: string[];
  mustHave?: string;
  mustAvoid?: string;
};

export type SharedPreferenceSummaryViewModel = {
  status: SummaryPresentationState;
  common: string[];
  disagreements: string[];
  tradeoffs: string[];
};

export type CandidateFeedbackViewModel = {
  traveler: string;
  kind: "like" | "dislike" | "comment";
  note?: string;
};

export type CandidateEvidenceViewModel = {
  source: string;
  capturedAt: string;
  snapshot: string;
};

export type CandidateConfirmationViewModel = {
  confirmedBy: string[];
  awaiting: string[];
};

export type DecisionCandidateViewModel = {
  id: string;
  category: "hotel" | "restaurant" | "attraction";
  name: string;
  location: string;
  applicability: string;
  recommendation: string;
  verificationState: VerificationPresentationState;
  decisionState: DecisionPresentationState;
  evidence: CandidateEvidenceViewModel;
  feedback: CandidateFeedbackViewModel[];
  placement?: string;
  confirmations?: CandidateConfirmationViewModel;
};

export type DecisionWorkspaceViewModel = {
  travelers: TravelerPreferenceViewModel[];
  summary?: SharedPreferenceSummaryViewModel;
  candidates: DecisionCandidateViewModel[];
};
