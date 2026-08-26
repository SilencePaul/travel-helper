import { useEffect, useRef, useState } from "react";
import type { Hotel } from "@travel/contracts";
import { loadAmap, missingAmapBrowserCredentials } from "../map/amapLoader";

type AmapHotelApi = { Map: new (element: HTMLDivElement, options: unknown) => { destroy: () => void; setFitView: () => void; setCenter: (point: [number, number]) => void }; Marker: new (options: unknown) => { on: (event: string, callback: () => void) => void } };
type Props = { hotels: Hotel[]; selectedId?: string; onSelect: (id: string) => void; mapLoader?: () => Promise<AmapHotelApi> };

export function AmapHotelMap({ hotels, selectedId, onSelect, mapLoader = loadAmap }: Props) {
  const elementRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<{ destroy: () => void; setCenter: (point: [number, number]) => void } | undefined>(undefined);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  useEffect(() => {
    let active = true;
    void mapLoader().then((AMap) => {
      if (!active || !elementRef.current) return;
      const map = new AMap.Map(elementRef.current, { resizeEnable: true, zoom: 15 });
      mapRef.current = map;
      hotels.forEach((hotel) => {
        const marker = new AMap.Marker({ map, position: [hotel.coordinate.lng, hotel.coordinate.lat], title: hotel.name });
        marker.on("click", () => onSelect(hotel.id));
      });
      map.setFitView(); setState("ready");
      const selected = hotels.find((hotel) => hotel.id === selectedId);
      if (selected) map.setCenter([selected.coordinate.lng, selected.coordinate.lat]);
    }).catch((error: unknown) => { if (active) setState(error instanceof Error && error.message === missingAmapBrowserCredentials ? "missing" : "error"); });
    return () => { active = false; mapRef.current?.destroy(); mapRef.current = undefined; };
  }, [hotels, mapLoader, onSelect, selectedId]);
  useEffect(() => { const hotel = hotels.find((item) => item.id === selectedId); if (hotel) mapRef.current?.setCenter([hotel.coordinate.lng, hotel.coordinate.lat]); }, [hotels, selectedId]);
  return <><div ref={elementRef} className="hotel-amap-canvas" aria-label="高德酒店地图" aria-busy={state === "loading"} />{state === "missing" ? <p className="map-fallback">浏览器地图凭据未配置，显示可访问的位置标记。</p> : null}{state === "error" ? <p className="map-fallback" role="alert">高德酒店地图暂时无法加载，显示可访问的位置标记。</p> : null}<div className="map-marker-list" aria-label="酒店地图标记">{hotels.map((hotel) => <button type="button" className="map-marker" key={hotel.id} aria-current={selectedId === hotel.id ? "location" : undefined} onClick={() => onSelect(hotel.id)}>在地图中定位 {hotel.name}</button>)}</div></>;
}
