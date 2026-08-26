import { describe, expect, it } from "vitest";
import { getPlaceDetail, validatePoiCatalog } from "./itineraryData";

const poi = { id: "peak", name: "太平山顶", amapPoiId: "B073C0YCF7", lng: 114.15, lat: 22.27, coordinateSystem: "GCJ02" };

describe("validatePoiCatalog", () => {
  it("rejects duplicate AMap POIs and invalid GCJ-02 coordinates before catalog indexing", () => {
    expect(() => validatePoiCatalog([poi, { ...poi, id: "other" }])).toThrow("AMAP_POI_CATALOG_INVALID");
    expect(() => validatePoiCatalog([{ ...poi, lat: 100 }])).toThrow("AMAP_POI_CATALOG_INVALID");
  });
});

describe("sourced D3 place details", () => {
  it("does not present another branch menu as the Peak Tower cafe menu", () => {
    const restaurant = getPlaceDetail("arabica-peak");
    expect(restaurant?.type).toBe("restaurant");
    if (restaurant?.type !== "restaurant") return;
    expect(restaurant.signatureDishes).toEqual([
      "山顶门店官方页未公开招牌单品",
      "到店以现场菜单为准",
    ]);
    expect(restaurant.sources.some((source) => source.kind === "menu")).toBe(false);
    expect(restaurant.averagePrice).toContain("山顶官方店铺页");
  });
});
