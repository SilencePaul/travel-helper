import type { RouteQueryResult, RouteSegment } from "./types";

/** Keeps an already-loaded, pre-result-contract route service usable during HMR. */
export function normalizeRouteQueryResult(value: RouteQueryResult | RouteSegment[] | unknown): RouteQueryResult {
  if (Array.isArray(value)) return { segments: value as RouteSegment[], failures: [] };
  if (value && typeof value === "object") {
    const result = value as Partial<RouteQueryResult>;
    return {
      segments: Array.isArray(result.segments) ? result.segments : [],
      failures: Array.isArray(result.failures) ? result.failures : [],
    };
  }
  return { segments: [], failures: [] };
}
