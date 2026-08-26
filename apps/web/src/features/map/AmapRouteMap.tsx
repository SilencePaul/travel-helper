import { useEffect, useMemo, useRef, useState } from "react";
import { loadAmap, missingAmapBrowserCredentials } from "./amapLoader";
import type { RouteSegment, TimelinePlace } from "./types";

type AmapApi = {
  Map: new (element: HTMLDivElement, options: unknown) => AMapInstance;
  Polyline: new (options: unknown) => unknown;
  Marker: new (options: unknown) => { on: (event: string, callback: () => void) => void };
};

export type AmapLoader = () => Promise<AmapApi>;

type AmapRouteMapProps = {
  places: TimelinePlace[];
  segments: RouteSegment[];
  selectedPlaceId?: string;
  onSelectPlace: (placeId: string) => void;
  mapLoader?: AmapLoader;
};

type AMapInstance = {
  destroy: () => void;
  setFitView: () => void;
  setCenter: (center: [number, number]) => void;
};

export function AmapRouteMap({ places, segments, selectedPlaceId, onSelectPlace, mapLoader = loadAmap }: AmapRouteMapProps) {
  const elementRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<AMapInstance | undefined>(undefined);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [mapGeneration, setMapGeneration] = useState(0);
  const routePointCount = Math.max(0, ...segments.map((segment) => segment.path.length));
  const completeSegments = useMemo(() => segments.filter((segment) => segment.path.length >= 2), [segments]);
  const incompleteSegments = useMemo(() => segments.filter((segment) => segment.path.length < 2), [segments]);

  useEffect(() => {
    let active = true;
    /* oxlint-disable react/set-state-in-effect -- each replacement loader must expose loading before its async result. */
    setState("loading");
    /* oxlint-enable react/set-state-in-effect */
    void mapLoader()
      .then((AMap) => {
        if (!active || !elementRef.current) return;
        const map = new AMap.Map(elementRef.current, { resizeEnable: true, zoom: 13 });
        mapRef.current = map;
        setMapGeneration((generation) => generation + 1);
        for (const segment of completeSegments) {
          new AMap.Polyline({
            map,
            path: segment.path.map(({ lng, lat }) => [lng, lat]),
            strokeColor: "#306b5d",
            strokeWeight: 6,
            strokeOpacity: 0.88,
          });
        }
        for (const place of places) {
          const marker = new AMap.Marker({ map, position: [place.lng, place.lat], title: place.name });
          marker.on("click", () => onSelectPlace(place.id));
        }
        map.setFitView();
        setState("ready");
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState(error instanceof Error && error.message === missingAmapBrowserCredentials ? "missing" : "error");
      });

    return () => {
      active = false;
      mapRef.current?.destroy();
      mapRef.current = undefined;
    };
  }, [completeSegments, mapLoader, onSelectPlace, places]);

  useEffect(() => {
    const selectedPlace = places.find((place) => place.id === selectedPlaceId);
    if (selectedPlace) mapRef.current?.setCenter([selectedPlace.lng, selectedPlace.lat]);
  }, [mapGeneration, places, selectedPlaceId]);

  return (
    <section className="route-map" aria-labelledby="route-map-heading">
      <div className="route-map-heading">
        <div>
          <p className="eyebrow">沿路路线</p>
          <h2 id="route-map-heading">地图与当天动线</h2>
        </div>
        <output className="route-points" data-route-points={routePointCount}>路径点 {routePointCount}</output>
      </div>
      <div ref={elementRef} className="amap-canvas" aria-label="高德地图路线" aria-busy={state === "loading"} />
      {state === "missing" ? <p className="map-fallback" role="status">浏览器地图凭据未配置，暂无法加载高德地图。</p> : null}
      {state === "error" ? <p className="map-fallback" role="alert">高德地图暂时无法加载，请稍后重试。</p> : null}
      {incompleteSegments.map((segment) => <p className="map-fallback" key={segment.id}>“{segment.summary}”缺少完整道路路径，未绘制直线替代路线。</p>)}
      <div className="map-marker-list" aria-label="地图地点标记">
        {places.map((place) => (
          <button
            key={place.id}
            type="button"
            className="map-marker"
            aria-current={selectedPlaceId === place.id ? "location" : undefined}
            onClick={() => onSelectPlace(place.id)}
          >
            在地图中定位 {place.name}
          </button>
        ))}
      </div>
    </section>
  );
}
