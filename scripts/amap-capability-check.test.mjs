import assert from "node:assert/strict";
import {
  checkCapability,
  classifyAmapResponse,
  formatAmapResult,
  runAmapCapabilityAudit
} from "./amap-capability-check.mjs";

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

const uppercaseCanary = "SENSITIVEKEYCANARY";
const uppercaseFormatted = formatAmapResult(
  { capability: "walking", city: "Beijing" },
  classifyAmapResponse({ status: "0", info: uppercaseCanary })
);
assert.equal(uppercaseFormatted, "walking | Beijing | FAIL | UNKNOWN_RESPONSE");
assert.doesNotMatch(uppercaseFormatted, /SENSITIVEKEYCANARY/);

const timeoutResult = await checkCapability(
  {
    endpoint: "https://example.test/directions",
    origin: "1,1",
    destination: "2,2"
  },
  "test-only-value",
  async () => ({
    ok: true,
    json: async () => {
      throw new DOMException("timed out", "TimeoutError");
    }
  })
);
assert.deepEqual(timeoutResult, { ok: false, reason: "TIMEOUT" });

const missingKeyOutput = [];
const missingKeyAudit = await runAmapCapabilityAudit({
  key: undefined,
  print: (line) => missingKeyOutput.push(line),
  fetchImpl: async () => {
    throw new Error("must not fetch without a key");
  }
});
assert.equal(missingKeyAudit.exitCode, 1);
assert.equal(missingKeyOutput.length, 4);
assert.ok(missingKeyOutput.every((line) => line.endsWith("AMAP_WEB_SERVICE_KEY_MISSING")));

let requestCount = 0;
const aggregateAudit = await runAmapCapabilityAudit({
  key: "test-only-value",
  print: () => {},
  fetchImpl: async () => ({
    ok: true,
    json: async () => ({ status: requestCount++ === 0 ? "1" : "0", info: "USERKEY_PLAT_NOMATCH" })
  })
});
assert.equal(aggregateAudit.exitCode, 1);

console.log("amap capability classifier: PASS");
