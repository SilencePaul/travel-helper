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
    const hotelPlace: TimelinePlace = { id: hotel.id, name: hotel.name, amapPoiId: hotel.amapPoiId, ...hotel.coordinate };
    try {
      const [outbound, inbound] = await Promise.all([
        routeService.getSegments({ dayId: `${day.id}:hotel-out`, city: day.city, placeIds: [hotelPlace.id, first.id], modeByLeg: ["transit"] }),
        routeService.getSegments({ dayId: `${day.id}:hotel-back`, city: day.city, placeIds: [last.id, hotelPlace.id], modeByLeg: ["transit"] }),
      ]);
      const [outboundWalk, inboundWalk] = await Promise.allSettled([
        routeService.getSegments({ dayId: `${day.id}:hotel-out-walk`, city: day.city, placeIds: [hotelPlace.id, first.id], modeByLeg: ["walking"] }),
        routeService.getSegments({ dayId: `${day.id}:hotel-back-walk`, city: day.city, placeIds: [last.id, hotelPlace.id], modeByLeg: ["walking"] }),
      ]);
      const outboundSegment = outbound.segments[0];
      const inboundSegment = inbound.segments[0];
      if (outbound.failures.length || inbound.failures.length || !outboundSegment || !inboundSegment || !Number.isFinite(outboundSegment.durationMinutes) || !Number.isFinite(inboundSegment.durationMinutes) || !Number.isFinite(outboundSegment.distanceMeters) || !Number.isFinite(inboundSegment.distanceMeters) || outboundSegment.durationMinutes <= 0 || inboundSegment.durationMinutes <= 0 || outboundSegment.distanceMeters <= 0 || inboundSegment.distanceMeters <= 0) return pending();
      const walkingSegments = [outboundWalk, inboundWalk].map((result) => result.status === "fulfilled" && result.value.failures.length === 0 ? result.value.segments[0] : undefined);
      const walking = walkingSegments.every((segment) => segment?.mode === "walking" && Number.isFinite(segment.distanceMeters) && segment.distanceMeters > 0);
      const walkingDistanceMeters = walking ? walkingSegments[0]!.distanceMeters + walkingSegments[1]!.distanceMeters : undefined;
      return { date: day.date, firstPlace: first.name, lastPlace: last.name, outboundMinutes: outboundSegment.durationMinutes, returnMinutes: inboundSegment.durationMinutes, distanceMeters: outboundSegment.distanceMeters + inboundSegment.distanceMeters, walkingDistanceMeters, estimatedSteps: walkingDistanceMeters ? Math.round(walkingDistanceMeters / 0.76) : undefined, sourceCheckedAt: new Date().toISOString(), status: "confirmed" };
    } catch { return pending(); }
  }));
}
