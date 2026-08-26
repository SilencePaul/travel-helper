import assert from "node:assert/strict";
import { classifyAmapResponse } from "./amap-capability-check.mjs";

assert.deepEqual(
  classifyAmapResponse({ status: "1", route: { paths: [{}] } }),
  { ok: true, reason: "available" }
);
assert.deepEqual(
  classifyAmapResponse({ status: "0", info: "USERKEY_PLAT_NOMATCH" }),
  { ok: false, reason: "USERKEY_PLAT_NOMATCH" }
);

console.log("amap capability classifier: PASS");
