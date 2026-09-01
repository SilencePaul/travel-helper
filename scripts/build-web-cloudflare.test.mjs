import assert from "node:assert/strict";
import test from "node:test";
import { assertCloudflareNodeVersion } from "./build-web-cloudflare.mjs";

test("accepts the Node 22 runtime used by Cloudflare Pages", () => {
  assert.doesNotThrow(() => assertCloudflareNodeVersion("v22.22.0"));
  assert.doesNotThrow(() => assertCloudflareNodeVersion("v22.23.2"));
});

test("rejects Node runtimes outside the supported Cloudflare major", () => {
  assert.throws(() => assertCloudflareNodeVersion("v23.11.0"), /Node 22/i);
  assert.throws(() => assertCloudflareNodeVersion("v21.7.3"), /Node 22/i);
});
