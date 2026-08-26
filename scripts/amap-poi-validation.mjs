import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const timeoutMs = 10_000;
const safeReasons = new Set(["AMAP_WEB_SERVICE_KEY_MISSING", "INVALID_USER_KEY", "INSUFFICIENT_PRIVILEGES", "NETWORK_ERROR", "TIMEOUT", "UNRESOLVED_POI", "MISMATCHED_POI", "INVALID_LOCATION"]);

export async function validatePoi(poi, key, fetchImpl = fetch) {
  if (!key) return { id: poi.id, ok: false, reason: "AMAP_WEB_SERVICE_KEY_MISSING" };
  try {
    const url = new URL("https://restapi.amap.com/v3/place/detail");
    url.searchParams.set("key", key);
    url.searchParams.set("id", poi.amapPoiId);
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.json();
    const result = body?.pois?.[0];
    if (!response.ok || body?.status !== "1" || !result) return { id: poi.id, ok: false, reason: "UNRESOLVED_POI" };
    const [lng, lat] = typeof result.location === "string" ? result.location.split(",").map(Number) : [];
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return { id: poi.id, ok: false, reason: "INVALID_LOCATION" };
    if (result.name !== poi.name || lng !== poi.lng || lat !== poi.lat) return { id: poi.id, ok: false, reason: "MISMATCHED_POI" };
    return { id: poi.id, ok: true, reason: "verified" };
  } catch (error) {
    return { id: poi.id, ok: false, reason: error instanceof DOMException && error.name === "TimeoutError" ? "TIMEOUT" : "NETWORK_ERROR" };
  }
}

export async function validatePoiCatalog({ pois, key, fetchImpl = fetch, print = console.log }) {
  const results = await Promise.all(pois.map((poi) => validatePoi(poi, key, fetchImpl)));
  for (const result of results) print(`poi | ${result.id} | ${result.ok ? "PASS" : "FAIL"} | ${safeReasons.has(result.reason) || result.reason === "verified" ? result.reason : "UNRESOLVED_POI"}`);
  return { exitCode: results.some((result) => !result.ok) ? 1 : 0 };
}

async function main() {
  const catalog = JSON.parse(await readFile(new URL("../content/amap-pois.json", import.meta.url), "utf8"));
  const result = await validatePoiCatalog({ pois: catalog, key: process.env.AMAP_WEB_SERVICE_KEY });
  process.exitCode = result.exitCode;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
