import type { TripRepository } from "@travel/contracts";
import { useState } from "react";
import seed from "../../../../content/trip.seed.json";
import App from "../App";
import { LocalTripRepository } from "../infrastructure/localTripRepository";
import type { RouteService } from "../features/map/types";

function createBrowserTestRepository(): TripRepository | undefined {
  if (!import.meta.env.DEV) return undefined;
  const params = new URLSearchParams(window.location.search);
  const delayMs = Number(params.get("__testSaveDelayMs"));
  const hotelRouteFixture = params.get("__testRouteMap") === "1";
  if ((!Number.isFinite(delayMs) || delayMs <= 0) && !hotelRouteFixture) return undefined;

  const fixture = hotelRouteFixture ? {
    ...seed,
    days: seed.days.map((day) => day.city === "香港" ? { ...day, itemIds: ["peak", "star-ferry"] } : day),
  } : seed;
  const localRepository = new LocalTripRepository(fixture);
  return {
    load: (tripId) => localRepository.load(tripId),
    subscribe: (tripId, onChange) => localRepository.subscribe(tripId, onChange),
    save: async (trip, expectedVersion) => {
      if (Number.isFinite(delayMs) && delayMs > 0) await new Promise((resolve) => window.setTimeout(resolve, delayMs));
      return localRepository.save(trip, expectedVersion);
    },
  };
}

function createBrowserTestRouteService(): RouteService | undefined {
  if (!import.meta.env.DEV || new URLSearchParams(window.location.search).get("__testRouteMap") !== "1") return undefined;
  return {
    async getSegments(input) {
      if (input.dayId.includes(":hotel")) {
        const isPark = input.placeIds.includes("park-hotel-hong-kong");
        const walking = input.modeByLeg[0] === "walking";
        return [{ id: `${input.dayId}-${isPark ? "park" : "kowloon"}`, fromPlaceId: input.placeIds[0]!, toPlaceId: input.placeIds[1]!, mode: walking ? "walking" : "transit", distanceMeters: walking ? (isPark ? 760 : 380) : (isPark ? 2200 : 1300), durationMinutes: walking ? (isPark ? 10 : 5) : (isPark ? 22 : 13), summary: "测试高德酒店路线", path: [] }];
      }
      return [
        {
          id: "test-peak-central",
          fromPlaceId: "peak",
          toPlaceId: "central-pier",
          mode: "transit",
          distanceMeters: 1800,
          durationMinutes: 15,
          summary: "测试提供方公共交通路线",
          path: [
            { lng: 114.1454, lat: 22.2757, coordinateSystem: "GCJ02" },
            { lng: 114.149, lat: 22.279, coordinateSystem: "GCJ02" },
            { lng: 114.1596, lat: 22.2864, coordinateSystem: "GCJ02" },
          ],
        },
        {
          id: "test-central-ferry",
          fromPlaceId: "central-pier",
          toPlaceId: "star-ferry",
          mode: "transit",
          distanceMeters: 1300,
          durationMinutes: 12,
          summary: "测试提供方公共交通路线",
          path: [
            { lng: 114.1596, lat: 22.2864, coordinateSystem: "GCJ02" },
            { lng: 114.1637, lat: 22.2901, coordinateSystem: "GCJ02" },
            { lng: 114.1691, lat: 22.2947, coordinateSystem: "GCJ02" },
          ],
        },
      ];
    },
  };
}

export function BrowserRoot() {
  const [repository] = useState(createBrowserTestRepository);
  const [routeService] = useState(createBrowserTestRouteService);
  return <App repository={repository} routeService={routeService} />;
}
