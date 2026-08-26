import type { TimelinePlace, TravelMode } from "../map/types";

const gcj02 = (lng: number, lat: number) => ({ lng, lat, coordinateSystem: "GCJ02" as const });

export const itineraryPlaces: Record<string, TimelinePlace> = {
  peak: { id: "peak", name: "太平山顶", amapPoiId: "B0FFK8TQAJ", ...gcj02(114.1454, 22.2757) },
  "central-pier": { id: "central-pier", name: "中环码头", amapPoiId: "B0FFHUB2G7", ...gcj02(114.1596, 22.2864) },
  "star-ferry": { id: "star-ferry", name: "天星码头", amapPoiId: "B0FFGXQCYP", ...gcj02(114.1691, 22.2947) },
};

export function getPlaces(itemIds: string[]) {
  return itemIds.map((id) => itineraryPlaces[id]).filter((place): place is TimelinePlace => Boolean(place));
}

export function getPlace(placeId: string) {
  return itineraryPlaces[placeId];
}

export function getRouteModes(placeIds: string[]): TravelMode[] {
  return placeIds.slice(0, -1).map(() => "transit");
}
