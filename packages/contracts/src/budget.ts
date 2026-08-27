import { z } from "zod";
import type { Trip } from "./trip";

export const BudgetCategorySchema = z.enum(["flight", "hotel", "transport", "ticket", "food"]);
export const OrderStatusSchema = z.enum(["unpaid", "partial", "paid"]);

/** Monetary values are stored in the smallest unit (for example cents). */
export const BudgetItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  category: BudgetCategorySchema,
  estimated: z.number().int().nonnegative(),
  paid: z.number().int().nonnegative(),
  currency: z.string().min(1).max(8),
  status: OrderStatusSchema,
  dayId: z.string().min(1).optional(),
}).superRefine((item, context) => {
  if (item.status === "unpaid" && item.paid !== 0) context.addIssue({ code: "custom", message: "未支付订单的已支付金额必须为 0", path: ["paid"] });
  if (item.status === "partial" && item.paid <= 0) context.addIssue({ code: "custom", message: "部分支付订单必须录入实际已付金额", path: ["paid"] });
  if (item.status === "paid" && item.paid <= 0) context.addIssue({ code: "custom", message: "已支付订单必须录入实际已付金额", path: ["paid"] });
});

export type BudgetCategory = z.infer<typeof BudgetCategorySchema>;
export type OrderStatus = z.infer<typeof OrderStatusSchema>;
export type BudgetItem = z.infer<typeof BudgetItemSchema>;

export type CurrencyTotals = Record<string, { estimated: number; paid: number }>;

function safeTotals(): CurrencyTotals { return Object.create(null) as CurrencyTotals; }

export function transitionOrderStatus(order: BudgetItem, status: OrderStatus): BudgetItem {
  if (status === "unpaid") {
    if (order.paid !== 0) throw new Error("请先将已付金额改为 0，再标记为未支付");
    return { ...order, status };
  }
  if (status === "paid") {
    if (order.paid <= 0) throw new Error("请先录入实际已付金额，再标记为已支付");
    return { ...order, status };
  }
  if (order.paid <= 0) {
    throw new Error("部分支付请先录入实际已付金额");
  }
  return { ...order, status };
}

export function applyOrderPayment(order: BudgetItem, paid: number): BudgetItem {
  if (!Number.isInteger(paid) || paid < 0) throw new Error("已付金额必须为非负整数");
  // An estimate is not a bill: only an explicit status action marks an order paid.
  const status: OrderStatus = paid === 0 ? "unpaid" : order.status === "paid" ? "paid" : "partial";
  return { ...order, paid, status };
}

function addToTotals(totals: CurrencyTotals, item: BudgetItem) {
  const current = totals[item.currency] ?? { estimated: 0, paid: 0 };
  totals[item.currency] = {
    estimated: current.estimated + item.estimated,
    paid: current.paid + item.paid,
  };
}

function emptyCategoryTotals(): Record<BudgetCategory, CurrencyTotals> {
  return { flight: safeTotals(), hotel: safeTotals(), transport: safeTotals(), ticket: safeTotals(), food: safeTotals() };
}

export function budgetTotals(trip: Trip) {
  const tripTotals = safeTotals();
  const byCategory = emptyCategoryTotals();
  const byDay: Record<string, CurrencyTotals> = Object.create(null) as Record<string, CurrencyTotals>;
  trip.days.forEach((day) => { byDay[day.id] = safeTotals(); });

  // Older local drafts are parsed with the schema on persistence, but tolerate
  // an in-memory legacy repository during migration.
  (trip.orders ?? []).forEach((order) => {
    addToTotals(tripTotals, order);
    addToTotals(byCategory[order.category]!, order);
    const dayTotals = order.dayId ? byDay[order.dayId] : undefined;
    if (dayTotals) addToTotals(dayTotals, order);
  });

  return { trip: tripTotals, byCategory, byDay };
}

/** Orders are never implicitly deleted when the day range is shortened. */
export function getDateRangeOrderWarning(trip: Trip, startDate: string, endDate: string) {
  const keptDayIds = new Set(trip.days
    .filter((day) => day.date >= startDate && day.date <= endDate)
    .map((day) => day.id));

  return (trip.orders ?? [])
    .filter((order) => (order.category === "hotel" || order.category === "ticket")
      && order.dayId
      && !keptDayIds.has(order.dayId))
    .map(({ id, name, category, dayId }) => ({ id, name, category, dayId: dayId! }));
}
