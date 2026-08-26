import type { Hotel } from "./hotel";
import type { Trip } from "./trip";

export type ScoredHotel = Hotel & {
  stayTotal: number;
  totalCommuteMinutes: number;
  estimatedSteps: number;
  priceScore: number;
  commuteScore: number;
  badges: string[];
};

export function stayNightsForHotel(trip: Trip, hotelId: string) {
  return trip.days.filter((day) => day.hotelId === hotelId).length;
}

export function scoreHotels(hotels: Hotel[], { nights }: { nights: number }): ScoredHotel[] {
  const raw = hotels.map((hotel) => ({
    hotel,
    stayTotal: hotel.nightlyPrice.amount * nights,
    totalCommuteMinutes: hotel.commuteByDay.reduce((total, day) => total + day.outboundMinutes + day.returnMinutes, 0),
    estimatedSteps: hotel.commuteByDay.reduce((total, day) => total + day.estimatedSteps, 0),
  }));
  const minimumPrice = Math.min(...raw.map((item) => item.stayTotal));
  const minimumCommute = Math.min(...raw.map((item) => item.totalCommuteMinutes));
  return raw.map(({ hotel, stayTotal, totalCommuteMinutes, estimatedSteps }) => ({
    ...hotel,
    stayTotal,
    totalCommuteMinutes,
    estimatedSteps,
    priceScore: minimumPrice / stayTotal,
    commuteScore: totalCommuteMinutes === 0 ? 1 : minimumCommute / totalCommuteMinutes,
    badges: [
      ...(stayTotal === minimumPrice ? ["总价最低"] : []),
      ...(totalCommuteMinutes === minimumCommute ? ["最省体力"] : []),
    ],
  }));
}
