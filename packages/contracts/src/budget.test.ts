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
    expect(BudgetItemSchema.parse({ ...trip.orders[0], status: "paid", paid: 1 })).toMatchObject({ paid: 1, status: "paid" });
    expect(() => BudgetItemSchema.parse({ ...trip.orders[0], status: "partial", paid: 0 })).toThrow("部分支付");
  });

  it("does not let hostile order IDs, day IDs, or currencies mutate lookup maps", () => {
    const hostile: Trip = {
      ...trip,
      days: [{ id: "__proto__", date: "2026-10-03", city: "深圳", itemIds: [] }],
      orders: [{ id: "constructor", name: "安全订单", category: "food", estimated: 100, paid: 0, currency: "__proto__", status: "unpaid", dayId: "__proto__" }],
    };
    const totals = budgetTotals(hostile);
    expect(Object.getPrototypeOf(totals.trip)).toBeNull();
    expect(totals.trip["__proto__"]).toEqual({ estimated: 100, paid: 0 });
    expect(totals.byDay["__proto__"]?.["__proto__"]).toEqual({ estimated: 100, paid: 0 });
  });

  it("never invents an estimated payment when changing a user-entered payment status", async () => {
    const { transitionOrderStatus } = await import("./budget");
    expect(transitionOrderStatus({ id: "actual", name: "实际付款", category: "hotel", estimated: 10000, paid: 8000, currency: "CNY", status: "partial" }, "paid")).toMatchObject({ status: "paid", paid: 8000 });
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
