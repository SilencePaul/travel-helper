import type { Hotel, HotelCommute, Trip } from "@travel/contracts";
import { getPlaces } from "../itinerary/itineraryData";
import type { RouteService, TimelinePlace } from "../map/types";

export async function deriveHotelCommutes(trip: Trip, hotel: Hotel, routeService: RouteService): Promise<HotelCommute[]> {
  return Promise.all(trip.days.filter((day) => day.city.includes("香港")).map(async (day) => {
    const places = getPlaces(day.itemIds);
    const first = places[0];
    const last = places.at(-1);
    const pending = (): HotelCommute => ({
      date: day.date,
      firstPlace: first?.name ?? "当天首站待安排",
      lastPlace: last?.name ?? "当天末站待安排",
      outboundMinutes: 0, returnMinutes: 0, distanceMeters: 0, status: "pending",
    });
    if (!first || !last) return pending();
    const hotelPlace: TimelinePlace = { id: hotel.id, name: hotel.name, amapPoiId: hotel.id, ...hotel.coordinate };
    try {
      const [outbound, inbound] = await Promise.all([
        routeService.getSegments({ dayId: `${day.id}:hotel-out`, placeIds: [hotelPlace.id, first.id], modeByLeg: ["transit"] }),
        routeService.getSegments({ dayId: `${day.id}:hotel-back`, placeIds: [last.id, hotelPlace.id], modeByLeg: ["transit"] }),
      ]);
      if (!outbound[0] || !inbound[0] || !Number.isFinite(outbound[0].durationMinutes) || !Number.isFinite(inbound[0].durationMinutes) || !Number.isFinite(outbound[0].distanceMeters) || !Number.isFinite(inbound[0].distanceMeters) || outbound[0].durationMinutes <= 0 || inbound[0].durationMinutes <= 0 || outbound[0].distanceMeters <= 0 || inbound[0].distanceMeters <= 0) return pending();
      return { date: day.date, firstPlace: first.name, lastPlace: last.name, outboundMinutes: outbound[0].durationMinutes, returnMinutes: inbound[0].durationMinutes, distanceMeters: outbound[0].distanceMeters + inbound[0].distanceMeters, sourceCheckedAt: new Date().toISOString(), status: "confirmed" };
    } catch { return pending(); }
  }));
}
