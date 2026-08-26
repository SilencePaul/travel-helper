import { z } from "zod";

export const PlaceImageSchema = z.object({
  url: z.url(),
  alt: z.string().min(1),
  licenseOrOwner: z.string().min(1),
});

export const PlaceSourceSchema = z.object({
  label: z.string().min(1),
  url: z.url(),
  kind: z.enum(["official", "community", "menu", "tourism-board"]),
  checkedAt: z.string().datetime(),
});

const PlaceCoreSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  address: z.string().min(1),
  coordinate: z.object({
    lng: z.number().gte(-180).lte(180),
    lat: z.number().gte(-90).lte(90),
    coordinateSystem: z.literal("GCJ02"),
  }),
  summary: z.string().min(1),
  updatedAt: z.string().datetime(),
  images: z.array(PlaceImageSchema).min(1),
  sources: z.array(PlaceSourceSchema).min(1),
});

export const RestaurantPlaceSchema = PlaceCoreSchema.extend({
  type: z.literal("restaurant"),
  averagePrice: z.string().min(1),
  signatureDishes: z.array(z.string().min(1)).min(1),
  twoPersonOrder: z.string().min(1),
  hours: z.string().min(1),
  queueNote: z.string().min(1),
  reservationUrl: z.url(),
});

export const AttractionPlaceSchema = PlaceCoreSchema.extend({
  type: z.literal("attraction"),
  ticketPrice: z.string().min(1),
  hours: z.string().min(1),
  stayMinutes: z.number().int().positive(),
  bestTime: z.string().min(1),
  crowdNote: z.string().min(1),
  photoSpots: z.array(z.string().min(1)).min(1),
  rainAlternativeId: z.string().min(1),
  bookingUrl: z.url(),
});

export const PlaceSchema = z.discriminatedUnion("type", [RestaurantPlaceSchema, AttractionPlaceSchema]);

export type PlaceImage = z.infer<typeof PlaceImageSchema>;
export type PlaceSource = z.infer<typeof PlaceSourceSchema>;
export type RestaurantPlace = z.infer<typeof RestaurantPlaceSchema>;
export type AttractionPlace = z.infer<typeof AttractionPlaceSchema>;
export type Place = z.infer<typeof PlaceSchema>;
