import type { Hotel, HotelCommute, Trip } from "@travel/contracts";
import { getPlaces } from "../itinerary/itineraryData";

function distanceKm(a: { lng: number; lat: number }, b: { lng: number; lat: number }) {
  const latScale = 111;
  const lngScale = 111 * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  return Math.hypot((a.lng - b.lng) * lngScale, (a.lat - b.lat) * latScale);
}

export function deriveHotelCommutes(trip: Trip, hotel: Hotel): HotelCommute[] {
  return trip.days.filter((day) => day.city.includes("香港")).map((day) => {
    const places = getPlaces(day.itemIds);
    const first = places[0];
    const last = places.at(-1);
    const outboundKm = first ? distanceKm(hotel.coordinate, first) : 0;
    const returnKm = last ? distanceKm(last, hotel.coordinate) : 0;
    return {
      date: day.date,
      firstPlace: first?.name ?? "当天首站待安排",
      lastPlace: last?.name ?? "当天末站待安排",
      outboundMinutes: first ? Math.max(1, Math.round(outboundKm * 7)) : 0,
      returnMinutes: last ? Math.max(1, Math.round(returnKm * 7)) : 0,
      estimatedSteps: Math.round((outboundKm + returnKm) * 1400),
    };
  });
}
