import { z } from "zod";
import { BudgetItemSchema } from "./budget";

export const TravelDaySchema = z.object({
  id: z.string().min(1),
  date: z.string().date(),
  city: z.string(),
  itemIds: z.array(z.string()),
  hotelId: z.string().nullable().optional(),
});

export const TripSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  startDate: z.string().date(),
  endDate: z.string().date(),
  travelers: z.array(z.object({ id: z.string(), name: z.string() })),
  days: z.array(TravelDaySchema),
  unscheduledItemIds: z.array(z.string()),
  orders: z.array(BudgetItemSchema).default([]),
  version: z.number().int().nonnegative(),
}).superRefine((trip, context) => {
  if (trip.endDate < trip.startDate) {
    context.addIssue({
      code: "custom",
      message: "结束日期不能早于开始日期",
      path: ["endDate"],
    });
  }

  const dayIds = new Set<string>();
  trip.days.forEach((day, index) => {
    if (dayIds.has(day.id)) {
      context.addIssue({
        code: "custom",
        message: "日期 ID 不能重复",
        path: ["days", index, "id"],
      });
    }
    dayIds.add(day.id);
  });
});

export type TravelDay = z.infer<typeof TravelDaySchema>;
export type Trip = z.infer<typeof TripSchema>;
