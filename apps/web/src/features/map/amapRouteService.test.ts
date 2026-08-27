import { afterEach, describe, expect, it, vi } from "vitest";
import { createAmapRouteService } from "./amapRouteService";
import type { TimelinePlace } from "./types";

const peak: TimelinePlace = {
  id: "peak",
  name: "太平山顶",
  amapPoiId: "B0FFK8TQAJ",
  lng: 114.1454,
  lat: 22.2757,
  coordinateSystem: "GCJ02",
};

const centralPier: TimelinePlace = {
  id: "central-pier",
  name: "中环码头",
  amapPoiId: "B0FFHUB2G7",
  lng: 114.1596,
  lat: 22.2864,
  coordinateSystem: "GCJ02",
};

afterEach(() => vi.useRealTimers());

describe("createAmapRouteService", () => {
  it("uses provider-returned transit geometry instead of inventing a direct path", async () => {
    const search = vi.fn((_origin, _destination, callback) => callback("complete", {
      plans: [{
        distance: 1800,
        time: 900,
        path: [[114.1454, 22.2757], [114.149, 22.279], [114.1596, 22.2864]],
      }],
    }));
    const transferOptions: unknown[] = [];
    class Transfer {
      constructor(options: unknown) { transferOptions.push(options); }
      search = search;
    }
    const load = vi.fn(async () => ({ Transfer }));
    const service = createAmapRouteService(load, (id) => id === peak.id ? peak : centralPier);

    const { segments: [segment] } = await service.getSegments({
      dayId: "hong-kong-day",
      city: "香港",
      placeIds: [peak.id, centralPier.id],
      modeByLeg: ["transit"],
    });

    expect(transferOptions).toEqual([{ city: "香港" }]);
    expect(search).toHaveBeenCalledWith([114.1454, 22.2757], [114.1596, 22.2864], expect.any(Function));
    expect(segment).toMatchObject({ mode: "transit", distanceMeters: 1800, durationMinutes: 15 });
    expect(segment?.path).toEqual([
      { lng: 114.1454, lat: 22.2757, coordinateSystem: "GCJ02" },
      { lng: 114.149, lat: 22.279, coordinateSystem: "GCJ02" },
      { lng: 114.1596, lat: 22.2864, coordinateSystem: "GCJ02" },
    ]);
  });

  it("uses ordered walking steps instead of recursively duplicating aggregate and nested paths", async () => {
    const search = vi.fn((_origin, _destination, callback) => callback("complete", {
      routes: [{
        distance: 900,
        time: 600,
        path: [[0, 0], [9, 9]],
        steps: [
          { path: [[114.1454, 22.2757], [114.15, 22.28]] },
          { path: [[114.15, 22.28], [114.1596, 22.2864]] },
        ],
      }],
    }));
    class Walking { search = search; }
    const service = createAmapRouteService(async () => ({ Walking }), (id) => id === peak.id ? peak : centralPier);

    const { segments: [segment] } = await service.getSegments({
      dayId: "hong-kong-day",
      city: "香港",
      placeIds: [peak.id, centralPier.id],
      modeByLeg: ["walking"],
    });

    expect(segment?.path).toEqual([
      { lng: 114.1454, lat: 22.2757, coordinateSystem: "GCJ02" },
      { lng: 114.15, lat: 22.28, coordinateSystem: "GCJ02" },
      { lng: 114.1596, lat: 22.2864, coordinateSystem: "GCJ02" },
    ]);
  });

  it("parses the raw transit response returned by the AMap route provider", async () => {
    const search = vi.fn((_origin, _destination, callback) => callback("complete", {
      route: {
        transits: [{
          distance: "1800",
          duration: "900",
          segments: [{
            walking: {
              steps: [{ polyline: "114.1454,22.2757;114.149,22.279;114.1596,22.2864" }],
            },
          }],
        }],
      },
    }));
    class Transfer { constructor(_options?: unknown) {} search = search; }
    const service = createAmapRouteService(async () => ({ Transfer }), (id) => id === peak.id ? peak : centralPier);

    const { segments: [segment] } = await service.getSegments({
      dayId: "hong-kong-day",
      city: "香港",
      placeIds: [peak.id, centralPier.id],
      modeByLeg: ["transit"],
    });

    expect(segment).toMatchObject({ mode: "transit", distanceMeters: 1800, durationMinutes: 15 });
    expect(segment?.path).toHaveLength(3);
  });

  it("uses a provider walking route when AMap reports no_data for a same-city transit search", async () => {
    const transitSearch = vi.fn((_origin, _destination, callback) => callback("no_data", { route: { transits: [] } }));
    const walkingSearch = vi.fn((_origin, _destination, callback) => callback("complete", {
      routes: [{ distance: 716, time: 600, steps: [{ path: [[114.1454, 22.2757], [114.1596, 22.2864]] }] }],
    }));
    class Transfer { constructor(_options?: unknown) {} search = transitSearch; }
    class Walking { constructor(_options?: unknown) {} search = walkingSearch; }
    const service = createAmapRouteService(async () => ({ Transfer, Walking }), (id) => id === peak.id ? peak : centralPier);

    const { segments: [segment] } = await service.getSegments({
      dayId: "hong-kong-day",
      city: "香港",
      placeIds: [peak.id, centralPier.id],
      modeByLeg: ["transit"],
    });

    expect(transitSearch).toHaveBeenCalledOnce();
    expect(walkingSearch).toHaveBeenCalledOnce();
    expect(segment).toMatchObject({ mode: "walking", summary: "高德步行路线", distanceMeters: 716 });
  });

  it("does not disguise a failed transit request as a walking route", async () => {
    const transitSearch = vi.fn((_origin, _destination, callback) => callback("error", { info: "provider unavailable" }));
    const walkingSearch = vi.fn((_origin, _destination, callback) => callback("complete", {
      routes: [{ distance: 716, time: 600, steps: [{ path: [[114.1454, 22.2757], [114.1596, 22.2864]] }] }],
    }));
    class Transfer { constructor(_options?: unknown) {} search = transitSearch; }
    class Walking { constructor(_options?: unknown) {} search = walkingSearch; }
    const service = createAmapRouteService(async () => ({ Transfer, Walking }), (id) => id === peak.id ? peak : centralPier);

    const result = await service.getSegments({
      dayId: "hong-kong-day",
      city: "香港",
      placeIds: [peak.id, centralPier.id],
      modeByLeg: ["transit"],
    });

    expect(result.failures).toEqual([expect.objectContaining({ code: "AMAP_ROUTE_PROVIDER_UNAVAILABLE" })]);
    expect(walkingSearch).not.toHaveBeenCalled();
  });

  it("does not turn a complete malformed transit response into walking", async () => {
    const transitSearch = vi.fn((_origin, _destination, callback) => callback("complete", { route: { transits: [] } }));
    const walkingSearch = vi.fn();
    class Transfer { constructor(_options?: unknown) {} search = transitSearch; }
    class Walking { constructor(_options?: unknown) {} search = walkingSearch; }
    const service = createAmapRouteService(async () => ({ Transfer, Walking }), (id) => id === peak.id ? peak : centralPier);
    const result = await service.getSegments({ dayId: "hong-kong-day", city: "香港", placeIds: [peak.id, centralPier.id], modeByLeg: ["transit"] });
    expect(result.failures).toEqual([expect.objectContaining({ code: "AMAP_ROUTE_MALFORMED_RESPONSE" })]);
    expect(walkingSearch).not.toHaveBeenCalled();
  });

  it("preserves successful connectors when another connector fails", async () => {
    const ferry = { ...centralPier, id: "ferry", lng: 114.17, lat: 22.29 };
    const search = vi.fn((origin, _destination, callback) => callback(origin[0] === peak.lng ? "complete" : "error", origin[0] === peak.lng
      ? { plans: [{ distance: 1800, time: 900, path: [[peak.lng, peak.lat], [centralPier.lng, centralPier.lat]] }] }
      : { info: "provider unavailable" }));
    class Transfer { constructor(_options?: unknown) {} search = search; }
    const service = createAmapRouteService(async () => ({ Transfer }), (id) => id === peak.id ? peak : id === centralPier.id ? centralPier : ferry);

    const result = await service.getSegments({ dayId: "hong-kong-day", city: "香港", placeIds: [peak.id, centralPier.id, ferry.id], modeByLeg: ["transit", "transit"] });

    expect(result.segments).toEqual([expect.objectContaining({ fromPlaceId: "peak", toPlaceId: "central-pier" })]);
    expect(result.failures).toEqual([expect.objectContaining({ fromPlaceId: "central-pier", toPlaceId: "ferry", code: "AMAP_ROUTE_PROVIDER_UNAVAILABLE" })]);
  });

  it("retries one transient provider error before reporting the transit segment", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const search = vi.fn((_origin, _destination, callback) => {
      calls += 1;
      callback(calls === 1 ? "error" : "complete", calls === 1 ? {} : { plans: [{ distance: 1800, time: 900, path: [[peak.lng, peak.lat], [centralPier.lng, centralPier.lat]] }] });
    });
    class Transfer { constructor(_options?: unknown) {} search = search; }
    const service = createAmapRouteService(async () => ({ Transfer }), (id) => id === peak.id ? peak : centralPier);
    const pending = service.getSegments({ dayId: "hong-kong-day", city: "香港", placeIds: [peak.id, centralPier.id], modeByLeg: ["transit"] });
    await vi.advanceTimersByTimeAsync(200);
    await expect(pending).resolves.toEqual(expect.objectContaining({ segments: [expect.objectContaining({ mode: "transit" })], failures: [] }));
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("starts the next day connector only after the previous provider callback settles", async () => {
    const ferry = { ...centralPier, id: "ferry", lng: 114.17, lat: 22.29 };
    const callbacks: Array<(status: string, result: unknown) => void> = [];
    const search = vi.fn((_origin, _destination, callback) => callbacks.push(callback));
    class Transfer { constructor(_options?: unknown) {} search = search; }
    const service = createAmapRouteService(async () => ({ Transfer }), (id) => id === peak.id ? peak : id === centralPier.id ? centralPier : ferry);
    const pending = service.getSegments({ dayId: "hong-kong-day", city: "香港", placeIds: [peak.id, centralPier.id, ferry.id], modeByLeg: ["transit", "transit"] });
    await Promise.resolve();
    expect(search).toHaveBeenCalledTimes(1);
    callbacks[0]!("complete", { plans: [{ distance: 1800, time: 900, path: [[peak.lng, peak.lat], [centralPier.lng, centralPier.lat]] }] });
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(search).toHaveBeenCalledTimes(2);
    callbacks[1]!("complete", { plans: [{ distance: 1300, time: 720, path: [[centralPier.lng, centralPier.lat], [ferry.lng, ferry.lat]] }] });
    await expect(pending).resolves.toEqual(expect.objectContaining({ failures: [], segments: expect.any(Array) }));
  });

  it("serializes overlapping callers so provider searches never overlap or mix results", async () => {
    const callbacks: Array<(status: string, result: unknown) => void> = [];
    let activeSearches = 0;
    let highestConcurrency = 0;
    const search = vi.fn((_origin, _destination, callback) => {
      activeSearches += 1;
      highestConcurrency = Math.max(highestConcurrency, activeSearches);
      callbacks.push((status, response) => {
        activeSearches -= 1;
        callback(status, response);
      });
    });
    class Walking { constructor(_options?: unknown) {} search = search; }
    const service = createAmapRouteService(async () => ({ Walking }), (id) => id === peak.id ? peak : centralPier);

    const first = service.getSegments({ dayId: "first", city: "香港", placeIds: [peak.id, centralPier.id], modeByLeg: ["walking"] });
    const second = service.getSegments({ dayId: "second", city: "香港", placeIds: [centralPier.id, peak.id], modeByLeg: ["walking"] });
    await Promise.resolve();
    expect(search).toHaveBeenCalledTimes(1);
    expect(highestConcurrency).toBe(1);

    callbacks[0]!("complete", { routes: [{ distance: 716, time: 600, steps: [{ path: [[peak.lng, peak.lat], [centralPier.lng, centralPier.lat]] }] }] });
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(search).toHaveBeenCalledTimes(2);
    expect(highestConcurrency).toBe(1);
    callbacks[1]!("complete", { routes: [{ distance: 712, time: 540, steps: [{ path: [[centralPier.lng, centralPier.lat], [peak.lng, peak.lat]] }] }] });

    await expect(first).resolves.toEqual(expect.objectContaining({ segments: [expect.objectContaining({ fromPlaceId: peak.id, toPlaceId: centralPier.id, distanceMeters: 716 })], failures: [] }));
    await expect(second).resolves.toEqual(expect.objectContaining({ segments: [expect.objectContaining({ fromPlaceId: centralPier.id, toPlaceId: peak.id, distanceMeters: 712 })], failures: [] }));
  });

  it("serializes provider calls across route service instances without mixing their results", async () => {
    const callbacks: Array<(status: string, result: unknown) => void> = [];
    let activeSearches = 0;
    let highestConcurrency = 0;
    const search = vi.fn((_origin, _destination, callback) => {
      activeSearches += 1;
      highestConcurrency = Math.max(highestConcurrency, activeSearches);
      callbacks.push((status, response) => {
        activeSearches -= 1;
        callback(status, response);
      });
    });
    class Walking { constructor(_options?: unknown) {} search = search; }
    const resolve = (id: string) => id === peak.id ? peak : centralPier;
    const firstService = createAmapRouteService(async () => ({ Walking }), resolve);
    const secondService = createAmapRouteService(async () => ({ Walking }), resolve);

    const first = firstService.getSegments({ dayId: "first", city: "香港", placeIds: [peak.id, centralPier.id], modeByLeg: ["walking"] });
    const second = secondService.getSegments({ dayId: "second", city: "香港", placeIds: [centralPier.id, peak.id], modeByLeg: ["walking"] });
    await Promise.resolve();
    expect(search).toHaveBeenCalledTimes(1);
    expect(highestConcurrency).toBe(1);
    callbacks[0]!("complete", { routes: [{ distance: 716, time: 600, steps: [{ path: [[peak.lng, peak.lat], [centralPier.lng, centralPier.lat]] }] }] });
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(search).toHaveBeenCalledTimes(2);
    callbacks[1]!("complete", { routes: [{ distance: 712, time: 540, steps: [{ path: [[centralPier.lng, centralPier.lat], [peak.lng, peak.lat]] }] }] });

    await expect(first).resolves.toEqual(expect.objectContaining({ segments: [expect.objectContaining({ distanceMeters: 716 })] }));
    await expect(second).resolves.toEqual(expect.objectContaining({ segments: [expect.objectContaining({ distanceMeters: 712 })] }));
    expect(highestConcurrency).toBe(1);
  });

  it("shares one in-flight provider request across services for the same route query", async () => {
    const callbacks: Array<(status: string, result: unknown) => void> = [];
    const search = vi.fn((_origin, _destination, callback) => callbacks.push(callback));
    class Walking { constructor(_options?: unknown) {} search = search; }
    const resolve = (id: string) => id === peak.id ? peak : centralPier;
    const firstService = createAmapRouteService(async () => ({ Walking }), resolve);
    const secondService = createAmapRouteService(async () => ({ Walking }), resolve);
    const input = { dayId: "same-route", city: "香港", placeIds: [peak.id, centralPier.id], modeByLeg: ["walking" as const] };

    const first = firstService.getSegments(input);
    const second = secondService.getSegments(input);
    await Promise.resolve();
    const response = { routes: [{ distance: 716, time: 600, steps: [{ path: [[peak.lng, peak.lat], [centralPier.lng, centralPier.lat]] }] }] };
    callbacks[0]!("complete", response);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    callbacks[1]?.("complete", response);

    await expect(first).resolves.toEqual(expect.objectContaining({ segments: [expect.objectContaining({ distanceMeters: 716 })], failures: [] }));
    await expect(second).resolves.toEqual(expect.objectContaining({ segments: [expect.objectContaining({ distanceMeters: 716 })], failures: [] }));
    expect(first).toBe(second);
    expect(search).toHaveBeenCalledOnce();
  });

  it("clears a failed in-flight route query so the same request can retry", async () => {
    let calls = 0;
    const search = vi.fn((_origin, _destination, callback) => {
      calls += 1;
      callback(calls === 1 ? "error" : "complete", calls === 1 ? {} : { routes: [{ distance: 716, time: 600, steps: [{ path: [[peak.lng, peak.lat], [centralPier.lng, centralPier.lat]] }] }] });
    });
    class Walking { constructor(_options?: unknown) {} search = search; }
    const service = createAmapRouteService(async () => ({ Walking }), (id) => id === peak.id ? peak : centralPier);
    const input = { dayId: "retry-route", city: "香港", placeIds: [peak.id, centralPier.id], modeByLeg: ["walking" as const] };

    await expect(service.getSegments(input)).resolves.toEqual(expect.objectContaining({ segments: [], failures: [expect.anything()] }));
    await expect(service.getSegments(input)).resolves.toEqual(expect.objectContaining({ segments: [expect.objectContaining({ distanceMeters: 716 })], failures: [] }));
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("keeps a provider-confirmed same-origin route with zero metrics when it has valid geometry", async () => {
    const search = vi.fn((_origin, _destination, callback) => callback("complete", {
      routes: [{ distance: 0, time: 0, steps: [{ path: [[peak.lng, peak.lat], [peak.lng + 0.00001, peak.lat + 0.00001]] }] }],
    }));
    class Walking { constructor(_options?: unknown) {} search = search; }
    const service = createAmapRouteService(async () => ({ Walking }), (id) => id === peak.id ? peak : centralPier);

    await expect(service.getSegments({ dayId: "same-origin", city: "香港", placeIds: [peak.id, peak.id], modeByLeg: ["walking"] }))
      .resolves.toEqual(expect.objectContaining({ segments: [expect.objectContaining({ distanceMeters: 0, durationMinutes: 0 })], failures: [] }));
  });

  it.each(["timeout", "provider rejection", "synchronous throw"] as const)("releases the shared provider queue after a first task %s", async (failure) => {
    if (failure === "timeout") vi.useFakeTimers();
    let calls = 0;
    const search = vi.fn((_origin, _destination, callback) => {
      calls += 1;
      if (calls === 1) {
        if (failure === "timeout") return;
        if (failure === "provider rejection") return callback("error", {});
        throw new Error("provider constructor search failure");
      }
      callback("complete", { routes: [{ distance: 716, time: 600, steps: [{ path: [[centralPier.lng, centralPier.lat], [peak.lng, peak.lat]] }] }] });
    });
    class Walking { constructor(_options?: unknown) {} search = search; }
    const resolve = (id: string) => id === peak.id ? peak : centralPier;
    const firstService = createAmapRouteService(async () => ({ Walking }), resolve, { timeoutMs: 10 });
    const secondService = createAmapRouteService(async () => ({ Walking }), resolve);

    const first = firstService.getSegments({ dayId: "failed-first", city: "香港", placeIds: [peak.id, centralPier.id], modeByLeg: ["walking"] });
    const second = secondService.getSegments({ dayId: "queued-second", city: "香港", placeIds: [centralPier.id, peak.id], modeByLeg: ["walking"] });
    if (failure === "timeout") await vi.advanceTimersByTimeAsync(10);

    await expect(first).resolves.toEqual(expect.objectContaining({ segments: [], failures: [expect.anything()] }));
    await expect(second).resolves.toEqual(expect.objectContaining({ segments: [expect.objectContaining({ fromPlaceId: centralPier.id, toPlaceId: peak.id })], failures: [] }));
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("runs a queued second factory after the first factory loader rejects", async () => {
    const search = vi.fn((_origin, _destination, callback) => callback("complete", {
      routes: [{ distance: 716, time: 600, steps: [{ path: [[centralPier.lng, centralPier.lat], [peak.lng, peak.lat]] }] }],
    }));
    class Walking { constructor(_options?: unknown) {} search = search; }
    const resolve = (id: string) => id === peak.id ? peak : centralPier;
    const failingService = createAmapRouteService(async () => { throw new Error("AMAP_LOADER_REJECTED"); }, resolve);
    const queuedService = createAmapRouteService(async () => ({ Walking }), resolve);

    const failed = failingService.getSegments({ dayId: "loader-failure", city: "香港", placeIds: [peak.id, centralPier.id], modeByLeg: ["walking"] });
    const queued = queuedService.getSegments({ dayId: "after-loader-failure", city: "香港", placeIds: [centralPier.id, peak.id], modeByLeg: ["walking"] });

    await expect(failed).rejects.toThrow("AMAP_LOADER_REJECTED");
    await expect(queued).resolves.toEqual(expect.objectContaining({ segments: [expect.objectContaining({ fromPlaceId: centralPier.id, toPlaceId: peak.id })], failures: [] }));
    expect(search).toHaveBeenCalledOnce();
  });

  it.each([
    ["empty plan", {}],
    ["non-numeric distance", { distance: "not-a-number", time: 600, steps: [{ path: [[peak.lng, peak.lat], [centralPier.lng, centralPier.lat]] }] }],
    ["negative distance", { distance: -1, time: 600, steps: [{ path: [[peak.lng, peak.lat], [centralPier.lng, centralPier.lat]] }] }],
    ["negative duration", { distance: 716, time: -1, steps: [{ path: [[peak.lng, peak.lat], [centralPier.lng, centralPier.lat]] }] }],
    ["empty route path", { distance: 716, time: 600, steps: [] }],
    ["non-finite path coordinate", { distance: 716, time: 600, steps: [{ path: [[peak.lng, peak.lat], [Number.NaN, centralPier.lat]] }] }],
    ["out-of-range path coordinate", { distance: 716, time: 600, steps: [{ path: [[peak.lng, peak.lat], [181, centralPier.lat]] }] }],
  ])("reports a malformed route response for %s", async (_label, route) => {
    const search = vi.fn((_origin, _destination, callback) => callback("complete", { routes: [route] }));
    class Walking { constructor(_options?: unknown) {} search = search; }
    const service = createAmapRouteService(async () => ({ Walking }), (id) => id === peak.id ? peak : centralPier);

    await expect(service.getSegments({ dayId: "hong-kong-day", city: "香港", placeIds: [peak.id, centralPier.id], modeByLeg: ["walking"] }))
      .resolves.toEqual(expect.objectContaining({ segments: [], failures: [expect.objectContaining({ code: "AMAP_ROUTE_MALFORMED_RESPONSE" })] }));
  });

  it("times out a route request and ignores a late plugin callback", async () => {
    vi.useFakeTimers();
    let callback: ((status: string, result: unknown) => void) | undefined;
    class Walking {
      search(_origin: [number, number], _destination: [number, number], next: (status: string, result: unknown) => void) {
        callback = next;
      }
    }
    const service = createAmapRouteService(async () => ({ Walking }), (id) => id === peak.id ? peak : centralPier, { timeoutMs: 10 });
    const pending = service.getSegments({ dayId: "hong-kong-day", city: "香港", placeIds: [peak.id, centralPier.id], modeByLeg: ["walking"] });
    await vi.advanceTimersByTimeAsync(10);
    await expect(pending).resolves.toEqual(expect.objectContaining({ failures: [expect.objectContaining({ code: "AMAP_ROUTE_TIMEOUT" })] }));
    callback?.("complete", { routes: [{ distance: 1, time: 1, steps: [] }] });
  });
});
