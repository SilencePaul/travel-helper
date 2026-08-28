import { describe, expect, it } from "vitest";
import { DecisionCommandSchema, PreferenceProfileSchema } from "./decision";

describe("decision contracts", () => {
  it("accepts an owner-scoped preference command", () => {
    expect(DecisionCommandSchema.parse({ action: "upsertPreference", tripId: "trip-1", expectedRevision: 0, idempotencyKey: "request-001", answers: { pace: "slow" } }).action).toBe("upsertPreference");
  });

  it("rejects an incomplete tentative placement", () => {
    expect(DecisionCommandSchema.safeParse({ action: "placeTentative", tripId: "trip-1", candidateId: "c-1", expectedRevision: 0, idempotencyKey: "request-001", placement: { tripDayId: "day-1" } }).success).toBe(false);
  });

  it("keeps profiles revisioned without a client ACL field", () => {
    expect(PreferenceProfileSchema.parse({ id: "p-1", tripId: "trip-1", ownerUid: "user-1", answers: {}, status: "editing", revision: 0, updatedAt: "2026-08-28T00:00:00.000Z", updatedBy: "user-1" }).ownerUid).toBe("user-1");
  });
});
