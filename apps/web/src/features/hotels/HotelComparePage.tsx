import { scoreHotels, stayNightsForHotel, type Trip } from "@travel/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HotelCard } from "./HotelCard";
import { hongKongHotels } from "./hotelData";
import { deriveHotelCommutes } from "./hotelCommutes";
import { AmapHotelMap } from "./AmapHotelMap";
import { createAmapRouteService } from "../map/amapRouteService";
import { loadAmap } from "../map/amapLoader";
import { getPlace } from "../itinerary/itineraryData";
import type { RouteService } from "../map/types";

type HotelComparePageProps = {
  trip: Trip;
  onSelectHotel: (hotelId: string) => boolean | Promise<boolean>;
  onBack: () => void;
  routeService?: RouteService;
};

function hotelNights(trip: Trip, hotelId: string) {
  const selected = stayNightsForHotel(trip, hotelId);
  if (selected > 0) return selected;
  return trip.days.filter((day) => day.city.includes("香港")).length;
}

export function HotelComparePage({ trip, onSelectHotel, onBack, routeService }: HotelComparePageProps) {
  const selectedId = trip.days.find((day) => day.hotelId)?.hotelId;
  const [highlightedId, setHighlightedId] = useState(selectedId ?? hongKongHotels[0]?.id);
  const pendingSelectionRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (pendingSelectionRef.current) return;
    const persisted = selectedId && hongKongHotels.some((hotel) => hotel.id === selectedId) ? selectedId : hongKongHotels[0]?.id;
    setHighlightedId(persisted);
  }, [selectedId]);
  const nights = hotelNights(trip, highlightedId ?? "");
  const defaultRouteService = useMemo(() => createAmapRouteService(loadAmap, (id) => {
    const hotel = hongKongHotels.find((item) => item.id === id);
    return getPlace(id) ?? (hotel ? { id: hotel.id, name: hotel.name, amapPoiId: hotel.amapPoiId, ...hotel.coordinate } : undefined);
  }), []);
  const activeRouteService = routeService ?? defaultRouteService;
  const [commutesByHotel, setCommutesByHotel] = useState<Record<string, import("@travel/contracts").HotelCommute[]>>({});
  const itinerarySignature = trip.days.filter((day) => day.city.includes("香港")).map((day) => `${day.id}:${day.date}:${day.itemIds.join(",")}`).join("|");
  useEffect(() => {
    /* oxlint-disable react/set-state-in-effect -- route data belongs to the active trip and must clear before its replacement resolves. */
    let active = true;
    setCommutesByHotel({});
    /* oxlint-enable react/set-state-in-effect */
    void Promise.all(hongKongHotels.map(async (hotel) => [hotel.id, await deriveHotelCommutes(trip, hotel, activeRouteService)] as const)).then((entries) => { if (active) setCommutesByHotel(Object.fromEntries(entries)); });
    return () => { active = false; };
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- itinerarySignature intentionally avoids refetching when only selection/version changes.
  }, [activeRouteService, itinerarySignature]);
  const scoredHotels = useMemo(() => scoreHotels(hongKongHotels, { nights, commutesByHotel }), [commutesByHotel, nights]);
  const selectedHotel = scoredHotels.find((hotel) => hotel.id === highlightedId) ?? scoredHotels[0];
  const selectedCommutes = selectedHotel ? commutesByHotel[selectedHotel.id] : undefined;
  const allRoutesConfirmed = Boolean(selectedCommutes?.length) && selectedCommutes!.every((item) => item.status === "confirmed");

  const selectHotel = useCallback(async (hotelId: string) => {
    const previousId = highlightedId;
    pendingSelectionRef.current = hotelId;
    setHighlightedId(hotelId);
    try { if (!await onSelectHotel(hotelId)) setHighlightedId(previousId); } catch { setHighlightedId(previousId); } finally { pendingSelectionRef.current = undefined; }
  }, [highlightedId, onSelectHotel]);

  return (
    <main className="hotel-compare narrow-page">
      <button type="button" className="back-button" onClick={onBack}>← 返回行程总览</button>
      <header>
        <p className="eyebrow">香港 · D3 住宿比较</p>
        <h1>住得近，玩得松</h1>
        <p>当前依据行程中的香港住宿日计算：<strong data-testid="hotel-nights">{nights} 晚</strong>。价格为已标明日期与房型的历史参考快照，不是十一实时库存。</p>
      </header>
      <section className="hotel-map" aria-labelledby="hotel-map-heading">
        <div>
          <p className="eyebrow">地图联动</p>
          <h2 id="hotel-map-heading">尖沙咀酒店位置</h2>
          <p>选择卡片或高德地图标记会同步高亮；地图加载失败时会显示可访问的位置标记。</p>
        </div>
        <AmapHotelMap hotels={scoredHotels} selectedId={highlightedId} onSelect={selectHotel} />
      </section>
      {selectedHotel ? <section className="hotel-commute" aria-labelledby="hotel-commute-heading">
        <p className="eyebrow">选中酒店的通勤</p>
        <h2 id="hotel-commute-heading">{selectedHotel.name}</h2>
        <dl>
          <div><dt>住宿参考总额</dt><dd data-testid="hotel-total">{selectedHotel.nightlyPrice.currency} {(selectedHotel.stayTotalMinor / 100).toFixed(2)}</dd></div>
          <div><dt>往返通勤</dt><dd data-testid="hotel-commute">{!selectedCommutes ? "正在请求高德路线" : allRoutesConfirmed ? `${selectedHotel.totalCommuteMinutes} 分钟` : "待高德路线确认"}</dd></div>
          <div><dt>预计步数</dt><dd data-testid="hotel-steps">{!selectedCommutes ? "正在请求高德路线" : !allRoutesConfirmed ? "待高德路线确认" : selectedCommutes.some((item) => item.estimatedSteps === undefined) ? "待高德步行距离确认" : `${selectedCommutes.reduce((sum, item) => sum + item.estimatedSteps!, 0).toLocaleString()} 步`}</dd></div>
        </dl>
        <p className="hotel-caveat">时间与距离只使用高德路线服务返回值；步数仅以高德步行路线距离 ÷ 0.76 米/步估算，并显示同次路线核查时间。缺少步行距离时不估算。</p>
        <ul>
          {(commutesByHotel[selectedHotel.id] ?? []).map((commute) => <li key={commute.date}>{commute.date}：首站 {commute.firstPlace} {commute.status === "confirmed" ? `${commute.outboundMinutes} 分钟` : "待高德路线确认"}；末站 {commute.lastPlace} {commute.status === "confirmed" ? `返回 ${commute.returnMinutes} 分钟，${commute.distanceMeters.toLocaleString()} 米，步行 ${commute.walkingDistanceMeters !== undefined ? `${commute.walkingDistanceMeters.toLocaleString()} 米 / ${commute.estimatedSteps?.toLocaleString()} 步` : "待高德步行距离确认"}，高德核查 ${new Date(commute.sourceCheckedAt!).toLocaleString("zh-CN")}` : "待高德路线确认"}</li>)}
        </ul>
      </section> : null}
      <section className="hotel-grid" aria-label="酒店候选">
        {scoredHotels.map((hotel) => <HotelCard key={hotel.id} hotel={hotel} nights={nights} selected={highlightedId === hotel.id} onSelect={() => selectHotel(hotel.id)} />)}
      </section>
    </main>
  );
}
