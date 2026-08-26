import { z } from "zod";

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
  version: z.number().int().nonnegative(),
});

export type TravelDay = z.infer<typeof TravelDaySchema>;
export type Trip = z.infer<typeof TripSchema>;
