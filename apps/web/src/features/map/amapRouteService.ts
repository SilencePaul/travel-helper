import type { Coordinate, RouteFailure, RouteSegment, RouteService, TimelinePlace, TravelMode } from "./types";

type AmapSearchService = { search: (origin: [number, number], destination: [number, number], callback: (status: string, result: unknown) => void) => void };
type AmapSearchConstructor = new (options?: { city: string }) => AmapSearchService;
type AmapRouteApi = { Walking?: AmapSearchConstructor; Transfer?: AmapSearchConstructor; Driving?: AmapSearchConstructor };
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

function numeric(value: unknown) {
  return typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
}

function coordinates(path: unknown) {
  if (typeof path === "string") {
    return path.split(";").map((point) => coordinate(point.split(",").map(Number))).filter((point): point is Coordinate => Boolean(point));
  }
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
  if (Array.isArray(plan.path)) return coordinates(plan.path);
  const segments = Array.isArray(plan.segments) ? plan.segments : [];
  return concatenate(segments.flatMap((segment) => {
    const value = record(segment);
    const walking = record(value?.walking);
    const transit = record(value?.transit);
    const bus = record(value?.bus);
    const railway = record(value?.railway);
    const taxi = record(value?.taxi);
    return [
      walking?.path,
      ...(Array.isArray(walking?.steps) ? walking.steps.map((step) => record(step)?.path ?? record(step)?.polyline) : []),
      transit?.path,
      ...(Array.isArray(bus?.buslines) ? bus.buslines.map((line) => record(line)?.path ?? record(line)?.polyline) : []),
      railway?.path,
      taxi?.path,
    ];
  }));
}

function firstRoute(result: unknown, mode: TravelMode) {
  const response = record(result);
  const transitRoute = record(response?.route);
  const candidates = mode === "transit" ? response?.plans ?? transitRoute?.transits : response?.routes;
  const first = Array.isArray(candidates) ? record(candidates[0]) : undefined;
  if (!first) return undefined;
  return {
    distanceMeters: numeric(first.distance),
    durationMinutes: Math.ceil(numeric(first.time ?? first.duration) / 60),
    path: mode === "transit" ? transitPlanPath(first) : routeStepsPath(first),
  };
}

function createSearchService(AMap: AmapRouteApi, mode: TravelMode, city: string) {
  const Constructor = mode === "walking" ? AMap.Walking : mode === "transit" ? AMap.Transfer : AMap.Driving;
  if (!Constructor) throw new Error(`AMAP_${mode.toUpperCase()}_PLUGIN_UNAVAILABLE`);
  if (mode !== "transit") return new Constructor();
  if (!city.trim()) throw new Error("AMAP_TRANSIT_CITY_REQUIRED");
  return new Constructor({ city });
}

async function getProviderSegment(AMap: AmapRouteApi, from: TimelinePlace, to: TimelinePlace, mode: TravelMode, city: string, legIndex: number, timeoutMs: number) {
  const result = await new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      action();
    };
    const timeout = window.setTimeout(() => settle(() => reject(new Error("AMAP_ROUTE_TIMEOUT"))), timeoutMs);
    createSearchService(AMap, mode, city).search([from.lng, from.lat], [to.lng, to.lat], (status, response) => {
      settle(() => status === "complete" ? resolve(response) : status === "no_data" && mode === "transit" ? reject(new Error("AMAP_ROUTE_NO_TRANSIT_PLAN")) : reject(new Error("AMAP_ROUTE_PROVIDER_UNAVAILABLE")));
    });
  });
  const route = firstRoute(result, mode);
  if (!route) throw new Error(mode === "transit" ? "AMAP_ROUTE_NO_TRANSIT_PLAN" : "AMAP_ROUTE_UNAVAILABLE");
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

async function getTransitSegmentWithRetry(AMap: AmapRouteApi, from: TimelinePlace, to: TimelinePlace, city: string, legIndex: number, timeoutMs: number) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return await getProviderSegment(AMap, from, to, "transit", city, legIndex, timeoutMs); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== "AMAP_ROUTE_PROVIDER_UNAVAILABLE" || attempt === 1) throw error;
      await new Promise((resolve) => window.setTimeout(resolve, 200));
    }
  }
  throw new Error("AMAP_ROUTE_PROVIDER_UNAVAILABLE");
}

export function createAmapRouteService(loadAmap: AmapLoader, resolvePlace: PlaceResolver, { timeoutMs = 10_000 }: { timeoutMs?: number } = {}): RouteService {
  return {
    async getSegments({ city, placeIds, modeByLeg }) {
      const places = placeIds.map(resolvePlace);
      if (places.some((place) => !place)) throw new Error("AMAP_PLACE_UNAVAILABLE");
      const AMap = await loadAmap();
      const resolvedPlaces = places as TimelinePlace[];
      const requests: PromiseSettledResult<RouteSegment>[] = [];
      for (const [index, from] of resolvedPlaces.slice(0, -1).entries()) {
        const mode = modeByLeg[index] ?? "walking";
        try {
          const segment = mode === "transit"
            ? await getTransitSegmentWithRetry(AMap, from, resolvedPlaces[index + 1]!, city, index, timeoutMs)
            : await getProviderSegment(AMap, from, resolvedPlaces[index + 1]!, mode, city, index, timeoutMs);
          requests.push({ status: "fulfilled", value: segment });
        } catch (error) {
          if (mode === "transit" && error instanceof Error && error.message === "AMAP_ROUTE_NO_TRANSIT_PLAN") {
            try { requests.push({ status: "fulfilled", value: await getProviderSegment(AMap, from, resolvedPlaces[index + 1]!, "walking", city, index, timeoutMs) }); }
            catch (walkingError) { requests.push({ status: "rejected", reason: walkingError }); }
          } else requests.push({ status: "rejected", reason: error });
        }
      }
      const segments: RouteSegment[] = [];
      const failures: RouteFailure[] = [];
      requests.forEach((request, index) => {
        if (request.status === "fulfilled") { segments.push(request.value); return; }
        const error = request.reason;
        const code = error instanceof Error && ["AMAP_ROUTE_PROVIDER_UNAVAILABLE", "AMAP_ROUTE_TIMEOUT", "AMAP_ROUTE_UNAVAILABLE", "AMAP_ROUTE_NO_TRANSIT_PLAN"].includes(error.message)
          ? error.message as RouteFailure["code"]
          : "AMAP_ROUTE_PROVIDER_UNAVAILABLE";
        failures.push({ fromPlaceId: resolvedPlaces[index]!.id, toPlaceId: resolvedPlaces[index + 1]!.id, mode: modeByLeg[index] ?? "walking", code });
      });
      return { segments, failures };
    },
  };
}
