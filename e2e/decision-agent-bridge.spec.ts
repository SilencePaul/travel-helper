import { expect, test } from "@playwright/test";
import { createHash, createPublicKey, verify } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import seed from "../content/trip.seed.json";
import { DecisionResearchHarness } from "./fixtures/decisionResearchHarness";

type RuntimeModule = typeof import("../apps/local-agent-bridge/src/runtime.mjs");
type ServerModule = typeof import("../apps/local-agent-bridge/src/server.mjs");
type DecisionResearchModule = typeof import("../packages/contracts/src/decision-research.mjs");

async function loadBridgeModules(): Promise<RuntimeModule & ServerModule> {
  const runtimeUrl = pathToFileURL(resolve(process.cwd(), "apps/local-agent-bridge/src/runtime.mjs")).href;
  const serverUrl = pathToFileURL(resolve(process.cwd(), "apps/local-agent-bridge/src/server.mjs")).href;
  const [runtime, server] = await Promise.all([
    import(runtimeUrl) as Promise<RuntimeModule>,
    import(serverUrl) as Promise<ServerModule>,
  ]);
  return { ...runtime, ...server };
}

async function loadDecisionResearchContracts(): Promise<DecisionResearchModule> {
  const contractsUrl = pathToFileURL(resolve(process.cwd(), "packages/contracts/src/decision-research.mjs")).href;
  return import(contractsUrl) as Promise<DecisionResearchModule>;
}

async function openDecisionResearch(page: import("@playwright/test").Page, role: "admin" | "member" = "admin") {
  await page.goto(`/?__testDecisionAgent=1&__testDecisionAgentRole=${role}`);
  await page.getByRole("button", { name: "共同决定" }).click();
}

async function selectResearchTarget(page: import("@playwright/test").Page, category: "hotel" | "restaurant" | "attraction" = "hotel") {
  const categoryName = { hotel: "酒店", restaurant: "餐厅", attraction: "景点" }[category];
  await page.getByRole("radio", { name: /香港 2026-10-04/ }).check();
  await page.getByRole("radio", { name: new RegExp(categoryName) }).check();
  await page.getByRole("button", { name: "准备本机 Codex" }).click();
  await page.getByRole("checkbox", { name: /我确认以上授权范围/ }).check();
  return categoryName;
}

