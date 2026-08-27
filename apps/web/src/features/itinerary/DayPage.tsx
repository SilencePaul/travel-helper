import type { Trip } from "@travel/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AmapRouteMap, type AmapLoader } from "../map/AmapRouteMap";
import { createAmapRouteService } from "../map/amapRouteService";
import { normalizeRouteQueryResult } from "../map/routeResult";
import { loadAmap } from "../map/amapLoader";
import type { MapInteractionAdapter, RouteFailure, RouteService } from "../map/types";
import { getPlace, getPlaceDetail, getPlaces, getRouteModes } from "./itineraryData";
import { Timeline } from "./Timeline";
import { PlaceDrawer } from "../places/PlaceDrawer";
import { WeatherSummary } from "../weather/WeatherSummary";

type DayPageProps = {
  trip: Trip;
  dayId: string | undefined;
  onBack: () => void;
  mapAdapter?: MapInteractionAdapter;
  routeService?: RouteService;
  mapLoader?: AmapLoader;
};

const browserMapAdapter: MapInteractionAdapter = { focusPlace: () => undefined };

export function DayPage({ trip, dayId, onBack, mapAdapter = browserMapAdapter, routeService, mapLoader }: DayPageProps) {
  const dayIndex = trip.days.findIndex((day) => day.id === dayId);
  const day = trip.days[dayIndex];
  const [selectedPlaceId, setSelectedPlaceId] = useState<string>();
  const drawerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [drawerPlaceId, setDrawerPlaceId] = useState<string>();
  const places = useMemo(() => getPlaces(day?.itemIds ?? []), [day?.itemIds]);
  const defaultRouteService = useMemo(() => createAmapRouteService(loadAmap, getPlace), []);
  const activeRouteService = routeService ?? defaultRouteService;
  const routeKey = `${day?.id ?? ""}:${(day?.itemIds ?? []).join(",")}:${places.map((place) => place.id).join(",")}`;
  const unresolvedItemIds = (day?.itemIds ?? []).filter((itemId) => !getPlace(itemId));
  const [routeResult, setRouteResult] = useState<{
    key: string;
    segments: Awaited<ReturnType<RouteService["getSegments"]>>["segments"];
    failures: RouteFailure[];
  }>();
  const segments = routeResult?.key === routeKey ? routeResult.segments : [];
  const routeFailures = routeResult?.key === routeKey ? routeResult.failures : [];
  const drawerPlace = drawerPlaceId ? getPlaceDetail(drawerPlaceId) : undefined;
  const drawerRainAlternative = drawerPlace?.type === "attraction"
    ? getPlaceDetail(drawerPlace.rainAlternativeId)
    : undefined;
  const weatherDays = useMemo(() => day ? [day] : [], [day]);
  const selectPlace = useCallback((placeId: string, trigger?: HTMLButtonElement) => {
    setSelectedPlaceId(placeId);
    if (trigger && getPlaceDetail(placeId)) {
      drawerTriggerRef.current = trigger;
      setDrawerPlaceId(placeId);
    }
    mapAdapter.focusPlace(placeId);
    document.getElementById(`timeline-place-${placeId}`)?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }, [mapAdapter]);

  useEffect(() => {
    if (!day || places.length < 2 || unresolvedItemIds.length > 0) return;
    let active = true;
    void activeRouteService.getSegments({
      dayId: day.id,
      city: day.city,
      placeIds: places.map((place) => place.id),
      modeByLeg: getRouteModes(places.map((place) => place.id)),
    }).then((nextSegments) => {
      if (active) {
        const normalized = normalizeRouteQueryResult(nextSegments);
        setRouteResult({ key: routeKey, ...normalized });
      }
    }).catch(() => {
      if (active) {
        setRouteResult({ key: routeKey, segments: [], failures: [] });
      }
    });
    return () => { active = false; };
  }, [activeRouteService, day, places, routeKey, unresolvedItemIds.length]);

  if (!day) {
    return (
      <main className="day-page narrow-page">
        <p className="eyebrow">行程未找到</p>
        <h1>这一天不在当前旅行计划中</h1>
        <button type="button" onClick={onBack}>返回行程总览</button>
      </main>
    );
  }

  return (
    <main className="day-page narrow-page">
      <button type="button" className="back-button" onClick={onBack}>
        ← 返回行程总览
      </button>
      <header>
        <p className="eyebrow">D{dayIndex + 1} · {day.date}</p>
        <h1>{day.city || "待安排"}</h1>
        <WeatherSummary days={weatherDays} compact />
      </header>
      <AmapRouteMap
        places={places}
        segments={segments}
        selectedPlaceId={selectedPlaceId}
        onSelectPlace={selectPlace}
        mapLoader={mapLoader}
      />
      {unresolvedItemIds.length > 0 ? <p className="map-fallback" role="alert">有未识别地点，无法串联道路路线：{unresolvedItemIds.join("、")}</p> : null}
      {routeFailures.map((failure) => <p className="map-fallback" role="status" key={`${failure.fromPlaceId}-${failure.toPlaceId}`}>“{getPlace(failure.fromPlaceId)?.name ?? "起点"} → {getPlace(failure.toPlaceId)?.name ?? "终点"}”暂未取得高德道路路径（{routeFailureReason(failure.code)}），未绘制直线替代路线。</p>)}
      <section aria-labelledby="timeline-heading">
        <h2 id="timeline-heading">当天行程</h2>
        <Timeline
          places={places}
          segments={segments}
          selectedPlaceId={selectedPlaceId}
          onSelectPlace={selectPlace}
        />
      </section>
      {drawerPlace ? <PlaceDrawer
        place={drawerPlace}
        rainAlternative={drawerRainAlternative}
        triggerRef={drawerTriggerRef}
        onClose={() => setDrawerPlaceId(undefined)}
      /> : null}
    </main>
  );
}

function routeFailureReason(code: RouteFailure["code"]) {
  return {
    AMAP_ROUTE_PROVIDER_UNAVAILABLE: "高德服务暂不可用",
    AMAP_ROUTE_TIMEOUT: "高德路线请求超时",
    AMAP_ROUTE_UNAVAILABLE: "未找到可用路线",
    AMAP_ROUTE_NO_TRANSIT_PLAN: "未找到公共交通方案",
    AMAP_ROUTE_MALFORMED_RESPONSE: "高德返回的路线信息不完整",
  }[code];
}
