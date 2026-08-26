import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import type { Trip } from "@travel/contracts";
import { BudgetPanel } from "./BudgetPanel";

const trip: Trip = {
  id: "trip", title: "测试", startDate: "2026-10-03", endDate: "2026-10-04", travelers: [], version: 0,
  days: [{ id: "d1", date: "2026-10-03", city: "深圳", itemIds: [] }, { id: "d2", date: "2026-10-04", city: "香港", itemIds: [] }],
  unscheduledItemIds: [],
  orders: [
    { id: "flight", name: "机票", category: "flight", estimated: 200000, paid: 200000, currency: "CNY", status: "paid" },
    { id: "food", name: "晚餐", category: "food", estimated: 10000, paid: 0, currency: "HKD", status: "unpaid", dayId: "d2" },
  ],
};

test("shows trip, category, and day totals from persisted orders", () => {
  render(<BudgetPanel trip={trip} />);
  expect(screen.getByText("总预算")).toBeVisible();
  expect(screen.getByText("CNY 2,000.00 · 已付 2,000.00")).toBeVisible();
  expect(screen.getByText((_, element) => element?.tagName === "LI" && element.textContent === "机票 · CNY 2,000.00 / 已付 2,000.00")).toBeVisible();
  expect(screen.getByText((_, element) => element?.tagName === "LI" && element.textContent === "D2 · HKD 100.00 / 已付 0.00")).toBeVisible();
});
