import { expect, test } from "@playwright/test";
import { createHash, createPublicKey, verify } from "node:crypto";
import { LocalAgentBridgeRuntime, canonicalJson } from "../apps/local-agent-bridge/src/runtime.mjs";
import { startLocalAgentBridge } from "../apps/local-agent-bridge/src/server.mjs";

test("member confirms the Agent panel and completes the local Bridge control loop", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Private Network Access is verified in Chromium");
  let createdRun: { agentRunId: string; publicKeyJwk: JsonWebKey; pairingCodeHash: string } | undefined;
  let pairingCode = "";
  const consoleMessages: string[] = [];
  page.on("console", (message) => consoleMessages.push(message.text()));
  await page.exposeFunction("__createTestAgentRun", async (input: { publicKeyJwk: JsonWebKey; pairingCodeHash: string }) => {
    createdRun = { agentRunId: "agent-run-e2e", publicKeyJwk: input.publicKeyJwk, pairingCodeHash: input.pairingCodeHash };
    return { agentRunId: createdRun.agentRunId, expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString() };
  });
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const signed = body.action === "claimAgentRun"
      ? { agentRunId: body.agentRunId, pairingCode: body.pairingCode, clientNonce: body.clientNonce }
      : { agentRunId: body.agentRunId, sequence: body.sequence, idempotencyKey: body.idempotencyKey, action: body.action, payload: body.payload };
    pairingCode = body.pairingCode ?? pairingCode;
    expect(createdRun).toBeDefined();
    expect(body.agentRunId).toBe(createdRun!.agentRunId);
    expect(verify("sha256", Buffer.from(canonicalJson(signed)), { key: createPublicKey({ key: createdRun!.publicKeyJwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(body.signature, "base64url"))).toBe(true);
    if (body.action === "claimAgentRun") {
      expect(createHash("sha256").update(body.pairingCode).digest("base64url")).toBe(createdRun!.pairingCodeHash);
      return Response.json({ ok: true, data: { agentRunId: body.agentRunId, claimedAt: "2026-08-31T00:00:00.000Z", nextSequence: 1 } });
    }
    return Response.json({ ok: true, action: "getDecisionContext", data: { tripId: "trip-2026-gba", preferences: [], candidates: [] } });
  };
  const runtime = new LocalAgentBridgeRuntime({ agentEndpoint: "https://api.example.test/api/agent", fetch: fetchImpl });
  const bridge = await startLocalAgentBridge({ appUrl: "http://127.0.0.1:4173/?__testDecisionAgent=1", port: 0, runtime, allowInsecureLoopbackApp: true });

  try {
    await page.goto(bridge.connectionUrl);
    await expect.poll(() => page.url()).not.toContain("#agentBridge=");
    await page.getByRole("button", { name: "共同决定" }).click();
    await page.getByRole("button", { name: "准备本机 Agent" }).click();
    await expect(page.getByText("请与 Desktop Agent 显示的配对指纹逐字核对。")).toBeVisible();
    await page.getByRole("checkbox", { name: "我确认以上授权范围" }).check();
    await page.getByRole("button", { name: "授权并连接" }).click();
    await expect(page.getByRole("heading", { name: "Agent 正在运行" })).toBeVisible();
    expect(createdRun).toBeDefined();
    await expect(runtime.getDecisionContext()).resolves.toMatchObject({ tripId: "trip-2026-gba" });
    expect(consoleMessages.join("\n")).not.toContain(pairingCode);
  } finally {
    await bridge.close();
  }
});

test("a mismatched Origin cannot prepare or create an Agent authorization", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Private Network Access is verified in Chromium");
  let prepareCalls = 0;
  let createCalls = 0;
  await page.exposeFunction("__createTestAgentRun", async () => {
    createCalls += 1;
    return { agentRunId: "unexpected-run", expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString() };
  });
  const bridge = await startLocalAgentBridge({
    appUrl: "http://127.0.0.1:4174/?__testDecisionAgent=1",
    port: 0,
    allowInsecureLoopbackApp: true,
    runtime: {
      prepare: async () => {
        prepareCalls += 1;
        return {};
      },
      claim: async () => ({ agentRunId: "unexpected-run", status: "claimed" }),
    },
  });

  try {
    const url = new URL("http://127.0.0.1:4173/?__testDecisionAgent=1");
    url.hash = new URLSearchParams({ agentBridge: bridge.origin }).toString();
    await page.goto(url.toString());
    await expect.poll(() => page.url()).not.toContain("#agentBridge=");
    await page.getByRole("button", { name: "共同决定" }).click();
    await page.getByRole("button", { name: "准备本机 Agent" }).click();

    await expect(page.getByRole("alert")).toHaveText("Desktop Bridge 未在线，已保存的共同决定仍可使用。");
    await expect(page.getByRole("button", { name: "授权并连接" })).toHaveCount(0);
    expect(prepareCalls).toBe(0);
    expect(createCalls).toBe(0);
  } finally {
    await bridge.close();
  }
});

test("a non-loopback Agent fragment is cleared before any request or authorization", async ({ page }) => {
  let createCalls = 0;
  await page.exposeFunction("__createTestAgentRun", async () => {
    createCalls += 1;
    return { agentRunId: "unexpected-run", expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString() };
  });
  const fragment = new URLSearchParams({ agentBridge: "https://evil.example" }).toString();

  await page.goto(`http://127.0.0.1:4173/?__testDecisionAgent=1#${fragment}`);
  await expect.poll(() => page.url()).not.toContain("#agentBridge=");
  await page.getByRole("button", { name: "共同决定" }).click();

  await expect(page.getByRole("heading", { name: "Desktop Bridge 未连接" })).toBeVisible();
  await expect(page.getByRole("button", { name: "准备本机 Agent" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "授权并连接" })).toHaveCount(0);
  expect(createCalls).toBe(0);
});
