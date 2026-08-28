import type { Member, Trip } from "@travel/contracts";

export type TravelPassHeroProps = {
  trip: Trip;
  member?: Member;
};

const cityCodes: Record<string, string> = {
  深圳: "SZX",
  香港: "HKG",
  澳门: "MFM",
  珠海: "ZUH",
};
const fallbackStop = { code: "SZX", city: "深圳" };

function firstTravelDay(trip: Trip) {
  const day = trip.days.find((candidate) => candidate.city !== "北京") ?? trip.days[0];
  return {
    date: day?.date ?? trip.startDate,
    city: day?.city && day.city !== "北京" ? day.city : fallbackStop.city,
  };
}

function formatDate(date: string) {
  return date.replaceAll("-", ".");
}

export function TravelPassHero({ trip, member }: TravelPassHeroProps) {
  const day = firstTravelDay(trip);
  const destinationCode = cityCodes[day.city] ?? fallbackStop.code;
  const travelerNames = trip.travelers.map((traveler) => traveler.name);
  const names = travelerNames.length > 0 ? travelerNames.join(" / ") : member?.displayName ?? "旅行者";
  const serial = trip.id.slice(0, 6).toUpperCase() || "SOUTH";

  return (
    <section className="travel-pass-hero" aria-labelledby="travel-pass-hero-heading">
      <div className="travel-pass-hero__story">
        <p className="travel-pass-hero__eyebrow">SOUTHBOUND · 2026</p>
        <h1 id="travel-pass-hero-heading" className="travel-pass-hero__heading">
          两个人，<span className="travel-pass-hero__heading-emphasis">一条向南的路线。</span>
        </h1>
        <p className="travel-pass-hero__summary">从北京出发，穿过深圳、香港、澳门与珠海，再回到北京。</p>

        <svg
          className="travel-pass-hero__route"
          viewBox="0 0 768 320"
          role="img"
          aria-label="北京出发，经深圳、香港、澳门、珠海，返回北京的路线"
        >
          <path
            data-testid="travel-route-wave"
            className="travel-pass-hero__route-wave"
            d="M 72 102 C 110 88, 160 212, 215 220 C 263 228, 281 126, 320 140 C 357 153, 375 271, 414 252 C 455 232, 467 201, 505 224 C 570 267, 640 117, 720 102"
            fill="none"
            stroke="#1f5a43"
            strokeWidth="3"
            strokeDasharray="8 8"
          />
          <g data-station="PEK 北京" className="travel-pass-hero__station travel-pass-hero__station--endpoint" transform="translate(72 102)">
            <circle r="10" fill="#fffaf2" stroke="#d85535" strokeWidth="3" />
            <text y="-18" textAnchor="middle">PEK 北京</text>
          </g>
          <g data-station="SZX 深圳" className="travel-pass-hero__station travel-pass-hero__station--stop" transform="translate(215 220)">
            <circle r="7" fill="#1f5a43" />
            <text y="25" textAnchor="middle">SZX 深圳</text>
          </g>
          <g data-station="HKG 香港" className="travel-pass-hero__station travel-pass-hero__station--stop" transform="translate(320 140)">
            <circle r="7" fill="#1f5a43" />
            <text y="-18" textAnchor="middle">HKG 香港</text>
          </g>
          <g data-station="MFM 澳门" className="travel-pass-hero__station travel-pass-hero__station--stop" transform="translate(414 252)">
            <circle r="7" fill="#1f5a43" />
            <text y="25" textAnchor="middle">MFM 澳门</text>
          </g>
          <g data-station="ZUH 珠海" className="travel-pass-hero__station travel-pass-hero__station--stop" transform="translate(505 224)">
            <circle r="7" fill="#1f5a43" />
            <text y="25" textAnchor="middle">ZUH 珠海</text>
          </g>
          <g data-station="PEK 北京" className="travel-pass-hero__station travel-pass-hero__station--endpoint" transform="translate(720 102)">
            <circle r="10" fill="#fffaf2" stroke="#d85535" strokeWidth="3" />
            <text y="-18" textAnchor="middle">PEK 北京</text>
          </g>
        </svg>
      </div>

      <article className="travel-pass-hero__ticket" aria-label="旅行通行证">
        <span className="travel-pass-hero__notch" data-testid="travel-pass-notch" aria-hidden="true" />
        <span className="travel-pass-hero__notch" data-testid="travel-pass-notch" aria-hidden="true" />
        <header className="travel-pass-hero__ticket-header">
          <span>TRIP PASS</span>
          <span>PRIVATE JOURNEY</span>
        </header>
        <div className="travel-pass-hero__leg">
          <p aria-label="PEK 北京出发"><strong className="travel-pass-hero__leg-code">PEK</strong><small className="travel-pass-hero__leg-caption">北京出发</small></p>
          <span aria-hidden="true">→</span>
          <p aria-label={`${destinationCode} 第一站·${day.city}`}><strong className="travel-pass-hero__leg-code">{destinationCode}</strong><small className="travel-pass-hero__leg-caption">第一站·{day.city}</small></p>
        </div>
        <div className="travel-pass-hero__ticket-day" aria-label={`D1 ${formatDate(day.date)} 第一站 ${day.city}`}>
          <span>D1 · {formatDate(day.date)} · {day.city}</span>
          <span>行程待启程</span>
        </div>
        <div className="travel-pass-hero__perforation" data-testid="travel-pass-perforation" aria-hidden="true" />
        <dl className="travel-pass-hero__ticket-details">
          <div><dt>TRAVELERS</dt><dd>{names}</dd></div>
          <div><dt>PASS NO.</dt><dd>{serial}</dd></div>
        </dl>
        <p className="travel-pass-hero__serial">PASS NO. {serial}</p>
        <div className="travel-pass-hero__stamp" data-testid="travel-pass-stamp" aria-label="第一天日期章">
          <span>D1</span>
          <small>{formatDate(day.date)}</small>
        </div>
      </article>
    </section>
  );
}
