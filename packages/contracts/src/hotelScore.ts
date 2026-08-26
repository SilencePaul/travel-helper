import type { Hotel } from "./hotel";
import type { Trip } from "./trip";

export type ScoredHotel = Hotel & {
  stayTotalMinor: number;
  totalCommuteMinutes: number;
  estimatedSteps: number;
  priceScore: number;
  commuteScore?: number;
  commuteComplete: boolean;
  badges: string[];
};

export function stayNightsForHotel(trip: Trip, hotelId: string) {
  return trip.days.filter((day) => day.hotelId === hotelId).length;
}

export type HotelCommute = { date: string; firstPlace: string; lastPlace: string; outboundMinutes: number; returnMinutes: number; distanceMeters: number; sourceCheckedAt?: string; status: "confirmed" | "pending" };

export function scoreHotels(hotels: Hotel[], { nights, commutesByHotel = {} }: { nights: number; commutesByHotel?: Record<string, HotelCommute[]> }): ScoredHotel[] {
  const raw = hotels.map((hotel) => ({
    hotel,
    stayTotalMinor: Math.round(hotel.nightlyPrice.snapshotTotalMinor * nights / hotel.nightlyPrice.snapshotNights),
    commutes: commutesByHotel[hotel.id] ?? [],
    totalCommuteMinutes: (commutesByHotel[hotel.id] ?? []).reduce((total, day) => total + day.outboundMinutes + day.returnMinutes, 0),
    estimatedSteps: 0,
  }));
  const minimumPrice = Math.min(...raw.map((item) => item.stayTotalMinor));
  const complete = raw.filter((item) => item.commutes.length > 0 && item.commutes.every((commute) => commute.status === "confirmed"));
  const minimumCommute = complete.length > 0 ? Math.min(...complete.map((item) => item.totalCommuteMinutes)) : undefined;
  return raw.map(({ hotel, stayTotalMinor, totalCommuteMinutes, estimatedSteps, commutes }) => ({
    ...hotel,
    stayTotalMinor,
    totalCommuteMinutes,
    estimatedSteps,
    priceScore: minimumPrice / stayTotalMinor,
    commuteComplete: commutes.length > 0 && commutes.every((commute) => commute.status === "confirmed"),
    commuteScore: minimumCommute !== undefined && minimumCommute > 0 && totalCommuteMinutes > 0 && commutes.length > 0 && commutes.every((commute) => commute.status === "confirmed") ? minimumCommute / totalCommuteMinutes : undefined,
    badges: [
      ...(stayTotalMinor === minimumPrice ? ["总价最低"] : []),
      ...(minimumCommute !== undefined && minimumCommute > 0 && commutes.length > 0 && commutes.every((commute) => commute.status === "confirmed") && totalCommuteMinutes === minimumCommute ? ["最省体力"] : []),
    ],
  }));
}
