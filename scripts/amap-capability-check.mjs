import { fileURLToPath } from "node:url";

const timeoutMs = 10_000;
const safeInfoCodes = new Set([
  "AMAP_WEB_SERVICE_KEY_MISSING",
  "CUQPS_HAS_EXCEEDED_THE_LIMIT",
  "DAILY_QUERY_OVER_LIMIT",
  "INSUFFICIENT_PRIVILEGES",
  "INVALID_USER_KEY",
  "NETWORK_ERROR",
  "SERVICE_NOT_AVAILABLE",
  "TIMEOUT",
  "UNKNOWN_RESPONSE",
  "USERKEY_EXPIRED",
  "USERKEY_PLAT_NOMATCH",
  "USERKEY_RECYCLED"
]);

const checks = [
  {
    capability: "walking",
    city: "Beijing",
    endpoint: "https://restapi.amap.com/v3/direction/walking",
    origin: "116.397428,39.90923",
    destination: "116.411111,39.906477"
  },
  {
    capability: "transit",
    city: "Beijing",
    endpoint: "https://restapi.amap.com/v3/direction/transit/integrated",
    origin: "116.397428,39.90923",
    destination: "116.411111,39.906477",
    cityCode: "北京"
  },
  {
    capability: "walking",
    city: "Hong Kong",
    endpoint: "https://restapi.amap.com/v3/direction/walking",
    origin: "114.1577,22.28552",
    destination: "114.16936,22.3193"
  },
  {
    capability: "transit",
    city: "Hong Kong",
    endpoint: "https://restapi.amap.com/v3/direction/transit/integrated",
    origin: "114.1577,22.28552",
    destination: "114.16936,22.3193",
    cityCode: "香港"
  }
];

export function classifyAmapResponse(body) {
  if (body?.status === "1") return { ok: true, reason: "available" };
  return { ok: false, reason: sanitizeAmapInfo(body?.info) };
}

export function sanitizeAmapInfo(info) {
  return typeof info === "string" && safeInfoCodes.has(info) ? info : "UNKNOWN_RESPONSE";
}

export function formatAmapResult(check, result) {
  const reason = result.ok ? "available" : sanitizeAmapInfo(result.reason);
  return `${check.capability} | ${check.city} | ${result.ok ? "PASS" : "FAIL"} | ${reason}`;
}

export async function checkCapability(check, key, fetchImpl = fetch) {
  const url = new URL(check.endpoint);
  url.searchParams.set("origin", check.origin);
  url.searchParams.set("destination", check.destination);
  url.searchParams.set("key", key);
  if (check.cityCode) url.searchParams.set("city", check.cityCode);

  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    let body;
    try {
      body = await response.json();
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") throw error;
    }
    if (!response.ok && !body?.info) {
      return { ok: false, reason: `HTTP_${response.status}` };
    }
    return classifyAmapResponse(body);
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof DOMException && error.name === "TimeoutError" ? "TIMEOUT" : "NETWORK_ERROR"
    };
  }
}

function printResult(check, result, print) {
  print(formatAmapResult(check, result));
}

export async function runAmapCapabilityAudit({ key, fetchImpl = fetch, print = console.log }) {
  if (!key) {
    for (const check of checks) {
      printResult(check, { ok: false, reason: "AMAP_WEB_SERVICE_KEY_MISSING" }, print);
    }
    return { exitCode: 1 };
  }

  const results = await Promise.all(
    checks.map(async (check) => ({ check, result: await checkCapability(check, key, fetchImpl) }))
  );
  for (const { check, result } of results) printResult(check, result, print);
  return { exitCode: results.some(({ result }) => !result.ok) ? 1 : 0 };
}

async function main() {
  const audit = await runAmapCapabilityAudit({ key: process.env.AMAP_WEB_SERVICE_KEY });
  process.exitCode = audit.exitCode;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
