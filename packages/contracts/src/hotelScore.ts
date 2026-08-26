import type { Hotel } from "./hotel";
import type { Trip } from "./trip";

export type ScoredHotel = Hotel & {
  stayTotalMinor: number;
  totalCommuteMinutes: number;
  estimatedSteps: number;
  priceScore: number;
  commuteScore: number;
  badges: string[];
};

export function stayNightsForHotel(trip: Trip, hotelId: string) {
  return trip.days.filter((day) => day.hotelId === hotelId).length;
}

export type HotelCommute = { date: string; firstPlace: string; lastPlace: string; outboundMinutes: number; returnMinutes: number; estimatedSteps: number };

export function scoreHotels(hotels: Hotel[], { nights, commutesByHotel = {} }: { nights: number; commutesByHotel?: Record<string, HotelCommute[]> }): ScoredHotel[] {
  const raw = hotels.map((hotel) => ({
    hotel,
    stayTotalMinor: Math.round(hotel.nightlyPrice.snapshotTotalMinor * nights / hotel.nightlyPrice.snapshotNights),
    totalCommuteMinutes: (commutesByHotel[hotel.id] ?? []).reduce((total, day) => total + day.outboundMinutes + day.returnMinutes, 0),
    estimatedSteps: (commutesByHotel[hotel.id] ?? []).reduce((total, day) => total + day.estimatedSteps, 0),
  }));
  const minimumPrice = Math.min(...raw.map((item) => item.stayTotalMinor));
  const minimumCommute = Math.min(...raw.map((item) => item.totalCommuteMinutes));
  return raw.map(({ hotel, stayTotalMinor, totalCommuteMinutes, estimatedSteps }) => ({
    ...hotel,
    stayTotalMinor,
    totalCommuteMinutes,
    estimatedSteps,
    priceScore: minimumPrice / stayTotalMinor,
    commuteScore: totalCommuteMinutes === 0 ? 1 : minimumCommute / totalCommuteMinutes,
    badges: [
      ...(stayTotalMinor === minimumPrice ? ["总价最低"] : []),
      ...(totalCommuteMinutes === minimumCommute ? ["最省体力"] : []),
    ],
  }));
}
