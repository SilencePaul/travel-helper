---
title: 'Agent 交互控制闭环'
type: 'feature'
created: '2026-08-31'
status: 'done'
baseline_commit: 'bf8380f5703eca9bdd5798b37032660fdf9cf8ee'
review_loop_iteration: 0
context:
  - 'bmad/docs/planning-artifacts/prds/prd-旅游计划-2026-08-28/prd.md'
  - 'bmad/docs/planning-artifacts/architecture/architecture-旅游计划-2026-08-28/ARCHITECTURE-SPINE.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 后端已有签名 Agent 写回骨架，但 Web 没有启动、配对、查看状态和撤销入口；Agent 也无法读取受限决策上下文，网络丢响应后的 claim/命令不能稳定恢复。

**Approach:** 补齐成员可见的 AgentRun 安全投影、签名只读上下文、幂等重试和可靠撤销；Web 通过严格 loopback 客户端与 Desktop Bridge 交换非机密材料，并以旅行通行证视觉呈现授权、运行、阻断和停止状态。

## Boundaries & Constraints

**Always:** 浏览器只获得公钥、pairingCodeHash、指纹和 agentRunId；Bridge 地址必须是无 credentials 的 `http://127.0.0.1:<port>`；Agent 只读当前 trip 的共享上下文；撤销后立即拒绝新写入；保留现有签名规范、scope、sequence、幂等和事务语义。

**Ask First:** 更改 15 分钟时效、放弃 revoke CAS、新增公网 Agent HTTP 入口、改变 Desktop Bridge 部署方式，或需要新依赖。

**Never:** 在 Web、CloudBase、DOM 或日志中保存私钥、明文 pairingCode、Cookie 或服务凭据；不实现数据源适配、交易、多轮候选重构或全局过期策略；不编辑 `* 2.*` 副本。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 启动 | Bridge 在线，成员确认 scope | prepare → create → claim，页面显示 active 和过期时间 | 任一步失败不泄密，可原地重试 |
| 丢响应 | claim 或已提交命令的响应丢失 | 原 nonce/key/sequence 重试返回原结果 | 不同请求复用仍拒绝 |
| 撤销 | Agent 已 claim 并执行过命令 | 先读安全 revision，CAS 撤销成功 | 冲突返回安全 latest 并允许显式重试 |
| 需要接管 | Agent 遇到 login/captcha/risk control | workspace 保留标准原因，Web 显示人工接管提示 | 不标记 web_verified |
| Bridge 不在线/运行过期 | loopback 超时或 AgentRun 过期 | 共同决定其他功能仍可用 | 显示可恢复状态，禁止新 Agent 写入 |

</frozen-after-approval>

## Code Map

- `packages/contracts/src/decision.ts` -- 增加 AgentRun 安全投影、`getDecisionContext/getAgentRunStatus`、阻断原因和 warning 契约；与后端 Zod 定义同步。
- `functions/trip-api/lib/decision-agent-bridge.js` -- claim 幂等恢复；精确旧请求可在过期/撤销后重放，新请求仍拒绝。
- `functions/trip-api/lib/commands.js` -- 复用 workspace 投影实现 Agent context；提供 safe AgentRun 状态/CAS latest；持久化 verificationBlockReason。
- `functions/trip-api/index.js` -- 稳定 Agent 路由与响应 envelope，传出 `VERIFICATION_INCOMPLETE` warning。
- `apps/web/src/infrastructure/localAgentBridgeClient.ts` -- 严格 loopback URL、omit credentials、no-store、超时和响应 schema；只交换非机密字段。
- `apps/web/src/features/decisions/DecisionAgentPanel.tsx` -- 独立的准备、授权、连接、运行、过期和撤销 UI；复用全局 control 类和焦点规则。
- `apps/web/src/features/decisions/DecisionWorkspacePage.tsx` / `App.tsx` -- 注入 Bridge client 并挂载 panel。
- `apps/web/src/features/decisions/decisionWorkspaceAdapter.ts` -- 保留并展示标准阻断原因。
- `functions/trip-api/**/*.test.js`、`packages/contracts/src/decision.test.ts`、`apps/web/src/**/*Agent*.test.tsx` -- 生命周期与不泄密回归测试。

## Tasks & Acceptance

**Execution:**
- [x] contracts 与 trip-api -- 先添加生命周期、读取、重试、warning 和阻断原因测试，再实现最小兼容契约。
- [x] `localAgentBridgeClient.ts` / `DecisionAgentPanel.tsx` / 页面注入 -- 实现可中止的启动与撤销流程，请求和 UI 不泄露机密。
- [x] 适配器、panel 和样式 -- 显示阻断原因、Bridge 离线和可恢复状态，保持 320/390px、键盘与焦点语义。

