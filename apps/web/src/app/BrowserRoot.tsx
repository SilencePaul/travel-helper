import type { TripRepository } from "@travel/contracts";
import { useEffect, useState } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import seed from "../../../../content/trip.seed.json";
import { TripApp } from "../App";
import { LocalTripRepository } from "../infrastructure/localTripRepository";
import { getCloudbaseAuth } from "../infrastructure/cloudbaseClient";
import type { RouteSegment, RouteService } from "../features/map/types";
import { LoginPage } from "../features/auth/LoginPage";
import { AuthCallbackPage } from "../features/auth/AuthCallbackPage";
import { BootstrapPage } from "../features/auth/BootstrapPage";
import { PendingApprovalPage } from "../features/auth/PendingApprovalPage";

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
        return { segments: [{ id: `${input.dayId}-${isPark ? "park" : "kowloon"}`, fromPlaceId: input.placeIds[0]!, toPlaceId: input.placeIds[1]!, mode: walking ? "walking" : "transit", distanceMeters: walking ? (isPark ? 760 : 380) : (isPark ? 2200 : 1300), durationMinutes: walking ? (isPark ? 10 : 5) : (isPark ? 22 : 13), summary: "测试高德酒店路线", path: [] }], failures: [] };
      }
      const fixtures = [
        {
          id: "test-peak-arabica",
          fromPlaceId: "peak",
          toPlaceId: "arabica-peak",
          mode: "transit",
          distanceMeters: 1800,
          durationMinutes: 15,
          summary: "测试提供方公共交通路线",
          path: [
            { lng: 114.1454, lat: 22.2757, coordinateSystem: "GCJ02" },
            { lng: 114.148, lat: 22.273, coordinateSystem: "GCJ02" },
            { lng: 114.150192, lat: 22.270851, coordinateSystem: "GCJ02" },
          ],
        },
        {
          id: "test-arabica-central",
          fromPlaceId: "arabica-peak",
          toPlaceId: "central-pier",
          mode: "transit",
          distanceMeters: 1800,
          durationMinutes: 15,
          summary: "测试提供方公共交通路线",
          path: [
            { lng: 114.150192, lat: 22.270851, coordinateSystem: "GCJ02" },
            { lng: 114.154678, lat: 22.268561, coordinateSystem: "GCJ02" },
            { lng: 114.166177, lat: 22.284364, coordinateSystem: "GCJ02" },
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
        {
          id: "test-peak-ferry",
          fromPlaceId: "peak",
          toPlaceId: "star-ferry",
          mode: "transit",
          distanceMeters: 4100,
          durationMinutes: 32,
          summary: "测试提供方公共交通路线",
          path: [
            { lng: 114.1454, lat: 22.2757, coordinateSystem: "GCJ02" },
            { lng: 114.154678, lat: 22.268561, coordinateSystem: "GCJ02" },
            { lng: 114.166177, lat: 22.284364, coordinateSystem: "GCJ02" },
            { lng: 114.173827, lat: 22.29081, coordinateSystem: "GCJ02" },
          ],
        },
      ] satisfies RouteSegment[];
      const segments = fixtures.filter((segment) => input.placeIds.some((id, index) => id === segment.fromPlaceId && input.placeIds[index + 1] === segment.toPlaceId));
      return { segments, failures: [] };
    },
  };
}

export function BrowserRoot() {
  if (!import.meta.env.DEV || import.meta.env.VITE_DATA_MODE === "cloudbase") {
    return <ProductionAuthGate />;
  }
  return <DevBrowserRoot />;
}

function DevBrowserRoot() {
  const [repository] = useState(createBrowserTestRepository);
  const [routeService] = useState(createBrowserTestRouteService);
  return <TripApp repository={repository} routeService={routeService} />;
}

export function ProductionAuthGate() {
  const [authenticated, setAuthenticated] = useState<boolean>();
  useEffect(() => {
    let active = true;
    void getCloudbaseAuth().getCurrentUser()
      .then((user) => { if (active) setAuthenticated(Boolean(user)); })
      .catch(() => { if (active) setAuthenticated(false); });
    return () => { active = false; };
  }, []);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/auth/callback" element={<AuthCallbackPage onAuthenticated={() => setAuthenticated(true)} />} />
        <Route path="/auth/bootstrap" element={<BootstrapPage onAuthenticated={() => setAuthenticated(true)} />} />
        <Route path="/auth/pending" element={<PendingApprovalPage onAuthenticated={() => setAuthenticated(true)} />} />
        <Route path="*" element={
          authenticated === undefined
            ? <p role="status">正在验证登录状态</p>
            : authenticated
              ? <TripApp />
              : <LoginPage />
        } />
      </Routes>
    </BrowserRouter>
  );
}
