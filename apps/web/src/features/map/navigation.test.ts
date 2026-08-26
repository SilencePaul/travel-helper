import { expect, test } from "vitest";
import { buildAmapNavigationUrl } from "./navigation";

test("builds an encoded direct AMap navigation URI in GCJ-02", () => {
  const url = buildAmapNavigationUrl({
    name: "太平山顶 & 凌霄阁",
    lng: 114.1437,
    lat: 22.2759,
    coordinateSystem: "GCJ02",
    mode: "walking",
  });

  expect(url).toContain("https://uri.amap.com/navigation?");
  expect(url).toContain("mode=walk");
  expect(url).toContain("callnative=1");
  const destination = new URL(url);
  expect(destination.searchParams.get("to")).toBe("114.1437,22.2759,太平山顶 & 凌霄阁");
  expect(destination.searchParams.get("coordinate")).toBe("gaode");
});
