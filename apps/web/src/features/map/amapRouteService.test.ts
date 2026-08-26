import { describe, expect, it, vi } from "vitest";
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

describe("createAmapRouteService", () => {
  it("uses provider-returned transit geometry instead of inventing a direct path", async () => {
    const search = vi.fn((_origin, _destination, callback) => callback("complete", {
      plans: [{
        distance: 1800,
        time: 900,
        segments: [{ walking: { path: [[114.1454, 22.2757], [114.149, 22.279], [114.1596, 22.2864]] } }],
      }],
    }));
    class Transfer {
      search = search;
    }
    const load = vi.fn(async () => ({ Transfer }));
    const service = createAmapRouteService(load, (id) => id === peak.id ? peak : centralPier);

    const [segment] = await service.getSegments({
      dayId: "hong-kong-day",
      placeIds: [peak.id, centralPier.id],
      modeByLeg: ["transit"],
    });

    expect(search).toHaveBeenCalledWith([114.1454, 22.2757], [114.1596, 22.2864], expect.any(Function));
    expect(segment).toMatchObject({ mode: "transit", distanceMeters: 1800, durationMinutes: 15 });
    expect(segment?.path).toEqual([
      { lng: 114.1454, lat: 22.2757, coordinateSystem: "GCJ02" },
      { lng: 114.149, lat: 22.279, coordinateSystem: "GCJ02" },
      { lng: 114.1596, lat: 22.2864, coordinateSystem: "GCJ02" },
    ]);
  });
});
