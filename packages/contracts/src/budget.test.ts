import { describe, expect, it } from "vitest";
import {
  BudgetItemSchema,
  budgetTotals,
  getDateRangeOrderWarning,
} from "./budget";
import type { Trip } from "./trip";

const trip: Trip = {
  id: "trip", title: "测试", startDate: "2026-10-03", endDate: "2026-10-04", travelers: [], version: 0,
  days: [
    { id: "day-1", date: "2026-10-03", city: "深圳", itemIds: [] },
    { id: "day-2", date: "2026-10-04", city: "香港", itemIds: [] },
  ],
  unscheduledItemIds: [],
  orders: [
    { id: "flight", name: "往返机票", category: "flight", estimated: 200000, paid: 180000, currency: "CNY", status: "partial" },
    { id: "hotel", name: "香港酒店", category: "hotel", estimated: 100000, paid: 0, currency: "HKD", status: "unpaid", dayId: "day-2" },
    { id: "ticket", name: "山顶缆车", category: "ticket", estimated: 21600, paid: 21600, currency: "HKD", status: "paid", dayId: "day-2" },
  ],
};

describe("budget contract", () => {
  it("requires monetary amounts, a category, and a persisted status", () => {
    expect(BudgetItemSchema.parse(trip.orders[0])).toMatchObject({ status: "partial", currency: "CNY" });
    expect(() => BudgetItemSchema.parse({ ...trip.orders[0], paid: -1 })).toThrow();
  });

  it("derives trip, category, and day totals without mixing currencies", () => {
    expect(budgetTotals(trip)).toEqual({
      trip: {
        CNY: { estimated: 200000, paid: 180000 },
        HKD: { estimated: 121600, paid: 21600 },
      },
      byCategory: {
        flight: { CNY: { estimated: 200000, paid: 180000 } },
        hotel: { HKD: { estimated: 100000, paid: 0 } },
        ticket: { HKD: { estimated: 21600, paid: 21600 } },
        transport: {},
        food: {},
      },
      byDay: {
        "day-1": {},
        "day-2": { HKD: { estimated: 121600, paid: 21600 } },
      },
    });
  });

  it("warns before a date reduction removes hotel or ticket orders, without changing them", () => {
    const warning = getDateRangeOrderWarning(trip, "2026-10-03", "2026-10-03");
    expect(warning).toEqual([
      { id: "hotel", name: "香港酒店", category: "hotel", dayId: "day-2" },
      { id: "ticket", name: "山顶缆车", category: "ticket", dayId: "day-2" },
    ]);
    expect(trip.orders).toHaveLength(3);
  });
});
