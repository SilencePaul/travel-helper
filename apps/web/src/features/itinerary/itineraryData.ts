import poiCatalog from "../../../../../content/amap-pois.json";
import placeCatalog from "../../../../../content/places.json";
import { PlaceSchema, type Place } from "@travel/contracts";
import type { TimelinePlace, TravelMode } from "../map/types";

export function validatePoiCatalog(catalog: unknown): TimelinePlace[] {
  if (!Array.isArray(catalog)) throw new Error("AMAP_POI_CATALOG_INVALID");
  const ids = new Set<string>();
  const poiIds = new Set<string>();
  return catalog.map((raw) => {
    if (!raw || typeof raw !== "object") throw new Error("AMAP_POI_CATALOG_INVALID");
    const place = raw as Partial<TimelinePlace>;
    if (typeof place.id !== "string" || !place.id || ids.has(place.id) || typeof place.amapPoiId !== "string" || !place.amapPoiId || poiIds.has(place.amapPoiId) || typeof place.name !== "string" || !place.name || place.coordinateSystem !== "GCJ02" || !Number.isFinite(place.lng) || !Number.isFinite(place.lat) || place.lng! < -180 || place.lng! > 180 || place.lat! < -90 || place.lat! > 90) {
      throw new Error("AMAP_POI_CATALOG_INVALID");
    }
    ids.add(place.id);
    poiIds.add(place.amapPoiId);
    return place as TimelinePlace;
  });
}

export const itineraryPlaces: Record<string, TimelinePlace> = Object.fromEntries(
  validatePoiCatalog(poiCatalog).map((place) => [place.id, place]),
);

export function getPlaces(itemIds: string[]) {
  return itemIds.map((id) => itineraryPlaces[id]).filter((place): place is TimelinePlace => Boolean(place));
}

export function getPlace(placeId: string) {
  return itineraryPlaces[placeId];
}

export function validatePlaceCatalog(catalog: unknown): Place[] {
  const parsed = PlaceSchema.array().safeParse(catalog);
  if (!parsed.success) throw new Error("PLACE_CATALOG_INVALID");
  const ids = new Set<string>();
  parsed.data.forEach((place) => {
    if (ids.has(place.id)) throw new Error("PLACE_CATALOG_INVALID");
    ids.add(place.id);
  });
  return parsed.data;
}

export const placeDetails: Record<string, Place> = Object.fromEntries(
  validatePlaceCatalog(placeCatalog).map((place) => [place.id, place]),
);

export function getPlaceDetail(placeId: string) {
  return placeDetails[placeId];
}

export function getRouteModes(placeIds: string[]): TravelMode[] {
  return placeIds.slice(0, -1).map(() => "transit");
}
