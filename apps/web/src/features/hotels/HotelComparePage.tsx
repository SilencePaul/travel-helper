import { scoreHotels, stayNightsForHotel, type Trip } from "@travel/contracts";
import { useMemo, useState } from "react";
import { HotelCard } from "./HotelCard";
import { hongKongHotels } from "./hotelData";
import { deriveHotelCommutes } from "./hotelCommutes";
import { AmapHotelMap } from "./AmapHotelMap";

type HotelComparePageProps = {
  trip: Trip;
  onSelectHotel: (hotelId: string) => void | Promise<unknown>;
  onBack: () => void;
};

function hotelNights(trip: Trip, hotelId: string) {
  const selected = stayNightsForHotel(trip, hotelId);
  if (selected > 0) return selected;
  return trip.days.filter((day) => day.city.includes("香港")).length;
}

export function HotelComparePage({ trip, onSelectHotel, onBack }: HotelComparePageProps) {
  const selectedId = trip.days.find((day) => day.hotelId)?.hotelId;
  const [highlightedId, setHighlightedId] = useState(selectedId ?? hongKongHotels[0]?.id);
  const nights = hotelNights(trip, highlightedId ?? "");
  const commutesByHotel = useMemo(() => Object.fromEntries(hongKongHotels.map((hotel) => [hotel.id, deriveHotelCommutes(trip, hotel)])), [trip]);
  const scoredHotels = useMemo(() => scoreHotels(hongKongHotels, { nights, commutesByHotel }), [commutesByHotel, nights]);
  const selectedHotel = scoredHotels.find((hotel) => hotel.id === highlightedId) ?? scoredHotels[0];

  function selectHotel(hotelId: string) {
    setHighlightedId(hotelId);
    void onSelectHotel(hotelId);
  }

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
          <p>选择卡片或位置标记会同步高亮；这是候选位置示意，路线时间仍需以高德实际路线复核。</p>
        </div>
        <AmapHotelMap hotels={scoredHotels} selectedId={highlightedId} onSelect={selectHotel} />
      </section>
      {selectedHotel ? <section className="hotel-commute" aria-labelledby="hotel-commute-heading">
        <p className="eyebrow">选中酒店的通勤</p>
        <h2 id="hotel-commute-heading">{selectedHotel.name}</h2>
        <dl>
          <div><dt>住宿参考总额</dt><dd data-testid="hotel-total">{selectedHotel.nightlyPrice.currency} {(selectedHotel.stayTotalMinor / 100).toFixed(2)}</dd></div>
          <div><dt>往返通勤</dt><dd data-testid="hotel-commute">{selectedHotel.totalCommuteMinutes} 分钟</dd></div>
          <div><dt>预计步数</dt><dd data-testid="hotel-steps">{selectedHotel.estimatedSteps.toLocaleString()} 步</dd></div>
        </dl>
        <p className="hotel-caveat">通勤为当前行程地点的本地估算，用于相对比较；待路线服务可用后应以高德实际路线复核。</p>
        <ul>
          {(commutesByHotel[selectedHotel.id] ?? []).map((commute) => <li key={commute.date}>{commute.date}：首站 {commute.firstPlace} {commute.outboundMinutes} 分钟；末站 {commute.lastPlace} 返回 {commute.returnMinutes} 分钟；约 {commute.estimatedSteps.toLocaleString()} 步</li>)}
        </ul>
      </section> : null}
      <section className="hotel-grid" aria-label="酒店候选">
        {scoredHotels.map((hotel) => <HotelCard key={hotel.id} hotel={hotel} nights={nights} selected={highlightedId === hotel.id} onSelect={() => selectHotel(hotel.id)} />)}
      </section>
    </main>
  );
}
