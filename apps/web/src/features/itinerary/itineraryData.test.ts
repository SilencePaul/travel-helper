import { describe, expect, it } from "vitest";
import { validatePoiCatalog } from "./itineraryData";

const poi = { id: "peak", name: "太平山顶", amapPoiId: "B073C0YCF7", lng: 114.15, lat: 22.27, coordinateSystem: "GCJ02" };

describe("validatePoiCatalog", () => {
  it("rejects duplicate AMap POIs and invalid GCJ-02 coordinates before catalog indexing", () => {
    expect(() => validatePoiCatalog([poi, { ...poi, id: "other" }])).toThrow("AMAP_POI_CATALOG_INVALID");
    expect(() => validatePoiCatalog([{ ...poi, lat: 100 }])).toThrow("AMAP_POI_CATALOG_INVALID");
  });
});