test("the dev-only research fixture creates only after confirmation and atomically shows same-category candidates", async ({ page }) => {
  const harness = new DecisionResearchHarness(page);
  await harness.install();
  await openDecisionResearch(page);

  const categoryName = await selectResearchTarget(page, "hotel");
  expect(harness.count("workspace.command")).toBe(0);
  await page.getByRole("button", { name: `开始研究${categoryName}候选` }).click();
  await expect.poll(() => harness.count("bridge.execute")).toBe(1);
  await expect(page.getByText("正在请 Codex 搜索候选与可核验来源")).toBeVisible();
  const statusReadsBeforeCompletion = harness.count("bridge.status");
  const workspaceRefreshesBeforeCompletion = harness.count("workspace.refresh");
  harness.complete();

  await expect.poll(() => harness.count("bridge.status")).toBeGreaterThan(statusReadsBeforeCompletion);
  await expect.poll(() => harness.count("workspace.refresh")).toBeGreaterThan(workspaceRefreshesBeforeCompletion);
  await expect(page.getByRole("heading", { name: "海景行旅" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "湾畔酒店" })).toBeVisible();
  for (const name of ["码头茶餐厅", "巷里小馆", "海港博物馆", "山顶花园"]) {
    await expect(page.getByRole("heading", { name })).toHaveCount(0);
  }
  expect(harness.count("workspace.command")).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

for (const scenario of [
  { category: "restaurant" as const, categoryName: "餐厅", expected: ["码头茶餐厅", "巷里小馆"], absent: ["海景行旅", "湾畔酒店", "海港博物馆", "山顶花园"] },
  { category: "attraction" as const, categoryName: "景点", expected: ["海港博物馆", "山顶花园"], absent: ["海景行旅", "湾畔酒店", "码头茶餐厅", "巷里小馆"] },
]) {
  test(`${scenario.categoryName} research never mixes candidate categories`, async ({ page }) => {
    const harness = new DecisionResearchHarness(page);
    await harness.install();
    await openDecisionResearch(page);
    await selectResearchTarget(page, scenario.category);
    await page.getByRole("button", { name: `开始研究${scenario.categoryName}候选` }).click();
    await expect.poll(() => harness.count("bridge.execute")).toBe(1);
    harness.complete();

    for (const name of scenario.expected) await expect(page.getByRole("heading", { name })).toBeVisible();
    for (const name of scenario.absent) await expect(page.getByRole("heading", { name })).toHaveCount(0);
  });
}

test("completing a new category preserves existing shared decisions", async ({ page }) => {
  const harness = new DecisionResearchHarness(page, { existingSharedDecision: true });
  await harness.install();
  await openDecisionResearch(page);
  const before = harness.workspaceSnapshot();
  await expect(page.getByRole("heading", { name: "海景行旅" })).toBeVisible();
  await selectResearchTarget(page, "restaurant");
  await page.getByRole("button", { name: "开始研究餐厅候选" }).click();
  await expect.poll(() => harness.count("bridge.execute")).toBe(1);

  harness.complete();
  expect(harness.runSnapshot("agent-run-e2e-1")?.status).toBe("revoked");

  await expect(page.getByRole("heading", { name: "码头茶餐厅" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "海景行旅" })).toBeVisible();
  const after = harness.workspaceSnapshot();
  const existingCandidateIds = new Set(before.candidates.map((candidate) => candidate.id));
  expect(after.preferences).toEqual(before.preferences);
  expect(after.summary).toEqual(before.summary);
  expect(after.placements).toEqual(before.placements);
  expect(after.feedback).toEqual(before.feedback);
  expect(after.confirmations).toEqual(before.confirmations);
  expect(after.candidates.filter((candidate) => existingCandidateIds.has(candidate.id))).toEqual(before.candidates);
  expect(after.evidence.filter((evidence) => existingCandidateIds.has(evidence.candidateId))).toEqual(before.evidence);
});

test("a multi-city trip binds the exact selected segment into the disclosure and execute request", async ({ page }) => {
  const { buildResearchDisclosure, buildResearchTargetScopes, computeDisclosureFingerprint } = await loadDecisionResearchContracts();
  const harness = new DecisionResearchHarness(page);
  await harness.install();
  await openDecisionResearch(page);
  await selectResearchTarget(page, "hotel");

  const trip = {
    version: seed.version,
    days: seed.days.map(({ id, date, city }) => ({ id, date, city })),
    travelerNames: seed.travelers.map(({ name }) => name),
    travelerCount: seed.travelers.length,
  };
  const hongKongScope = buildResearchTargetScopes(trip).find((scope) => scope.city === "香港");
  expect(hongKongScope).toBeDefined();
  const disclosure = await buildResearchDisclosure(
    { trip, workspace: harness.workspaceSnapshot() },
    { category: "hotel", targetScopeId: hongKongScope!.targetScopeId },
  );
  const disclosureFingerprint = await computeDisclosureFingerprint(disclosure);

  await expect(page.getByText("香港 · 2026-10-04 至 2026-10-05 · 2 人")).toBeVisible();
  await page.getByRole("button", { name: "开始研究酒店候选" }).click();
  await expect.poll(() => harness.count("bridge.execute")).toBe(1);
  expect(harness.inputs("bridge.execute")).toEqual([{
    agentRunId: "agent-run-e2e-1",
    targetCategory: "hotel",
    targetScopeId: hongKongScope!.targetScopeId,
    disclosureFingerprint,
  }]);
  harness.complete();
});

test("a disclosure change after confirmation clears consent and cannot create a Codex run", async ({ page }) => {
  const harness = new DecisionResearchHarness(page);
  await harness.install();
  await openDecisionResearch(page);
  await selectResearchTarget(page, "hotel");

  await harness.publishDisclosureChange();

  await expect(page.getByRole("checkbox", { name: /我确认以上授权范围/ })).not.toBeChecked();
  await expect(page.getByRole("button", { name: "开始研究酒店候选" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "准备本机 Codex" })).toBeVisible();
  expect(harness.count("workspace.command")).toBe(0);
  expect(harness.count("bridge.execute")).toBe(0);
});

test("unmounting the Agent panel aborts an in-flight Bridge request without leaving pending work", async ({ page }) => {
  const harness = new DecisionResearchHarness(page, { holdPrepare: true });
  await harness.install();
  await openDecisionResearch(page);
  await page.getByRole("radio", { name: /香港 2026-10-04/ }).check();
  await page.getByRole("radio", { name: /酒店/ }).check();
  await page.getByRole("button", { name: "准备本机 Codex" }).click();
  await expect.poll(() => harness.count("bridge.prepare")).toBe(1);

  await page.getByRole("button", { name: /返回行程/ }).click();

  await expect.poll(() => harness.count("bridge.abort")).toBe(1);
  expect(harness.calls.find((call) => call.operation === "bridge.prepare")?.request).toMatchObject({ aborted: false });
  expect(harness.count("bridge.prepare")).toBe(harness.count("bridge.abort"));
  await expect.poll(() => harness.pendingRequestCount()).toBe(0);
});

test("a regular member sees only the static notice and makes zero local Bridge calls", async ({ page }) => {
  const harness = new DecisionResearchHarness(page);
  await harness.install();
  await openDecisionResearch(page, "member");

  await expect(page.getByLabel("Codex 研究说明")).toContainText("Codex 研究由设备管理员运行");
  await expect(page.getByRole("heading", { name: "Codex 旅行研究" })).toHaveCount(0);
  expect(harness.calls.filter((call) => call.operation.startsWith("bridge.")).length).toBe(0);
});

test("an auth blocker creates a new run and resumes the same local research task", async ({ page }) => {
  const harness = new DecisionResearchHarness(page);
  await harness.install();
  await openDecisionResearch(page);
  await selectResearchTarget(page, "hotel");
  await page.getByRole("button", { name: "开始研究酒店候选" }).click();
  await expect.poll(() => harness.count("bridge.execute")).toBe(1);
  harness.blockForAuth();

  await expect(page.getByRole("alert")).toContainText("请在 ChatGPT/Codex 中恢复登录");
  await page.getByRole("button", { name: "已恢复登录，继续研究" }).click();
  await expect.poll(() => harness.count("bridge.resume")).toBe(1);
  expect(harness.inputs("bridge.execute")).toEqual([expect.objectContaining({ agentRunId: "agent-run-e2e-1" })]);
  expect(harness.inputs("bridge.resume")).toEqual([{
    agentRunId: "agent-run-e2e-2",
    researchTaskId: "research-task-e2e",
    resumeAction: "retry_codex_auth",
  }]);
  expect(harness.count("workspace.command")).toBe(2);
  expect(harness.count("bridge.claim")).toBe(2);
  expect(harness.inputs("bridge.claim")).toEqual([
    { agentRunId: "agent-run-e2e-1" },
    { agentRunId: "agent-run-e2e-2" },
  ]);
  harness.complete();
  await expect(page.getByRole("heading", { name: "海景行旅" })).toBeVisible();
});

test("a blocked external source exposes only the hostname and a fixed skip action", async ({ page }) => {
  const harness = new DecisionResearchHarness(page);
  await harness.install();
  await openDecisionResearch(page);
  await selectResearchTarget(page, "restaurant");
  await page.getByRole("button", { name: "开始研究餐厅候选" }).click();
  await expect.poll(() => harness.count("bridge.execute")).toBe(1);
  harness.blockForSource();

  await expect(page.getByRole("alert")).toContainText("booking.example.com");
  await expect(page.getByRole("button", { name: "跳过该来源并继续" })).toBeVisible();
  const agentPanel = page.getByRole("region", { name: "Codex 旅行研究" });
  await expect(agentPanel.getByRole("textbox")).toHaveCount(0);
  await expect(agentPanel.getByRole("searchbox")).toHaveCount(0);
  expect(await agentPanel.evaluate((element) => ({
    passwordInputs: Array.from(element.getElementsByTagName("input")).filter((input) => input.type === "password").length,
    editableElements: Array.from(element.getElementsByTagName("*")).filter((child) => (child as HTMLElement).isContentEditable).length,
  }))).toEqual({ passwordInputs: 0, editableElements: 0 });
  await page.getByRole("button", { name: "跳过该来源并继续" }).click();
  await expect.poll(() => harness.count("bridge.resume")).toBe(1);
  expect(harness.inputs("bridge.execute")).toEqual([expect.objectContaining({ agentRunId: "agent-run-e2e-1" })]);
  expect(harness.inputs("bridge.resume")).toEqual([{
    agentRunId: "agent-run-e2e-2",
    researchTaskId: "research-task-e2e",
    resumeAction: "skip_blocked_source",
  }]);
  expect(harness.count("workspace.command")).toBe(2);
  expect(harness.count("bridge.claim")).toBe(2);
  expect(harness.inputs("bridge.claim")).toEqual([
    { agentRunId: "agent-run-e2e-1" },
    { agentRunId: "agent-run-e2e-2" },
  ]);
  harness.complete();
  await expect(page.getByRole("heading", { name: "码头茶餐厅" })).toBeVisible();
});

test("a persisted source blocker is restored after the page reconnects", async ({ page }) => {
  const harness = new DecisionResearchHarness(page);
  await harness.install();
  await openDecisionResearch(page);
  await selectResearchTarget(page, "attraction");
  await page.getByRole("button", { name: "开始研究景点候选" }).click();
  await expect.poll(() => harness.count("bridge.execute")).toBe(1);
  harness.blockForSource("tickets.example.com");
  await expect(page.getByRole("alert")).toContainText("tickets.example.com");

  await page.evaluate(() => window.history.replaceState({}, "", "/decisions?__testDecisionAgent=1&__testDecisionAgentRole=admin"));
  await page.reload();

  await expect(page.getByRole("alert")).toContainText("tickets.example.com");
  await expect(page.getByRole("button", { name: "跳过该来源并继续" })).toBeVisible();
});

test("repeated start activation is idempotent", async ({ page }) => {
  const harness = new DecisionResearchHarness(page);
  await harness.install();
  await openDecisionResearch(page);
  await selectResearchTarget(page, "hotel");

  await page.getByRole("button", { name: "开始研究酒店候选" }).dblclick();

  await expect.poll(() => harness.count("bridge.execute")).toBe(1);
  expect(harness.count("workspace.command")).toBe(1);
  harness.beginResearching();
});

test("the fixture rejects repeated claims and mismatched task controls with safe errors", async ({ page }) => {
  const harness = new DecisionResearchHarness(page);
  await harness.install();
  await openDecisionResearch(page);
  await selectResearchTarget(page, "hotel");
  await page.getByRole("button", { name: "开始研究酒店候选" }).click();
  await expect.poll(() => harness.count("bridge.execute")).toBe(1);

  const results = await page.evaluate(async () => {
    const coordinator = (window as typeof window & {
      __decisionResearchHarnessCall: (call: unknown) => Promise<unknown>;
    }).__decisionResearchHarnessCall;
    return Promise.all([
      coordinator({ operation: "bridge.claim", input: { agentRunId: "agent-run-e2e-1" } }),
      coordinator({ operation: "bridge.resume", input: { agentRunId: "agent-run-e2e-1", researchTaskId: "wrong-task", resumeAction: "retry_codex_auth" } }),
      coordinator({ operation: "bridge.cancel", input: { researchTaskId: "wrong-task" } }),
    ]);
  });

  expect(results).toEqual([
    { ok: false, error: "AGENT_RUN_INACTIVE" },
    { ok: false, error: "AGENT_RUN_INACTIVE" },
    { ok: false, error: "AGENT_RUN_INACTIVE" },
  ]);
});

test("stopping an active research task leaves no generated candidate", async ({ page }) => {
  const harness = new DecisionResearchHarness(page);
  await harness.install();
  await openDecisionResearch(page);
  await selectResearchTarget(page, "hotel");
  await page.getByRole("button", { name: "开始研究酒店候选" }).click();
  await expect.poll(() => harness.count("bridge.execute")).toBe(1);
  harness.beginResearching();
  await page.getByRole("button", { name: "停止搜索" }).click();

  await expect(page.getByText("Codex 研究已停止")).toBeVisible();
  await expect(page.getByRole("heading", { name: "海景行旅" })).toHaveCount(0);
  expect(harness.count("bridge.cancel")).toBe(1);
  expect(harness.inputs("bridge.cancel")).toEqual([{ researchTaskId: "research-task-e2e" }]);
});

test("Codex unavailability keeps existing shared decisions visible", async ({ page }) => {
  const harness = new DecisionResearchHarness(page, { initialCandidates: ["hotel"], prepareError: "CODEX_NOT_AVAILABLE" });
  await harness.install();
  await openDecisionResearch(page);
  await expect(page.getByRole("heading", { name: "海景行旅" })).toBeVisible();
  await page.getByRole("radio", { name: /香港 2026-10-04/ }).check();
  await page.getByRole("radio", { name: /酒店/ }).check();
  await page.getByRole("button", { name: "准备本机 Codex" }).click();

  await expect(page.getByRole("alert")).toContainText("本机 Codex 暂未就绪");
  await expect(page.getByRole("heading", { name: "海景行旅" })).toBeVisible();
  expect(harness.count("workspace.command")).toBe(0);
});

test("the admin confirms the Codex scope and completes the signed local Bridge control loop", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Private Network Access is verified in Chromium");
  const { LocalAgentBridgeRuntime, canonicalJson, startLocalAgentBridge } = await loadBridgeModules();
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
      return Response.json({ ok: true, data: { agentRunId: body.agentRunId, claimedAt: "2026-08-31T00:00:00.000Z", expiresAt: "2099-08-31T00:15:00.000Z", nextSequence: 1 } });
    }
    return Response.json({ ok: true, action: "getDecisionContext", data: { tripId: "trip-2026-gba", preferences: [], candidates: [] } });
  };
  const runtime = new LocalAgentBridgeRuntime({ agentEndpoint: "https://api.example.test/api/agent", fetch: fetchImpl });
  const taskStatus = { phase: "researching" as const, researchTaskId: "research-task-e2e", startedAt: "2026-08-31T00:00:00.000Z", updatedAt: "2026-08-31T00:00:00.000Z" };
  let serverStatus: { phase: "idle" } | typeof taskStatus = { phase: "idle" };
  let decisionContext: unknown;
  const serverRuntime = {
    prepare: runtime.prepare.bind(runtime),
    claim: runtime.claim.bind(runtime),
    releaseUnboundClaim: runtime.releaseUnboundClaim.bind(runtime),
    executeTravelResearch: async () => {
      decisionContext = await runtime.getDecisionContext();
      serverStatus = taskStatus;
      return taskStatus;
    },
    getResearchStatus: async () => serverStatus,
    resumeTravelResearch: async () => taskStatus,
    cancelResearch: async () => ({ ...taskStatus, phase: "cancelled" as const, errorCode: "CODEX_RESEARCH_CANCELLED" as const }),
  };
  const bridge = await startLocalAgentBridge({ appUrl: "http://127.0.0.1:4173/?__testDecisionAgent=1", port: 0, runtime: serverRuntime, allowInsecureLoopbackApp: true });

  try {
    await page.goto(bridge.connectionUrl);
    await expect.poll(() => page.url()).not.toContain("#agentBridge=");
    await page.getByRole("button", { name: "共同决定" }).click();
    await page.getByRole("radio", { name: /香港 2026-10-04/ }).check();
    await page.getByRole("radio", { name: /酒店/ }).check();
    await page.getByRole("button", { name: "准备本机 Codex" }).click();
    await page.getByRole("checkbox", { name: /我确认以上授权范围/ }).check();
    await page.getByRole("button", { name: "开始研究酒店候选" }).click();
    await expect(page.getByText("正在请 Codex 搜索候选与可核验来源")).toBeVisible();
    expect(createdRun).toBeDefined();
    await expect.poll(() => decisionContext).toMatchObject({ tripId: "trip-2026-gba" });
    expect(consoleMessages.join("\n")).not.toContain(pairingCode);
  } finally {
    await bridge.close();
  }
});

