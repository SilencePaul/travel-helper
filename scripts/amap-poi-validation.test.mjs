import assert from "node:assert/strict";
import { validatePoi, validatePoiCatalog } from "./amap-poi-validation.mjs";

const poi = { id: "peak", name: "太平山顶", amapPoiId: "poi-1", lng: 114.1, lat: 22.2, coordinateSystem: "GCJ02" };
const verified = await validatePoi(poi, "test-only-key", async () => ({
  ok: true,
  json: async () => ({ status: "1", pois: [{ name: "太平山顶", location: "114.1,22.2" }] }),
}));
assert.deepEqual(verified, { id: "peak", ok: true, reason: "verified" });

const mismatched = await validatePoi(poi, "test-only-key", async () => ({
  ok: true,
  json: async () => ({ status: "1", pois: [{ name: "其他", location: "114.1,22.2" }] }),
}));
assert.deepEqual(mismatched, { id: "peak", ok: false, reason: "MISMATCHED_POI" });

let attempts = 0;
const retried = await validatePoi(poi, "test-only-key", async () => {
  attempts += 1;
  if (attempts === 1) throw new Error("temporary");
  return { ok: true, json: async () => ({ status: "1", pois: [{ name: "太平山顶", location: "114.1,22.2" }] }) };
});
assert.deepEqual(retried, { id: "peak", ok: true, reason: "verified" });
assert.equal(attempts, 2);

const lines = [];
const result = await validatePoiCatalog({ pois: [poi], key: undefined, print: (line) => lines.push(line) });
assert.equal(result.exitCode, 1);
assert.deepEqual(lines, ["poi | peak | FAIL | AMAP_WEB_SERVICE_KEY_MISSING"]);
assert.doesNotMatch(lines.join("\n"), /test-only-key/i);

let inFlight = 0;
let maxInFlight = 0;
await validatePoiCatalog({ pois: [poi, { ...poi, id: "peak-2" }], key: "test-only-key", print: () => undefined, fetchImpl: async () => {
  inFlight += 1;
  maxInFlight = Math.max(maxInFlight, inFlight);
  await new Promise((resolve) => setTimeout(resolve, 1));
  inFlight -= 1;
  return { ok: true, json: async () => ({ status: "1", pois: [{ name: "太平山顶", location: "114.1,22.2" }] }) };
} });
assert.equal(maxInFlight, 1);
console.log("amap poi validator: PASS");
