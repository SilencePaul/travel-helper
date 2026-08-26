import type { Trip } from "@travel/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AmapRouteMap, type AmapLoader } from "../map/AmapRouteMap";
import { createAmapRouteService } from "../map/amapRouteService";
import { loadAmap } from "../map/amapLoader";
import type { MapInteractionAdapter, RouteService } from "../map/types";
import { getPlace, getPlaces, getRouteModes } from "./itineraryData";
import { Timeline } from "./Timeline";

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
  const places = useMemo(() => getPlaces(day?.itemIds ?? []), [day?.itemIds]);
  const defaultRouteService = useMemo(() => createAmapRouteService(loadAmap, getPlace), []);
  const activeRouteService = routeService ?? defaultRouteService;
  const routeKey = `${day?.id ?? ""}:${places.map((place) => place.id).join(",")}`;
  const unresolvedItemIds = (day?.itemIds ?? []).filter((itemId) => !getPlace(itemId));
  const [routeResult, setRouteResult] = useState<{
    key: string;
    segments: Awaited<ReturnType<RouteService["getSegments"]>>;
    error?: string;
  }>();
  const segments = routeResult?.key === routeKey ? routeResult.segments : [];
  const routeError = routeResult?.key === routeKey ? routeResult.error : undefined;
  const selectPlace = useCallback((placeId: string) => {
    setSelectedPlaceId(placeId);
    mapAdapter.focusPlace(placeId);
    document.getElementById(`timeline-place-${placeId}`)?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }, [mapAdapter]);

  useEffect(() => {
    if (!day || places.length < 2 || unresolvedItemIds.length > 0) return;
    let active = true;
    void activeRouteService.getSegments({
      dayId: day.id,
      placeIds: places.map((place) => place.id),
      modeByLeg: getRouteModes(places.map((place) => place.id)),
    }).then((nextSegments) => {
      if (active) setRouteResult({ key: routeKey, segments: nextSegments });
    }).catch(() => {
      if (active) {
        setRouteResult({ key: routeKey, segments: [], error: "暂未取得高德道路路径，未绘制直线替代路线。" });
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
        <p className="weather-state">待预报</p>
      </header>
      <AmapRouteMap
        places={places}
        segments={segments}
        selectedPlaceId={selectedPlaceId}
        onSelectPlace={selectPlace}
        mapLoader={mapLoader}
      />
      {unresolvedItemIds.length > 0 ? <p className="map-fallback" role="alert">有未识别地点，无法串联道路路线：{unresolvedItemIds.join("、")}</p> : null}
      {routeError ? <p className="map-fallback" role="status">{routeError}</p> : null}
      <section aria-labelledby="timeline-heading">
        <h2 id="timeline-heading">当天行程</h2>
        <Timeline
          places={places}
          segments={segments}
          selectedPlaceId={selectedPlaceId}
          onSelectPlace={selectPlace}
        />
      </section>
    </main>
  );
}
