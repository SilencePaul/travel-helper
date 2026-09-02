import assert from "node:assert/strict";
import test from "node:test";
import { responseMatchesBriefing } from "./verify-briefing.mjs";

test("accepts an exact deployed briefing response", () => {
  assert.equal(responseMatchesBriefing(Buffer.from("<html>deck</html>"), Buffer.from("<html>deck</html>")), true);
});

test("rejects a stale app fallback response", () => {
  assert.equal(responseMatchesBriefing(Buffer.from("<html>deck</html>"), Buffer.from("<html>travel app</html>")), false);
});
