---
title: '可运行的本地 Agent Bridge'
type: 'feature'
created: '2026-08-31'
status: 'done'
baseline_commit: 'd10b3d3ad6778d4a3c459560e1326b28f50881b9'
review_loop_iteration: 0
context:
  - 'bmad/docs/planning-artifacts/prds/prd-旅游计划-2026-08-28/prd.md'
  - 'bmad/docs/planning-artifacts/architecture/architecture-旅游计划-2026-08-28/ARCHITECTURE-SPINE.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Web 已有授权状态机和 loopback client，但生产入口未注入 Bridge，本地也没有运行时；`trip-api` 的平台 ACL 要求登录，无 bearer 的 Bridge 无法 claim 或发送签名命令。

**Approach:** 增加无依赖 Node Bridge，完成 P-256 配对、claim、顺序签名和上下文读取；Web 通过用后即删的 fragment 发现它。增加限流的公网 Agent transport，只接受既有签名 envelope；成员命令仍检查 CloudBase 身份。

## Boundaries & Constraints

**Always:** 私钥、pairing code、登录态和云凭据不跨信任边界；Bridge 固定绑定随机 `127.0.0.1` 端口并校验 Origin/Host/CORS/PNA/体积；丢响应原样重放，成功后才推进 sequence；公网入口复用既有验签、scope、事务和幂等。

**Ask First:** 改变 15 分钟时效、给 Bridge 任何成员/云凭据、允许非 loopback、添加依赖、真实部署或写真实旅行数据。

**Never:** 私钥或 pairing code 不进浏览器、DOM、URL、日志或磁盘；网页不能借 Bridge 代签任意命令；不做来源适配、交易、自动确认；不把 mock 称为生产 E2E；不编辑 `* 2.*`。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 启动 | 合法 app URL、origin、`--port 0` | 随机 loopback；连接 URL 不含秘密，Web 随即清除 fragment | 非 HTTPS app、通配 origin、非 loopback 拒绝启动 |
| 配对 | prepare 后提交 `agentRunId` | 内存生成 P-256/32-byte code，远端领取并保存 nextSequence | 丢响应复用同 nonce/code/签名 |
| 读取 | 已领取后 `getDecisionContext` | 串行 ES256 envelope；只返回该 trip 上下文 | 超时保留 envelope；篡改、跳号、撤销、过期拒绝 |
| 非法请求 | 错 Origin/Host/method/type/体积 | 不生成密钥、不访问远端 | 通用 4xx，不回显内部信息 |

</frozen-after-approval>

## Code Map

- `apps/local-agent-bridge/` -- Node 20 CLI、loopback HTTP、内存密钥、签名 transport；无三方依赖。
- `apps/web/src/main.tsx` / `app/BrowserRoot.tsx` -- 启动前取出并清除 Bridge fragment，稳定注入开发/生产 `TripApp`。
- `apps/web/src/infrastructure/localAgentBridgeClient.ts` -- 复用严格 loopback client，仅补预检所需行为。
- `functions/trip-api/index.js` / `cloudbaserc.json` -- 认证的 `trip-api/index.main` 与独立公开的 `agent-api/index.agentMain`；`/api/agent` 只路由 Agent action，网关限流。
- `scripts/check-production-config.mjs` / `.env.example` / `docs/operations/environment-setup.md` -- 校验并说明 endpoint、ACL、限流和启动参数。
- 对应 Node、Vitest、Playwright 测试 -- 覆盖真实 loopback、真实加密、Web 发现/CORS 和安全负例。

## Tasks & Acceptance

**Execution:**
- [x] 测试先行实现 Bridge HTTP、加密、重试、runtime 和 CLI。
- [x] 测试先行接通公网 Agent transport，并保证成员鉴权回归。
- [x] 测试先行完成 fragment 清除、生产注入和浏览器 loopback 检查。
- [x] 更新无秘密运行说明，区分本地、staging 与未执行的生产验证。

**Acceptance Criteria:**
- Given Web、Bridge 和测试 transport 在线，when 用户确认授权，then 真实 HTTP/ES256 链完成 prepare → create → claim → getDecisionContext，浏览器/日志无秘密。
- Given 匿名成员命令或无效 Agent envelope，when 到达公网入口，then 不访问旅行数据；已登录成员不回归。
- Given 成功响应丢失，when Bridge 重试，then 重放原结果且 sequence 不跳变。

## Design Notes

Fragment 只携带非机密 loopback origin，用后即删且不存储，刷新即断开。公网入口只让无 bearer 的 Bridge 到达既有签名协议，不扩大 scope。

## Verification

**Commands:**
- `node --test apps/local-agent-bridge/src/*.test.mjs` -- loopback、CORS/PNA、加密、重试通过。
- `node --test functions/trip-api/lib/decision-agent-bridge.test.js functions/trip-api/lib/commands.test.js functions/trip-api/index.test.js` -- Agent/成员权限回归通过。
- `pnpm --dir apps/web exec vitest run src/infrastructure/localAgentBridgeClient.test.ts src/app/BrowserRoot.test.tsx src/app/BrowserRootBridge.test.tsx` -- 发现、清除、开发/生产入口注入通过。
- `pnpm e2e e2e/decision-agent-bridge.spec.ts --project=chromium` -- 浏览器到真实 loopback；无 staging 不宣称生产 E2E。

## Spec Change Log

- 2026-08-31: 审查修正独立 `agent-api` 入口的 Code Map，并使定向 Vitest/Playwright 命令与实际入口和 CLI 语法一致；未改动 frozen intent。

## Suggested Review Order

**签名运行时与本机边界**

- 先看内存密钥、顺序签名、互斥与原样重试的核心状态机。
  [`runtime.mjs:46`](../../../apps/local-agent-bridge/src/runtime.mjs#L46)

- Loopback 服务严格限制随机端口、Origin、Host、PNA 与请求体。
  [`server.mjs:84`](../../../apps/local-agent-bridge/src/server.mjs#L84)

- CLI 只组装安全参数，并输出可人工核对的连接信息。
  [`cli.mjs:19`](../../../apps/local-agent-bridge/src/cli.mjs#L19)

**公网入口与云端验签**

- 独立 HTTP 适配器只接收完整 Agent envelope，隔离成员入口。
  [`index.js:79`](../../../functions/trip-api/index.js#L79)

- Claim 在读取旅行成员数据前完成签名、nonce 与配对校验。
  [`commands.js:1005`](../../../functions/trip-api/lib/commands.js#L1005)

- CloudBase 将公开 Agent 函数与认证成员函数分开并限流。
  [`cloudbaserc.json:43`](../../../cloudbaserc.json#L43)

**浏览器发现与授权接线**

- Fragment 用后即删，清除失败也不会阻断应用初始化。
  [`localAgentBridgeClient.ts:119`](../../../apps/web/src/infrastructure/localAgentBridgeClient.ts#L119)

- 开发和生产根入口显式注入同一个 Bridge 能力。
  [`BrowserRoot.tsx:198`](../../../apps/web/src/app/BrowserRoot.tsx#L198)

- 启动前消费连接材料，避免秘密或状态持久化。
  [`main.tsx:8`](../../../apps/web/src/main.tsx#L8)

**关键验证**

- 提交后丢响应仍只执行一次，并原样重放结果。
  [`runtime.test.mjs:224`](../../../apps/local-agent-bridge/src/runtime.test.mjs#L224)

- Chromium 通过语义控件走完真实 loopback 授权链。
  [`decision-agent-bridge.spec.ts:6`](../../../e2e/decision-agent-bridge.spec.ts#L6)
