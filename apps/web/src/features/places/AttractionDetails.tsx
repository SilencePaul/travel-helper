import type { AttractionPlace, Place } from "@travel/contracts";

export function AttractionDetails({ place, rainAlternative }: { place: AttractionPlace; rainAlternative?: Place }) {
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
        {rainAlternative
          ? <p><a className="control-button control-button--text" aria-label={`雨天备选：${rainAlternative.name}（新窗口）`} href={rainAlternative.sources[0]!.url} target="_blank" rel="noreferrer">雨天备选：{rainAlternative.name}</a></p>
          : <p><strong>雨天备选：</strong>资料待补充</p>}
      </section>
      <section className="place-detail-section" aria-labelledby="photo-spots">
        <h3 id="photo-spots">拍照位置</h3>
        <ul className="place-tags">{place.photoSpots.map((spot) => <li key={spot}>{spot}</li>)}</ul>
      </section>
      <a className="place-action control-button control-button--primary" aria-label="官方订票（新窗口）" href={place.bookingUrl} target="_blank" rel="noreferrer">官方订票</a>
    </>
  );
}
