export type TravelMode = "walking" | "transit" | "driving";

export type Coordinate = {
  lng: number;
  lat: number;
  coordinateSystem: "GCJ02";
};

export type RouteSegment = {
  id: string;
  fromPlaceId: string;
  toPlaceId: string;
  mode: TravelMode;
  distanceMeters: number;
  durationMinutes: number;
  path: Coordinate[];
  summary: string;
};

export type RouteFailure = {
  fromPlaceId: string;
  toPlaceId: string;
  mode: TravelMode;
  code: "AMAP_ROUTE_PROVIDER_UNAVAILABLE" | "AMAP_ROUTE_TIMEOUT" | "AMAP_ROUTE_UNAVAILABLE" | "AMAP_ROUTE_NO_TRANSIT_PLAN" | "AMAP_ROUTE_MALFORMED_RESPONSE";
};

export type RouteQueryResult = { segments: RouteSegment[]; failures: RouteFailure[] };

export interface RouteService {
  getSegments(input: {
    dayId: string;
    city: string;
    placeIds: string[];
    modeByLeg: TravelMode[];
  }): Promise<RouteQueryResult>;
}

export interface NavigationService {
  open(destination: { name: string; lng: number; lat: number; mode: TravelMode }): void;
}

export type MapInteractionAdapter = {
  focusPlace: (placeId: string) => void;
};

export type TimelinePlace = Coordinate & {
  id: string;
  name: string;
  /** AMap POI ID returned with the GCJ-02 location used for routing. */
  amapPoiId: string;
};
