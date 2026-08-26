import type { Coordinate, TravelMode } from "./types";

export type NavigationDestination = Coordinate & {
  name: string;
  mode: TravelMode;
};

const amapMode: Record<TravelMode, string> = {
  walking: "walk",
  transit: "bus",
  driving: "car",
};

/** Opens AMap itself when available; the browser remains a graceful fallback. */
export function buildAmapNavigationUrl(destination: NavigationDestination) {
  const parameters = new URLSearchParams({
    to: `${destination.lng},${destination.lat},${destination.name}`,
    mode: amapMode[destination.mode],
    policy: "0",
    coordinate: "gaode",
    callnative: "1",
  });
  return `https://uri.amap.com/navigation?${parameters.toString()}`;
}
