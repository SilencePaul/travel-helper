import type { Coordinate, RouteSegment, RouteService, TimelinePlace, TravelMode } from "./types";

type AmapSearchService = {
  search: (
    origin: [number, number],
    destination: [number, number],
    callback: (status: string, result: unknown) => void,
  ) => void;
};

type AmapRouteApi = {
  Walking?: new () => AmapSearchService;
  Transfer?: new () => AmapSearchService;
  Driving?: new () => AmapSearchService;
};

type AmapLoader = () => Promise<AmapRouteApi>;
type PlaceResolver = (placeId: string) => TimelinePlace | undefined;

function coordinateFrom(value: unknown): Coordinate | undefined {
  if (Array.isArray(value) && typeof value[0] === "number" && typeof value[1] === "number") {
    return { lng: value[0], lat: value[1], coordinateSystem: "GCJ02" };
  }
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { lng?: unknown; lat?: unknown; getLng?: () => number; getLat?: () => number };
  const lng = typeof candidate.lng === "number" ? candidate.lng : candidate.getLng?.();
  const lat = typeof candidate.lat === "number" ? candidate.lat : candidate.getLat?.();
  return typeof lng === "number" && typeof lat === "number"
    ? { lng, lat, coordinateSystem: "GCJ02" }
    : undefined;
}

function providerPath(value: unknown) {
  const path: Coordinate[] = [];
  const seen = new Set<object>();

  function collect(candidate: unknown) {
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) collect(item);
      return;
    }
    for (const [key, nested] of Object.entries(candidate)) {
      if (key === "path" && Array.isArray(nested)) {
        for (const point of nested) {
          const coordinate = coordinateFrom(point);
          if (coordinate && (path.length === 0 || path.at(-1)?.lng !== coordinate.lng || path.at(-1)?.lat !== coordinate.lat)) path.push(coordinate);
        }
      } else {
        collect(nested);
      }
    }
  }

  collect(value);
  return path;
}

function firstRoute(result: unknown): { distance?: unknown; time?: unknown } | undefined {
  if (!result || typeof result !== "object") return undefined;
  const value = result as { routes?: unknown; plans?: unknown };
  const routes = Array.isArray(value.routes) ? value.routes : Array.isArray(value.plans) ? value.plans : [];
  const route = routes[0];
  return route && typeof route === "object" ? route as { distance?: unknown; time?: unknown } : undefined;
}

function asFiniteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function createSearchService(AMap: AmapRouteApi, mode: TravelMode) {
  const Constructor = mode === "walking" ? AMap.Walking : mode === "transit" ? AMap.Transfer : AMap.Driving;
  if (!Constructor) throw new Error(`AMAP_${mode.toUpperCase()}_PLUGIN_UNAVAILABLE`);
  return new Constructor();
}

async function getProviderSegment(
  AMap: AmapRouteApi,
  from: TimelinePlace,
  to: TimelinePlace,
  mode: TravelMode,
  legIndex: number,
) {
  const result = await new Promise<unknown>((resolve, reject) => {
    createSearchService(AMap, mode).search([from.lng, from.lat], [to.lng, to.lat], (status, response) => {
      if (status !== "complete") {
        reject(new Error("AMAP_ROUTE_UNAVAILABLE"));
        return;
      }
      resolve(response);
    });
  });
  const route = firstRoute(result);
  if (!route) throw new Error("AMAP_ROUTE_UNAVAILABLE");

  return {
    id: `${from.id}-${to.id}-${legIndex}`,
    fromPlaceId: from.id,
    toPlaceId: to.id,
    mode,
    distanceMeters: asFiniteNumber(route.distance),
    durationMinutes: Math.ceil(asFiniteNumber(route.time) / 60),
    summary: mode === "walking" ? "高德步行路线" : mode === "transit" ? "高德公共交通路线" : "高德驾车路线",
    path: providerPath(route),
  } satisfies RouteSegment;
}

export function createAmapRouteService(loadAmap: AmapLoader, resolvePlace: PlaceResolver): RouteService {
  return {
    async getSegments({ placeIds, modeByLeg }) {
      const AMap = await loadAmap();
      const places = placeIds.map(resolvePlace);
      if (places.some((place) => !place)) throw new Error("AMAP_PLACE_UNAVAILABLE");
      const resolvedPlaces = places as TimelinePlace[];
      return Promise.all(resolvedPlaces.slice(0, -1).map((from, index) => {
        const to = resolvedPlaces[index + 1]!;
        return getProviderSegment(AMap, from, to, modeByLeg[index] ?? "walking", index);
      }));
    },
  };
}