**Acceptance Criteria:**
- Given Desktop Bridge 在线且成员确认 scope，when 启动 Agent，then Web 按 prepare/create/claim 顺序进入 active，且任何浏览器/服务端载荷均不含私钥或明文 pairingCode。
- Given Agent 已成功执行，when 响应丢失后原样重试，then 只返回原结果且不重复候选、证据或审计。
- Given Agent 已工作，when 成员查询安全状态并撤销，then 后续正确签名的新命令也被拒绝。
- Given Agent 报告验证码或风控，when 两位成员读取 workspace，then 都看到具体原因和人工接管指引，候选不是 web_verified。

## Spec Change Log

## Design Notes

Desktop Bridge 由本机 Agent 运行时提供，Web 只实现可注入 client 与状态机；Bridge 离线不影响已保存行程。安全投影不返回 JWK、hash 或 nonce。

## Verification

**Commands:**
- `node --test functions/trip-api/lib/decision-agent-bridge.test.js functions/trip-api/lib/commands.test.js functions/trip-api/index.test.js` -- Agent 生命周期与回归全绿。
- `pnpm --dir packages/contracts exec vitest run src/decision.test.ts` -- 新旧契约解析全绿。
- `pnpm --dir apps/web exec vitest run src/infrastructure/localAgentBridgeClient.test.ts src/features/decisions/DecisionAgentPanel.test.tsx src/features/decisions/DecisionWorkspacePage.test.tsx` -- 启动、失败、撤销、焦点与不泄密全绿。
- `pnpm typecheck && pnpm lint && pnpm build && pnpm test` -- 整库门禁通过；若 Web runner 仍停在 `RUN`，先以项目约定 LTS Node 复现并修复测试基础设施。

## Suggested Review Order

**用户控制闭环**

- 从完整授权、对账、过期和撤销状态机理解设计。
  [`DecisionAgentPanel.tsx:45`](../../../apps/web/src/features/decisions/DecisionAgentPanel.tsx#L45)

- 仅接受严格 loopback，并让超时覆盖完整响应体。
  [`localAgentBridgeClient.ts:33`](../../../apps/web/src/infrastructure/localAgentBridgeClient.ts#L33)

- 将 Agent 控制面独立挂入共同决定页。
  [`DecisionWorkspacePage.tsx:369`](../../../apps/web/src/features/decisions/DecisionWorkspacePage.tsx#L369)

**签名协议与权限边界**

- 让 claim 与命令在丢响应后安全精确恢复。
  [`decision-agent-bridge.js:53`](../../../functions/trip-api/lib/decision-agent-bridge.js#L53)

- 严格定义不含机密字段的 AgentRun 浏览器投影。
  [`decision.ts:198`](../../../packages/contracts/src/decision.ts#L198)

- 通过成员状态查询和签名上下文闭合撤销链路。
  [`commands.js:779`](../../../functions/trip-api/lib/commands.js#L779)

- 保持 Agent API envelope、warning 和路由稳定。
  [`index.js:65`](../../../functions/trip-api/index.js#L65)

**阻断接管体验**

- 将标准阻断原因持久化并随新证据清除。
  [`commands.js:962`](../../../functions/trip-api/lib/commands.js#L962)

- 把机器原因翻译为可行动的人类接管提示。
  [`decisionWorkspaceAdapter.ts:74`](../../../apps/web/src/features/decisions/decisionWorkspaceAdapter.ts#L74)

- 在候选票根中展示原因和下一步。
  [`DecisionWorkspaceShowcase.tsx:43`](../../../apps/web/src/features/decisions/DecisionWorkspaceShowcase.tsx#L43)

**验证与测试基础设施**

- 覆盖 claim 重签、撤销后重放与未知运行。
  [`decision-agent-bridge.test.js:91`](../../../functions/trip-api/lib/decision-agent-bridge.test.js#L91)

- 覆盖 UI 并发、取消对账、轮询和焦点恢复。
  [`DecisionAgentPanel.test.tsx:49`](../../../apps/web/src/features/decisions/DecisionAgentPanel.test.tsx#L49)

- 以完整生命周期验证重试不重复和撤销拒写。
  [`commands.test.js:856`](../../../functions/trip-api/lib/commands.test.js#L856)

- 隔离 PWA 插件，使 Web 测试稳定可退出。
  [`vitest.config.ts:4`](../../../apps/web/vitest.config.ts#L4)
