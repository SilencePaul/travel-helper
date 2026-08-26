import type { RouteSegment, TimelinePlace } from "../map/types";

type TimelineProps = {
  places: TimelinePlace[];
  segments: RouteSegment[];
  selectedPlaceId?: string;
  onSelectPlace: (placeId: string, trigger?: HTMLButtonElement) => void;
};

function formatSegment(segment: RouteSegment) {
  const mode = segment.mode === "walking" ? "步行" : segment.mode === "transit" ? "公共交通" : "驾车";
  const distance = segment.distanceMeters >= 1000
    ? `${(segment.distanceMeters / 1000).toFixed(1).replace(/\\.0$/, "")} 公里`
    : `${segment.distanceMeters} 米`;
  return `${mode} ${distance} · ${segment.durationMinutes} 分钟 · ${segment.summary}`;
}

export function Timeline({ places, segments, selectedPlaceId, onSelectPlace }: TimelineProps) {
  if (places.length === 0) {
    return <p className="empty-state">当天地点待安排</p>;
  }

  return (
    <ol className="timeline">
      {places.map((place, index) => {
        const segment = segments.find((candidate) => candidate.fromPlaceId === place.id);
        return (
          <li id={`timeline-place-${place.id}`} key={place.id} className="timeline-entry">
            <button
              type="button"
              className="timeline-place"
              aria-current={selectedPlaceId === place.id ? "location" : undefined}
              onClick={(event) => onSelectPlace(place.id, event.currentTarget)}
            >
              {place.name}
            </button>
            {segment && index < places.length - 1 ? <p className="timeline-connector">{formatSegment(segment)}</p> : null}
          </li>
        );
      })}
    </ol>
  );
}
