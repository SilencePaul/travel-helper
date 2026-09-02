import type { Member, Trip } from "@travel/contracts";

export type TravelPassHeroProps = {
  trip: Trip;
  member?: Member;
  selectedDayId?: string;
};

const cityCodes: Record<string, string> = {
  深圳: "SZX",
  香港: "HKG",
  澳门: "MFM",
  珠海: "ZUH",
  北京: "PEK",
};
const fallbackStop = { code: "SZX", city: "深圳" };

function routeStops(city: string) {
  return city.split("/").map((stop) => stop.trim()).filter(Boolean);
}

function selectedRouteLeg(trip: Trip, selectedDayId?: string) {
  const requestedIndex = trip.days.findIndex((day) => day.id === selectedDayId);
  const dayIndex = requestedIndex >= 0 ? requestedIndex : trip.days.findIndex((day) => day.city !== "北京");
  const index = dayIndex >= 0 ? dayIndex : 0;
  const day = trip.days[index];
  const departure = index === 0
    ? "北京"
    : routeStops(trip.days[index - 1]?.city ?? "").at(-1) ?? "北京";
  const arrival = trip.days
    .slice(index)
    .flatMap((candidate) => routeStops(candidate.city))
    .find((stop) => stop !== departure) ?? fallbackStop.city;

  return {
    date: day?.date ?? trip.startDate,
    city: day?.city ?? fallbackStop.city,
    departure,
    arrival,
    dayNumber: index + 1,
  };
}

function formatDate(date: string) {
  return date.replaceAll("-", ".");
}

export function TravelPassHero({ trip, member, selectedDayId }: TravelPassHeroProps) {
  const day = selectedRouteLeg(trip, selectedDayId);
  const activeStops = [...new Set(
    routeStops(day.city).filter((stop) => Object.hasOwn(cityCodes, stop)),
  )];
  const routeDescription = "北京出发，经深圳、香港、澳门、珠海，返回北京的路线";
  const routeAriaLabel = activeStops.length > 0
    ? `${routeDescription}；当前 D${day.dayNumber}，${activeStops.join("、")}已高亮`
    : routeDescription;
  const departureCode = cityCodes[day.departure] ?? "PEK";
  const destinationCode = cityCodes[day.arrival] ?? fallbackStop.code;
  const departureCaption = `${day.departure}出发`;
  const destinationCaption = day.dayNumber === 1
    ? `第一站·${day.arrival}`
    : day.arrival === "北京" ? "返回·北京" : `下一站·${day.arrival}`;
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
          aria-label={routeAriaLabel}
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
          <g data-station="SZX 深圳" data-active={activeStops.includes("深圳") || undefined} className="travel-pass-hero__station travel-pass-hero__station--stop" transform="translate(215 220)">
            <circle r="7" fill="#1f5a43" />
            <text y="25" textAnchor="middle">SZX 深圳</text>
          </g>
          <g data-station="HKG 香港" data-active={activeStops.includes("香港") || undefined} className="travel-pass-hero__station travel-pass-hero__station--stop" transform="translate(320 140)">
            <circle r="7" fill="#1f5a43" />
            <text y="-18" textAnchor="middle">HKG 香港</text>
          </g>
          <g data-station="MFM 澳门" data-active={activeStops.includes("澳门") || undefined} className="travel-pass-hero__station travel-pass-hero__station--stop" transform="translate(414 252)">
            <circle r="7" fill="#1f5a43" />
            <text y="25" textAnchor="middle">MFM 澳门</text>
          </g>
          <g data-station="ZUH 珠海" data-active={activeStops.includes("珠海") || undefined} className="travel-pass-hero__station travel-pass-hero__station--stop" transform="translate(505 224)">
            <circle r="7" fill="#1f5a43" />
            <text y="25" textAnchor="middle">ZUH 珠海</text>
          </g>
          <g data-station="PEK 北京" data-active={activeStops.includes("北京") || undefined} className="travel-pass-hero__station travel-pass-hero__station--endpoint" transform="translate(720 102)">
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
          <p aria-label={`${departureCode} ${departureCaption}`}><strong className="travel-pass-hero__leg-code">{departureCode}</strong><small className="travel-pass-hero__leg-caption">{departureCaption}</small></p>
          <span aria-hidden="true">→</span>
          <p aria-label={`${destinationCode} ${destinationCaption}`}><strong className="travel-pass-hero__leg-code">{destinationCode}</strong><small className="travel-pass-hero__leg-caption">{destinationCaption}</small></p>
        </div>
        <div className="travel-pass-hero__ticket-day" aria-label={`D${day.dayNumber} ${formatDate(day.date)} ${day.departure} 至 ${day.arrival}`}>
          <span>D{day.dayNumber} · {formatDate(day.date)} · {day.city}</span>
          <span>行程待启程</span>
        </div>
        <div className="travel-pass-hero__perforation" data-testid="travel-pass-perforation" aria-hidden="true" />
        <dl className="travel-pass-hero__ticket-details">
          <div><dt>TRAVELERS</dt><dd>{names}</dd></div>
          <div><dt>PASS NO.</dt><dd>{serial}</dd></div>
        </dl>
        <p className="travel-pass-hero__serial">PASS NO. {serial}</p>
        <div className="travel-pass-hero__stamp" data-testid="travel-pass-stamp" aria-label={`第${day.dayNumber}天日期章`}>
          <span>D{day.dayNumber}</span>
          <small>{formatDate(day.date)}</small>
        </div>
      </article>
    </section>
  );
}
