import { useEffect, useMemo, useRef, useState } from "react";
import type { Hotel } from "@travel/contracts";
import { loadAmap, missingAmapBrowserCredentials } from "../map/amapLoader";

type Marker = { on: (event: string, callback: () => void) => void; setContent?: (content: string) => void; setzIndex?: (value: number) => void };
type AmapHotelApi = { Map: new (element: HTMLDivElement, options: unknown) => { destroy: () => void; setFitView: () => void; setCenter: (point: [number, number]) => void }; Marker: new (options: unknown) => Marker };
type Props = { hotels: Hotel[]; selectedId?: string; onSelect: (id: string) => void; mapLoader?: () => Promise<AmapHotelApi> };
const markerContent = (name: string, selected: boolean) => `<span class="hotel-amap-marker${selected ? " is-selected" : ""}">${name.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!)}</span>`;

export function AmapHotelMap({ hotels, selectedId, onSelect, mapLoader = loadAmap }: Props) {
  const elementRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<{ destroy: () => void; setCenter: (point: [number, number]) => void } | undefined>(undefined);
  const markersRef = useRef<Record<string, Marker>>({});
  const onSelectRef = useRef(onSelect);
  const selectedRef = useRef(selectedId);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const hotelKey = useMemo(() => hotels.map((hotel) => `${hotel.id}:${hotel.coordinate.lng}:${hotel.coordinate.lat}`).join("|"), [hotels]);
  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);
  useEffect(() => { selectedRef.current = selectedId; }, [selectedId]);
  useEffect(() => {
    let active = true;
    void mapLoader().then((AMap) => {
      if (!active || !elementRef.current) return;
      const map = new AMap.Map(elementRef.current, { resizeEnable: true, zoom: 15 });
      mapRef.current = map;
      hotels.forEach((hotel) => {
        const selected = hotel.id === selectedRef.current;
        const marker = new AMap.Marker({ map, position: [hotel.coordinate.lng, hotel.coordinate.lat], title: hotel.name, zIndex: selected ? 200 : 100, content: markerContent(hotel.name, selected) });
        markersRef.current[hotel.id] = marker;
        marker.on("click", () => onSelectRef.current(hotel.id));
      });
      map.setFitView(); setState("ready");
      const selected = hotels.find((hotel) => hotel.id === selectedRef.current);
      if (selected) map.setCenter([selected.coordinate.lng, selected.coordinate.lat]);
    }).catch((error: unknown) => { if (active) setState(error instanceof Error && error.message === missingAmapBrowserCredentials ? "missing" : "error"); });
    return () => { active = false; mapRef.current?.destroy(); mapRef.current = undefined; markersRef.current = {}; };
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- hotelKey is the map lifecycle key; selection updates existing markers below.
  }, [hotelKey, mapLoader]);
  useEffect(() => { const hotel = hotels.find((item) => item.id === selectedId); if (hotel) { mapRef.current?.setCenter([hotel.coordinate.lng, hotel.coordinate.lat]); Object.entries(markersRef.current).forEach(([id, marker]) => { const markerHotel = hotels.find((item) => item.id === id); if (!markerHotel) return; marker.setContent?.(markerContent(markerHotel.name, id === selectedId)); marker.setzIndex?.(id === selectedId ? 200 : 100); }); } }, [hotels, selectedId]);
  return <><div ref={elementRef} className="hotel-amap-canvas" aria-label="高德酒店地图" aria-busy={state === "loading"} />{state === "missing" ? <p className="map-fallback">浏览器地图凭据未配置，显示可访问的位置标记。</p> : null}{state === "error" ? <p className="map-fallback" role="alert">高德酒店地图暂时无法加载，显示可访问的位置标记。</p> : null}<div className="map-marker-list" aria-label="酒店地图标记">{hotels.map((hotel) => <button type="button" className="map-marker" key={hotel.id} aria-current={selectedId === hotel.id ? "location" : undefined} onClick={() => onSelect(hotel.id)}>在地图中定位 {hotel.name}</button>)}</div></>;
}
