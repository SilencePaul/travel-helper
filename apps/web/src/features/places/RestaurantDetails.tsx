import type { RestaurantPlace } from "@travel/contracts";

export function RestaurantDetails({ place }: { place: RestaurantPlace }) {
  return (
    <>
      <dl className="place-facts">
        <div><dt>人均</dt><dd>{place.averagePrice}</dd></div>
        <div><dt>两人点单</dt><dd>{place.twoPersonOrder}</dd></div>
        <div><dt>营业时间</dt><dd>{place.hours}</dd></div>
      </dl>
      <section className="place-detail-section" aria-labelledby="recommended-dishes">
        <h3 id="recommended-dishes">菜单 / 招牌信息</h3>
        <ul className="place-tags">{place.signatureDishes.map((dish) => <li key={dish}>{dish}</li>)}</ul>
      </section>
      <p className="place-note"><strong>排队提醒：</strong>{place.queueNote}</p>
      <a className="place-action control-button control-button--text" aria-label="查看餐厅官网（新窗口）" href={place.reservationUrl} target="_blank" rel="noreferrer">查看餐厅官网</a>
    </>
  );
}
