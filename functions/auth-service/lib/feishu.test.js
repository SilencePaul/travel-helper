const assert = require("node:assert/strict");
const test = require("node:test");

const { createFeishuClient } = require("./feishu.js");

test("Feishu requests fail with a stable provider error instead of hanging indefinitely", async () => {
  const client = createFeishuClient({
    env: { FEISHU_APP_ID: "cli", FEISHU_APP_SECRET: "secret" },
    timeoutMs: 5,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    }),
  });

  await assert.rejects(() => client.resolveAuthorizationCode("code"), { code: "AUTH_PROVIDER_ERROR" });
});
