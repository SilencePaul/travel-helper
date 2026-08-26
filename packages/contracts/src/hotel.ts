import { z } from "zod";

export const HotelSourceSchema = z.object({
  label: z.string().min(1),
  url: z.url(),
  platform: z.string().min(1),
  checkedAt: z.string().datetime(),
});

export const HotelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  address: z.string().min(1),
  coordinate: z.object({
    lng: z.number().gte(-180).lte(180),
    lat: z.number().gte(-90).lte(90),
    coordinateSystem: z.literal("GCJ02"),
  }),
  neighborhood: z.string().min(1),
  nightlyPrice: z.object({
    amount: z.number().positive(),
    currency: z.string().min(1),
    scope: z.string().min(1),
    source: HotelSourceSchema,
  }),
  roomArea: z.string().min(1),
  breakfast: z.string().min(1),
  cancellation: z.string().min(1),
  stationWalk: z.string().min(1),
  strengths: z.array(z.string().min(1)).min(1),
  drawbacks: z.array(z.string().min(1)).min(1),
  commuteByDay: z.array(z.object({
    date: z.string().date(),
    firstPlace: z.string().min(1),
    lastPlace: z.string().min(1),
    outboundMinutes: z.number().int().nonnegative(),
    returnMinutes: z.number().int().nonnegative(),
    estimatedSteps: z.number().int().nonnegative(),
  })),
});

export type Hotel = z.infer<typeof HotelSchema>;
export type HotelSource = z.infer<typeof HotelSourceSchema>;
