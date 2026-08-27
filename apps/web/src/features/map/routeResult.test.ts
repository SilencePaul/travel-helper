import { describe, expect, it } from "vitest";
import { normalizeRouteQueryResult } from "./routeResult";

describe("normalizeRouteQueryResult", () => {
  it("keeps stale array-only route services compatible without inventing failures", () => {
    const segments = [{ id: "route-1" }];

    expect(normalizeRouteQueryResult(segments)).toEqual({ segments, failures: [] });
  });
});
