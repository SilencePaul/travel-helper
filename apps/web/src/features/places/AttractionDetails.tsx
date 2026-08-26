import type { AttractionPlace } from "@travel/contracts";

export function AttractionDetails({ place }: { place: AttractionPlace }) {
  return (
    <>
      <dl className="place-facts">
        <div><dt>门票</dt><dd>{place.ticketPrice}</dd></div>
        <div><dt>建议停留</dt><dd>预计停留 {place.stayMinutes} 分钟</dd></div>
        <div><dt>开放时间</dt><dd>{place.hours}</dd></div>
      </dl>
      <section className="place-detail-section" aria-labelledby="visit-tips">
        <h3 id="visit-tips">到访提示</h3>
        <p><strong>最佳时段：</strong>{place.bestTime}</p>
        <p><strong>人流提醒：</strong>{place.crowdNote}</p>
        <p><strong>雨天备选：</strong>峰顶室内区域（待确认）</p>
      </section>
      <section className="place-detail-section" aria-labelledby="photo-spots">
        <h3 id="photo-spots">拍照位置</h3>
        <ul className="place-tags">{place.photoSpots.map((spot) => <li key={spot}>{spot}</li>)}</ul>
      </section>
      <a className="place-action" href={place.bookingUrl} target="_blank" rel="noreferrer">官方订票</a>
    </>
  );
}
