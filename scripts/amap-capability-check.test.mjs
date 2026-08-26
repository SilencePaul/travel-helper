import assert from "node:assert/strict";
import { classifyAmapResponse, formatAmapResult } from "./amap-capability-check.mjs";

assert.deepEqual(
  classifyAmapResponse({ status: "1", route: { paths: [{}] } }),
  { ok: true, reason: "available" }
);
assert.deepEqual(
  classifyAmapResponse({ status: "0", info: "USERKEY_PLAT_NOMATCH" }),
  { ok: false, reason: "USERKEY_PLAT_NOMATCH" }
);

const canary = "https://example.test/?key=never-print-this";
const formatted = formatAmapResult(
  { capability: "walking", city: "Beijing" },
  classifyAmapResponse({ status: "0", info: canary })
);
assert.equal(formatted, "walking | Beijing | FAIL | UNKNOWN_RESPONSE");
assert.doesNotMatch(formatted, /https|key|never-print-this/i);

console.log("amap capability classifier: PASS");