test("a mismatched Origin cannot prepare or create an Agent authorization", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Private Network Access is verified in Chromium");
  const { startLocalAgentBridge } = await loadBridgeModules();
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
      releaseUnboundClaim: () => true,
      executeTravelResearch: async () => ({ phase: "idle" as const }),
      getResearchStatus: async () => ({ phase: "idle" as const }),
      resumeTravelResearch: async () => ({ phase: "idle" as const }),
      cancelResearch: async () => ({ phase: "idle" as const }),
    },
  });

  try {
    const url = new URL("http://127.0.0.1:4173/?__testDecisionAgent=1");
    url.hash = new URLSearchParams({ agentBridge: bridge.origin }).toString();
    await page.goto(url.toString());
    await expect.poll(() => page.url()).not.toContain("#agentBridge=");
    await page.getByRole("button", { name: "共同决定" }).click();

    await expect(page.getByRole("alert")).toHaveText("本机 Bridge 状态暂时无法读取，共同决定仍可正常使用。");
    await expect(page.getByRole("button", { name: "准备本机 Codex" })).toBeDisabled();
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

  await expect(page.getByText("本机 Bridge 未连接，已有共同决定仍可正常使用。")).toBeVisible();
  await expect(page.getByRole("button", { name: "准备本机 Codex" })).toHaveCount(0);
  expect(createCalls).toBe(0);
});
