import type { RouteSegment, TimelinePlace } from "../map/types";

const gcj02 = (lng: number, lat: number) => ({ lng, lat, coordinateSystem: "GCJ02" as const });

export const itineraryPlaces: Record<string, TimelinePlace> = {
  peak: { id: "peak", name: "太平山顶", ...gcj02(114.1454, 22.2757) },
  "central-pier": { id: "central-pier", name: "中环码头", ...gcj02(114.1596, 22.2864) },
  "star-ferry": { id: "star-ferry", name: "天星码头", ...gcj02(114.1691, 22.2947) },
};

export const hongKongRouteSegments: RouteSegment[] = [
  {
    id: "peak-to-central-pier",
    fromPlaceId: "peak",
    toPlaceId: "central-pier",
    mode: "transit",
    distanceMeters: 3700,
    durationMinutes: 24,
    summary: "山顶缆车 + 步行",
    path: [gcj02(114.1454, 22.2757), gcj02(114.1438, 22.2774), gcj02(114.1479, 22.2808), gcj02(114.1518, 22.2825), gcj02(114.1552, 22.2846), gcj02(114.1596, 22.2864)],
  },
  {
    id: "central-pier-to-star-ferry",
    fromPlaceId: "central-pier",
    toPlaceId: "star-ferry",
    mode: "walking",
    distanceMeters: 1200,
    durationMinutes: 17,
    summary: "沿维港步行",
    path: [gcj02(114.1596, 22.2864), gcj02(114.1614, 22.2881), gcj02(114.1637, 22.2901), gcj02(114.1664, 22.2923), gcj02(114.1691, 22.2947)],
  },
];

export function getPlaces(itemIds: string[]) {
  return itemIds.map((id) => itineraryPlaces[id]).filter((place): place is TimelinePlace => Boolean(place));
}

export function getRouteSegments(dayId: string, placeIds: string[]) {
  if (dayId === "day-2026-10-05" || placeIds.includes("peak")) return hongKongRouteSegments;
  return [];
}
