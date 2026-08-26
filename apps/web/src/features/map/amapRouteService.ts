import type { Coordinate, RouteSegment, RouteService, TimelinePlace, TravelMode } from "./types";

type AmapSearchService = { search: (origin: [number, number], destination: [number, number], callback: (status: string, result: unknown) => void) => void };
type AmapRouteApi = { Walking?: new () => AmapSearchService; Transfer?: new () => AmapSearchService; Driving?: new () => AmapSearchService };
type AmapLoader = () => Promise<AmapRouteApi>;
type PlaceResolver = (placeId: string) => TimelinePlace | undefined;
type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}

function coordinate(value: unknown): Coordinate | undefined {
  if (Array.isArray(value) && typeof value[0] === "number" && typeof value[1] === "number") return { lng: value[0], lat: value[1], coordinateSystem: "GCJ02" };
  const point = record(value);
  return typeof point?.lng === "number" && typeof point.lat === "number" ? { lng: point.lng, lat: point.lat, coordinateSystem: "GCJ02" } : undefined;
}

function coordinates(path: unknown) {
  return Array.isArray(path) ? path.map(coordinate).filter((point): point is Coordinate => Boolean(point)) : [];
}

function concatenate(paths: unknown[]) {
  const result: Coordinate[] = [];
  for (const path of paths) for (const point of coordinates(path)) {
    const previous = result.at(-1);
    if (!previous || previous.lng !== point.lng || previous.lat !== point.lat) result.push(point);
  }
  return result;
}

function routeStepsPath(route: RecordValue) {
  const steps = Array.isArray(route.steps) ? route.steps : [];
  return concatenate(steps.map((step) => record(step)?.path));
}

function transitPlanPath(plan: RecordValue) {
  const segments = Array.isArray(plan.segments) ? plan.segments : [];
  const paths: unknown[] = [];
  for (const rawSegment of segments) {
    const segment = record(rawSegment);
    const walking = record(segment?.walking);
    if (walking?.path) paths.push(walking.path);
    const bus = record(segment?.bus);
    const buslines = Array.isArray(bus?.buslines) ? bus.buslines : [];
    for (const line of buslines) {
      const path = record(line)?.path;
      if (path) paths.push(path);
    }
    const railway = record(segment?.railway);
    if (railway?.path) paths.push(railway.path);
    const taxi = record(segment?.taxi);
    if (taxi?.path) paths.push(taxi.path);
  }
  return concatenate(paths);
}

function firstRoute(result: unknown, mode: TravelMode) {
  const response = record(result);
  const candidates = mode === "transit" ? response?.plans : response?.routes;
  const first = Array.isArray(candidates) ? record(candidates[0]) : undefined;
  if (!first) return undefined;
  return {
    distanceMeters: typeof first.distance === "number" ? first.distance : 0,
    durationMinutes: Math.ceil((typeof first.time === "number" ? first.time : 0) / 60),
    path: mode === "transit" ? transitPlanPath(first) : routeStepsPath(first),
  };
}

function createSearchService(AMap: AmapRouteApi, mode: TravelMode) {
  const Constructor = mode === "walking" ? AMap.Walking : mode === "transit" ? AMap.Transfer : AMap.Driving;
  if (!Constructor) throw new Error(`AMAP_${mode.toUpperCase()}_PLUGIN_UNAVAILABLE`);
  return new Constructor();
}

async function getProviderSegment(AMap: AmapRouteApi, from: TimelinePlace, to: TimelinePlace, mode: TravelMode, legIndex: number, timeoutMs: number) {
  const result = await new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      action();
    };
    const timeout = window.setTimeout(() => settle(() => reject(new Error("AMAP_ROUTE_TIMEOUT"))), timeoutMs);
    createSearchService(AMap, mode).search([from.lng, from.lat], [to.lng, to.lat], (status, response) => {
      settle(() => status === "complete" ? resolve(response) : reject(new Error("AMAP_ROUTE_UNAVAILABLE")));
    });
  });
  const route = firstRoute(result, mode);
  if (!route) throw new Error("AMAP_ROUTE_UNAVAILABLE");
  return {
    id: `${from.id}-${to.id}-${legIndex}`,
    fromPlaceId: from.id,
    toPlaceId: to.id,
    mode,
    distanceMeters: route.distanceMeters,
    durationMinutes: route.durationMinutes,
    summary: mode === "walking" ? "高德步行路线" : mode === "transit" ? "高德公共交通路线" : "高德驾车路线",
    path: route.path,
  } satisfies RouteSegment;
}

export function createAmapRouteService(loadAmap: AmapLoader, resolvePlace: PlaceResolver, { timeoutMs = 10_000 }: { timeoutMs?: number } = {}): RouteService {
  return {
    async getSegments({ placeIds, modeByLeg }) {
      const places = placeIds.map(resolvePlace);
      if (places.some((place) => !place)) throw new Error("AMAP_PLACE_UNAVAILABLE");
      const AMap = await loadAmap();
      const resolvedPlaces = places as TimelinePlace[];
      return Promise.all(resolvedPlaces.slice(0, -1).map((from, index) => getProviderSegment(AMap, from, resolvedPlaces[index + 1]!, modeByLeg[index] ?? "walking", index, timeoutMs)));
    },
  };
}
