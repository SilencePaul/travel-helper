import type { ScoredHotel } from "@travel/contracts";

type HotelCardProps = {
  hotel: ScoredHotel;
  nights: number;
  selected: boolean;
  onSelect: () => void;
};

export function HotelCard({ hotel, nights, selected, onSelect }: HotelCardProps) {
  return (
    <article className="hotel-card" data-selected={selected || undefined}>
      <div className="hotel-card-heading">
        <div>
          <p className="eyebrow">{hotel.neighborhood}</p>
          <h2>{hotel.name}</h2>
        </div>
        {hotel.badges.map((badge) => <span className="hotel-badge" key={badge}>{badge}</span>)}
      </div>
      <p className="hotel-address">{hotel.address}</p>
      <dl className="hotel-facts">
        <div><dt>住宿 {nights} 晚（含税参考总额）</dt><dd>{hotel.nightlyPrice.currency} {(hotel.stayTotalMinor / 100).toFixed(2)}</dd></div>
        <div><dt>3 晚含税快照总额</dt><dd>{hotel.nightlyPrice.currency} {(hotel.nightlyPrice.snapshotTotalMinor / 100).toFixed(2)}</dd></div>
        <div><dt>房型 / 面积</dt><dd>{hotel.roomArea}</dd></div>
        <div><dt>早餐</dt><dd>{hotel.breakfast}</dd></div>
        <div><dt>取消</dt><dd>{hotel.cancellation}</dd></div>
        <div><dt>车站</dt><dd>{hotel.stationWalk}</dd></div>
      </dl>
      <p className="hotel-caveat">{hotel.nightlyPrice.scope}</p>
      <p className="hotel-source">原始分数：价格 {hotel.priceScore.toFixed(3)} · 通勤 {hotel.commuteScore.toFixed(3)}；通勤 {hotel.totalCommuteMinutes > 0 ? `${hotel.totalCommuteMinutes} 分钟（高德已返回部分路线）` : "待高德路线确认"}</p>
      <p className="hotel-source">平台：<a href={hotel.nightlyPrice.source.url} target="_blank" rel="noreferrer">{hotel.nightlyPrice.source.platform} · {hotel.nightlyPrice.source.label}</a> · 核查于 {new Date(hotel.nightlyPrice.source.checkedAt).toLocaleDateString("zh-CN")}</p>
      <p className="hotel-strength">适合：{hotel.strengths.join("；")}</p>
      <p className="hotel-drawback">留意：{hotel.drawbacks.join("；")}</p>
      <button type="button" className="hotel-select" aria-pressed={selected} onClick={onSelect}>
        {selected ? "已选此酒店" : "选择此酒店"}
      </button>
    </article>
  );
}
