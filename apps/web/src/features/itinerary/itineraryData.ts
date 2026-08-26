import poiCatalog from "../../../../../content/amap-pois.json";
import type { TimelinePlace, TravelMode } from "../map/types";

export const itineraryPlaces: Record<string, TimelinePlace> = Object.fromEntries(
  (poiCatalog as TimelinePlace[]).map((place) => [place.id, place]),
);

export function getPlaces(itemIds: string[]) {
  return itemIds.map((id) => itineraryPlaces[id]).filter((place): place is TimelinePlace => Boolean(place));
}

export function getPlace(placeId: string) {
  return itineraryPlaces[placeId];
}

export function getRouteModes(placeIds: string[]): TravelMode[] {
  return placeIds.slice(0, -1).map(() => "transit");
}
