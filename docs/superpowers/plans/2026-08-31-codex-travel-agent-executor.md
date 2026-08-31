# Codex 旅行 Agent 执行器实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把本机已登录的 Codex 接入现有 Local Agent Bridge，让管理员针对一个连续同城市行程段和一个旅行类别启动、暂停、恢复或取消安全隔离的研究任务，并把 2–4 个同类候选及双来源证据原子写入共同决定。

**Architecture:** 保留现有 Web → loopback Bridge → 签名 Agent API → CloudBase 事务边界。新增一个 Web/Node 共用的无依赖研究投影模块；后端只返回最小安全上下文并强制管理员权限；Bridge 内部组合签名 transport、Codex 隔离 runner、研究状态机、最小持久化和本地通知。浏览器只能调用固定 execute/status/resume/cancel 能力，永远不能提交 prompt、URL、凭据或命令。

**Tech Stack:** React 19、TypeScript 6、Zod 4、Vitest、Playwright、Node.js 20+ ESM、Node `node:test`、CloudBase 事务、Codex CLI `0.151.0-alpha.7.2`、macOS Seatbelt permission profile。

---

## 范围与实施顺序

这是一个端到端安全功能，不拆成彼此独立的计划：共享投影是 Web/Bridge 指纹一致性的前置条件；后端上下文和权限是 Bridge 的前置条件；Bridge 固定端点是 Web 控制面的前置条件。实施严格按下列依赖顺序推进：

1. Codex 隔离能力门禁。
2. 共享研究契约与确定性投影。
3. 后端管理员权限、安全上下文、证据约束与 Agent 自撤销。
4. Bridge 签名 transport、输入/输出边界、Codex runner。
5. Bridge 状态机、持久化、通知和固定 loopback API。
6. Web 客户端、管理员控制面、普通成员只读说明。
7. 浏览器 E2E、全量回归和运行文档。

实现期间不运行真实 Codex，不消耗额度，不创建真实任务。真实认证、联网搜索和持久任务探针只在管理员实际点击启动时运行；任何探针失败都返回 `CODEX_ISOLATION_UNAVAILABLE`，不得降级。

## 已验证的 Codex CLI 约束

本机可执行文件为 `/Applications/ChatGPT.app/Contents/Resources/codex`。`--search`、`--sandbox`、`--ask-for-approval` 和 `--cd` 是顶层参数，必须放在 `exec` 之前；`--ignore-user-config`、`--ignore-rules`、`--json` 和 `--output-schema` 放在 `exec` 之后。错误的 `codex exec --search` 已验证会以退出码 2 失败。

受控权限配置使用 CLI `-c` 注入，不修改用户的 `~/.codex/config.toml`：

```text
permissions.travel_research.filesystem={":minimal"="read",":workspace_roots"="read"}
permissions.travel_research.network.enabled=true
default_permissions="travel_research"
```

当前版本的 `codex sandbox -P travel_research -C <isolated-dir>` 合成探针已经验证：隔离目录文件可读，项目文件和用户目录中的外部探针不可读，HTTPS 联网可用。实现仍需在每个真实启动前用相同配置执行 runner 级探针，并确认 JSONL、认证和任务持久化能力；只通过 `--sandbox read-only` 或只包一层外部 `sandbox-exec` 不算通过。预检使用 `codex doctor --json` 和 `codex sandbox`，不创建额外模型任务；实际研究任务的首个 `session_configured` 事件必须证明生效的是受控 restricted profile，最终还必须出现 web-search 事件和可持久化 thread ID，因此一次用户点击仍只创建一个 Codex 任务。

### Task 1: 建立 Codex 隔离与进程执行门禁

**Files:**

- Create: `apps/local-agent-bridge/src/codex-isolation.mjs`
- Create: `apps/local-agent-bridge/src/codex-isolation.test.mjs`
- Create: `apps/local-agent-bridge/src/codex-runner.mjs`
- Create: `apps/local-agent-bridge/src/codex-runner.test.mjs`
- Create: `apps/local-agent-bridge/src/codex-travel-output.schema.json`

- [ ] **Step 1: 写失败的权限 argv 和文件边界测试**

测试必须断言受控 argv 的顺序、固定配置和不可覆盖字段：

```js
assert.deepEqual(buildInitialArgs({ cwd: "/isolated", schemaPath: "/schema.json" }), [
  "--search",
  "--sandbox", "read-only",
  "--ask-for-approval", "never",
  "--cd", "/isolated",
  "--strict-config",
  "-c", 'permissions.travel_research.filesystem={":minimal"="read",":workspace_roots"="read"}',
  "-c", "permissions.travel_research.network.enabled=true",
  "-c", 'default_permissions="travel_research"',
  "exec",
  "--skip-git-repo-check",
  "--ignore-rules",
  "--ignore-user-config",
  "--json",
  "--output-schema", "/schema.json",
  "-",
]);
```

用注入的 fake `spawn` 验证 `shell: false`、绝对 Codex 路径、stdin prompt、最小环境、无 `--ephemeral`、无项目 cwd。用合成内外文件验证 profile 探针只允许 `:minimal` 和 `:workspace_roots`。

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test apps/local-agent-bridge/src/codex-isolation.test.mjs apps/local-agent-bridge/src/codex-runner.test.mjs`

Expected: FAIL，提示模块不存在。

- [ ] **Step 3: 实现 fail-closed 隔离检查**

`codex-isolation.mjs` 只导出以下固定职责：

```js
export const CODEX_ISOLATION_ERROR = "CODEX_ISOLATION_UNAVAILABLE";
export function discoverCodexExecutable(options = {}) { /* 只接受受控候选绝对路径 */ }
export function buildPermissionOverrides() { /* 返回上面的三个固定 -c 值 */ }
export async function probeCodexIsolation(options) { /* 内/外/项目/网络/认证/持久化逐项验证 */ }
export function minimalCodexEnvironment(source) { /* PATH、HOME、CODEX_HOME、locale 和系统代理白名单 */ }
```

环境过滤显式排除 `*TOKEN*`、`*SECRET*`、`*PASSWORD*`、`CLOUDBASE*`、`TENCENT*`、`AWS_*`、项目 `.env` 注入变量和 Bridge 配对/签名数据。真实探针失败、输出不完整或权限拒绝结果不确定时统一抛 `CODEX_ISOLATION_UNAVAILABLE`。

- [ ] **Step 4: 实现 Codex runner**

`codex-runner.mjs` 使用 `spawn(absoluteCodex, args, { shell: false, cwd: isolatedDir, env })`，解析 JSONL 中的 thread/task ID 和最终结构化响应。恢复 argv 复用同一组顶层安全参数，再调用：

```text
exec resume <codexThreadId> --skip-git-repo-check --ignore-rules --ignore-user-config --json --output-schema <schema> -
```

实现 10 分钟累计主动运行上限、`SIGTERM` 后 3 秒 `SIGKILL`、一次且仅一次同 thread 格式修正。把 Codex 未认证、额度不足、进程失败、超时、无效 JSONL 映射为稳定错误码，不保留原始日志。

- [ ] **Step 5: 运行测试并提交**

Run: `node --test apps/local-agent-bridge/src/codex-isolation.test.mjs apps/local-agent-bridge/src/codex-runner.test.mjs`

Expected: PASS；fake runner 精确捕获 argv、stdin、env、TERM/KILL 和 resume thread ID。

```bash
git add apps/local-agent-bridge/src/codex-isolation.mjs apps/local-agent-bridge/src/codex-isolation.test.mjs apps/local-agent-bridge/src/codex-runner.mjs apps/local-agent-bridge/src/codex-runner.test.mjs apps/local-agent-bridge/src/codex-travel-output.schema.json
git commit -m "feat: add fail-closed Codex isolation runner"
```

### Task 2: 增加 Web/Bridge 共用的研究投影与契约

**Files:**

- Create: `packages/contracts/src/decision-research.mjs`
- Create: `packages/contracts/src/decision-research.d.mts`
- Create: `packages/contracts/src/decision-research.test.ts`
- Modify: `packages/contracts/package.json`
- Modify: `packages/contracts/src/decision.ts`
- Modify: `packages/contracts/src/decision.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: 写失败的共享投影固定向量测试**

测试覆盖：连续同城合并、同城非连续停留拆分、固定排序、三种类别、成员姓名保留、UID/业务 ID 排除、资源 ID/revision 承诺变化导致 fingerprint 变化，以及 Node/Web Crypto 对同一固定向量得到同一 SHA-256。

```ts
expect(buildResearchTargetScopes(safeTrip)).toEqual([
  { targetScopeId: expect.any(String), city: "深圳", startDate: "2026-10-03", endDate: "2026-10-03", travelerCount: 2 },
  { targetScopeId: expect.any(String), city: "香港", startDate: "2026-10-04", endDate: "2026-10-06", travelerCount: 2 },
]);
const fixedDisclosure = {
  category: "hotel",
  segment: { city: "深圳", startDate: "2026-10-03", endDate: "2026-10-03", travelerCount: 2 },
  travelerNames: ["一鸣", "美垚"],
};
expect(await computeDisclosureFingerprint(fixedDisclosure)).toBe(
  "df062aeeb358e2fa0c60e5b90479c433e71f12a70def1b3f0579effd19805635",
);
```

该哈希对应规范 JSON `{"category":"hotel","segment":{"city":"深圳","endDate":"2026-10-03","startDate":"2026-10-03","travelerCount":2},"travelerNames":["一鸣","美垚"]}`，测试不得动态自证期望值。

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm --filter @travel/contracts exec vitest run src/decision-research.test.ts src/decision.test.ts`

Expected: FAIL，研究模块和 Schema 尚不存在。

- [ ] **Step 3: 实现运行时 subpath**

在 `packages/contracts/package.json` 增加 Node 20 和 Vite 都能加载的子路径：

```json
"./decision-research": {
  "types": "./src/decision-research.d.mts",
  "import": "./src/decision-research.mjs"
}
```

`decision-research.mjs` 保持 dependency-free，只导出规范 JSON、连续行程段、安全披露投影和异步 SHA-256。`decision-research.d.mts` 提供精确类型，不使用 `any`。

- [ ] **Step 4: 扩展严格 Zod 契约**

在 `decision.ts` 增加：

```ts
export const AgentTripProjectionSchema = z.object({
  version: z.number().int().nonnegative(),
  days: z.array(z.object({ id: z.string().min(1), date: z.string().date(), city: z.string() }).strict()),
  travelerNames: z.array(z.string()),
  travelerCount: z.number().int().positive(),
}).strict();

export const AgentDecisionContextSchema = z.object({
  workspace: DecisionWorkspaceSchema,
  trip: AgentTripProjectionSchema,
}).strict();
```

研究状态使用严格判别联合，阶段固定为 `idle/researching/needs_owner_action/resuming/superseded/validating/writing/completed/failed/cancelling/cancelled`；阻断原因只允许 `codex_auth_required/source_login_required/source_captcha/source_risk_control`；恢复动作只允许 `retry_codex_auth/skip_blocked_source`。`ResearchStatus` 不含 Codex thread ID、日志、prompt、路径或上下文。

研究错误码固定为 `CODEX_NOT_AVAILABLE/CODEX_NOT_AUTHENTICATED/CODEX_ISOLATION_UNAVAILABLE/CODEX_USAGE_UNAVAILABLE/CODEX_RESEARCH_TIMEOUT/CODEX_OUTPUT_INVALID/CODEX_INSUFFICIENT_EVIDENCE/INVALID_RESEARCH_TARGET/DISCLOSURE_CONTEXT_CHANGED/CODEX_RESEARCH_CANCELLED/AGENT_RUN_INACTIVE/AGENT_TRANSPORT_UNAVAILABLE/CODEX_RESEARCH_FAILED`。

把 `createAgentRun.scope` 改成 `z.tuple([z.literal("submitProposalBatch")])`。把候选批次使用的证据派生为严格 `AgentProposalEvidenceInputSchema`，要求 `sourceUrl` 必填且为 HTTPS，再把 `AgentProposalCandidateInputSchema.evidence` 收紧为 `.min(2)`；保留其他人工/追加证据场景中可选 URL 的现有契约。`getDecisionContext` 结果改为 `AgentDecisionContext`，claim 成功结果加入 `expiresAt`，新增签名控制动作 `revokeAgentRunSelf` 及其成功结果，但不把它加入 `AgentScopeSchema`。`DecisionCommandFailure` 同步加入既有后端会返回的 `ADMIN_REQUIRED`，公开适配器只能返回这一稳定枚举。

- [ ] **Step 5: 更新依赖并运行测试**

Run: `pnpm install --lockfile-only`

Run: `pnpm --filter @travel/contracts exec vitest run src/decision-research.test.ts src/decision.test.ts`

Expected: PASS。

```bash
git add packages/contracts/package.json packages/contracts/src/decision-research.mjs packages/contracts/src/decision-research.d.mts packages/contracts/src/decision-research.test.ts packages/contracts/src/decision.ts packages/contracts/src/decision.test.ts packages/contracts/src/index.ts pnpm-lock.yaml
git commit -m "feat: add shared travel research contracts"
```

### Task 3: 收紧后端管理员权限并返回最小安全上下文

**Files:**

- Modify: `functions/trip-api/lib/commands.js`
- Modify: `functions/trip-api/lib/commands.test.js`
- Modify: `functions/trip-api/lib/decision-agent-bridge.js`
- Modify: `functions/trip-api/lib/decision-agent-bridge.test.js`
- Modify: `functions/trip-api/index.js`
- Modify: `functions/trip-api/index.test.js`

- [ ] **Step 1: 先把旧的“member 可控制 AgentRun”测试反转**

新增/修改测试断言：

- 普通成员 create/status/revoke 返回 `ADMIN_REQUIRED`。
- 管理员可以 create/status/revoke，且 scope 必须精确等于 `['submitProposalBatch']`。
- 创建后、claim 前管理员被降权时 claim 失败。
- claim 后管理员被降权时 context 和 submit 均失败；`revokeAgentRunSelf` 仍允许执行，以便立即收回已存在的能力。
- 无效签名仍在读取 trip/member 之前被拒绝。

- [ ] **Step 2: 写安全 Trip context 和证据约束测试**

断言 `getDecisionContext` 返回 `workspace + trip`，保留日程 ID/日期/城市、同行者姓名和人数；序列化后的 `trip` 投影不包含 member UID、traveler ID、item ID、hotel ID、订单、密钥或配对材料。姓名统一取 `trip.travelers[].name`，避免 Web 端无法取得另一位成员资料时产生不同 fingerprint；偏好按匿名稳定顺序展示，不猜测 traveler ID 与 preference owner UID 的对应关系。

候选批次测试改为每个候选两条不同 HTTPS origin 的证据，并新增同 origin 不同路径、大小写 hostname、默认 443 端口绕过去重均被拒绝且数据库零写入。

- [ ] **Step 3: 运行后端测试并确认失败**

Run: `node --test functions/trip-api/lib/decision-agent-bridge.test.js functions/trip-api/lib/commands.test.js functions/trip-api/index.test.js`

Expected: FAIL，现有后端仍允许普通成员，context 仍为裸 workspace。

- [ ] **Step 4: 实现管理员检查与安全投影**

在 `commands.js` 增加：

```js
async function assertTripAdmin(transaction, tripId, actorUid) {
  const trip = await assertTripMember(transaction, tripId, actorUid);
  const actor = await getActor(transaction, actorUid);
  if (actor.role !== "admin") throw codedError("ADMIN_REQUIRED");
  return { trip, actor };
}
```

create/status/revoke、claim `beforeCommit`、context 和 proposal submit 都复核 run creator 仍是管理员。创建只接受唯一 scope `submitProposalBatch`。`safeAgentTrip` 单独白名单组装 `trip.travelers[].name`、人数和日期/城市/day ID，不读取或返回 `memberUids` 对应的成员记录。

- [ ] **Step 5: 实现签名自撤销和 claim 截止时间**

`decision-agent-bridge.js` 的 claimResult 增加 `expiresAt`。`revokeAgentRunSelf` 使用现有 signature、sequence、idempotency 和完全相同 envelope 重放规则；它是控制动作，不受 run scope 控制。提交事务将 run 置为 `revoked` 并推进 sequence/revision，响应只返回 `agentRunId/revokedAt`。

阻断、取消或完成时 Bridge 先重复同一自撤销 envelope 直到取得确定响应或 run 到期。若进程崩溃，私钥只在内存且随进程消失，不在恢复存储中保存私钥或签名 envelope。

- [ ] **Step 6: 实现后端双来源防线并运行测试**

后端 duplicated Zod schema 同步 `.min(2)`、HTTPS、strict 字段；`submitProposalBatch` 在写任何记录前归一化 origin 并验证每个候选至少两个不同 origin。全部验证通过后才进入现有 CloudBase transaction 写入循环。

Run: `node --test functions/trip-api/lib/decision-agent-bridge.test.js functions/trip-api/lib/commands.test.js functions/trip-api/index.test.js`

Expected: PASS。

```bash
git add functions/trip-api/lib/commands.js functions/trip-api/lib/commands.test.js functions/trip-api/lib/decision-agent-bridge.js functions/trip-api/lib/decision-agent-bridge.test.js functions/trip-api/index.js functions/trip-api/index.test.js
git commit -m "feat: secure admin-only Agent research backend"
```

### Task 4: 扩展 Bridge 签名 transport

**Files:**

- Modify: `apps/local-agent-bridge/package.json`
- Modify: `apps/local-agent-bridge/src/runtime.mjs`
- Modify: `apps/local-agent-bridge/src/runtime.test.mjs`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: 写失败的固定 scope、截止时间和自撤销测试**

测试断言：`prepare()` 不再接受浏览器提供的任意 scope，只生成 `submitProposalBatch` 材料；claim 保存并暴露安全的 `expiresAt` getter；`revokeSelf()` 是内部固定动作；丢失响应时重发完全相同签名 envelope；确定失败时清理 pending envelope。

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test apps/local-agent-bridge/src/runtime.test.mjs`

Expected: FAIL，runtime 仍接受多 scope 且没有 self-revoke/expiry。

- [ ] **Step 3: 实现最小修改**

保留现有 P-256、canonical JSON、sequence 和互斥锁。把公开 prepare 改成无参数固定 scope；`command()` 仍仅供 executor 内部使用，绝不从 HTTP 接受 action。增加：

```js
get claimedRun() {
  return this.#claimed && { ...this.#claimed };
}

async revokeSelf() {
  return this.command("revokeAgentRunSelf", {});
}
```

在 `apps/local-agent-bridge/package.json` 加入 `@travel/contracts: workspace:*`，只从 `@travel/contracts/decision-research` 运行时子路径导入纯函数，不让 Node 加载 `.ts` 根导出。

- [ ] **Step 4: 更新 lockfile、运行测试并提交**

Run: `pnpm install --lockfile-only`

Run: `node --test apps/local-agent-bridge/src/runtime.test.mjs`

Expected: PASS。

```bash
git add apps/local-agent-bridge/package.json apps/local-agent-bridge/src/runtime.mjs apps/local-agent-bridge/src/runtime.test.mjs pnpm-lock.yaml
git commit -m "feat: constrain Bridge Agent transport"
```

### Task 5: 实现研究输入、别名和严格输出校验

**Files:**

- Create: `apps/local-agent-bridge/src/travel-research-input.mjs`
- Create: `apps/local-agent-bridge/src/travel-research-input.test.mjs`
- Create: `apps/local-agent-bridge/src/travel-research-output.mjs`
- Create: `apps/local-agent-bridge/src/travel-research-output.test.mjs`

- [ ] **Step 1: 写输入过滤和 alias 测试**

覆盖：成员姓名保留；UID、traveler ID、原始 preference/feedback/candidate ID、凭据、本机路径被剔除；同 `aliasSalt + 类型 + ID + revision` 重启后得到同 alias；不同 salt 不同；未知/旧 revision/错类型 alias 无法回映；prompt injection 只进入 JSON 数据块。

```js
const alias = hmacAlias(aliasSalt, "preference", preference.id, preference.revision);
assert.match(alias, /^pref_[A-Za-z0-9_-]{32}$/);
assert.equal(JSON.stringify(codexInput).includes("fs_admin"), false);
```

- [ ] **Step 2: 写输出拒绝矩阵测试**

覆盖 2–4 同类候选、至少两条证据、两个归一化 HTTPS origin、日期/人数匹配、alias 子集、严格字段、文本/数组上限、秘密模式、禁止 userinfo/fragment、禁止 AgentRun/signature/sequence/idempotency 字段。

- [ ] **Step 3: 运行测试并确认失败**

Run: `node --test apps/local-agent-bridge/src/travel-research-input.test.mjs apps/local-agent-bridge/src/travel-research-output.test.mjs`

Expected: FAIL，模块不存在。

- [ ] **Step 4: 实现安全输入和固定 prompt**

`travel-research-input.mjs` 使用 `HMAC-SHA-256(aliasSalt, type + "\0" + id + "\0" + revision)`。只从最新签名 `AgentDecisionContext` 构建选定 segment、类别、姓名、已完成偏好、当前摘要、相关反馈和已有候选公开摘要。Bridge 计算 `round = max(existing round) + 1`，Codex 不生成 round/capturedAt/签名/幂等字段。

固定 prompt 把系统约束和 `UNTRUSTED_TRAVEL_DATA` JSON 块分开，明确数据内容不能更改指令。浏览器输入永远不拼入 prompt。

- [ ] **Step 5: 实现第二层输出校验**

`travel-research-output.mjs` 先校验固定 JSON shape，再按类别、segment、别名映射和 URL 规则校验；使用 `new URL()` 归一化 `https://hostname[:non-default-port]`，默认 443、hostname 大小写和路径差异不产生新 origin。成功后才补可信 `capturedAt`、round 和云端 `submitProposalBatch` payload。

- [ ] **Step 6: 运行测试并提交**

Run: `node --test apps/local-agent-bridge/src/travel-research-input.test.mjs apps/local-agent-bridge/src/travel-research-output.test.mjs`

Expected: PASS。

```bash
git add apps/local-agent-bridge/src/travel-research-input.mjs apps/local-agent-bridge/src/travel-research-input.test.mjs apps/local-agent-bridge/src/travel-research-output.mjs apps/local-agent-bridge/src/travel-research-output.test.mjs
git commit -m "feat: validate Codex travel research boundary"
```

### Task 6: 实现最小恢复存储和 macOS 通知

**Files:**

- Create: `apps/local-agent-bridge/src/research-state-store.mjs`
- Create: `apps/local-agent-bridge/src/research-state-store.test.mjs`
- Create: `apps/local-agent-bridge/src/macos-notifier.mjs`
- Create: `apps/local-agent-bridge/src/macos-notifier.test.mjs`

- [ ] **Step 1: 写失败的权限、原子写和隐私测试**

测试用临时目录断言目录 mode `0700`、文件 mode `0600`、同目录临时文件 `rename`、完成/取消删除。允许字段只有：

```js
[
  "researchTaskId", "codexThreadId", "targetCategory", "targetScopeId",
  "disclosureFingerprint", "aliasSalt", "blockedReason", "blockedHostname",
  "activeRuntimeMs", "phase", "startedAt", "updatedAt"
]
```

序列化结果不得含姓名、城市、日期、偏好、候选、prompt、输出、UID、凭据、Agent 私钥或 pairing code。

- [ ] **Step 2: 写通知一次性和固定文案测试**

注入 fake spawn，断言每个新阻断 transition 只调用一次绝对 `/usr/bin/osascript`，`shell:false`，参数中只有固定标题“旅行 Agent 需要你处理”和正文“请打开共同决定页面查看”。失败不改变状态也不抛给调用者。

- [ ] **Step 3: 运行测试并确认失败**

Run: `node --test apps/local-agent-bridge/src/research-state-store.test.mjs apps/local-agent-bridge/src/macos-notifier.test.mjs`

Expected: FAIL，模块不存在。

- [ ] **Step 4: 实现并运行测试**

store 在应用数据目录中保存单个当前可恢复任务；启动时只读取严格白名单并拒绝额外字段。先持久化 `needs_owner_action`，再触发通知；重启读取已有阻断状态不重复触发通知。

Run: `node --test apps/local-agent-bridge/src/research-state-store.test.mjs apps/local-agent-bridge/src/macos-notifier.test.mjs`

Expected: PASS。

```bash
git add apps/local-agent-bridge/src/research-state-store.mjs apps/local-agent-bridge/src/research-state-store.test.mjs apps/local-agent-bridge/src/macos-notifier.mjs apps/local-agent-bridge/src/macos-notifier.test.mjs
git commit -m "feat: persist safe research recovery state"
```

### Task 7: 组合旅行研究状态机

**Files:**

- Create: `apps/local-agent-bridge/src/travel-research-service.mjs`
- Create: `apps/local-agent-bridge/src/travel-research-service.test.mjs`
- Modify: `apps/local-agent-bridge/src/runtime.mjs`
- Modify: `apps/local-agent-bridge/src/runtime.test.mjs`

- [ ] **Step 1: 写完整 happy-path 集成测试**

使用 fake Codex runner 和 fake cloud transport 验证：`prepare → claim → execute → getDecisionContext → fingerprint/segment recheck → researching → validating → writing → submitProposalBatch → revokeSelf → completed`。点击 execute 之前云端只发生 prepare/claim，不产生 Codex 子进程；同 AgentRun 并发 execute 只产生一个子进程。

- [ ] **Step 2: 写阻断、恢复、取消和超时测试**

覆盖：

- Codex auth/source login/captcha/risk control 进入 `needs_owner_action`，零候选写入，先 self-revoke 后持久化和通知。
- resume 必须使用新的已 claim AgentRun、原 `researchTaskId` 和原 Codex thread；只接受两个固定 resumeAction。
- fingerprint 变化进入 `superseded`，清理恢复元数据，不 resume 旧 thread。
- 证据不足只在剩余主动时间内继续搜索；用尽后 `CODEX_INSUFFICIENT_EVIDENCE`。
- 取消、run 过期/撤销、Codex 无法启动、无效输出、格式修正失败均零写入。
- 云端提交响应丢失时重发完全相同 envelope，候选只写一次。
- 等待管理员时间不计入 10 分钟主动时间。

- [ ] **Step 3: 运行测试并确认失败**

Run: `node --test apps/local-agent-bridge/src/travel-research-service.test.mjs`

Expected: FAIL，service 不存在。

- [ ] **Step 4: 实现单任务状态机**

`TravelResearchService` 构造器只接受注入依赖：`transport/runner/store/notifier/clock/idGenerator`。公开方法固定为：

```js
prepare()
claim(agentRunId)
executeTravelResearch({ agentRunId, targetCategory, targetScopeId, disclosureFingerprint })
getResearchStatus()
resumeTravelResearch({ agentRunId, researchTaskId, resumeAction })
cancelResearch({ researchTaskId })
```

execute/resume 在调用 Codex 前都重新签名读取最新上下文、重算 segment 和 disclosure fingerprint。状态响应经过独立 `safeResearchStatus()` 白名单，不返回 `codexThreadId`。

- [ ] **Step 5: 运行 Bridge 全部测试并提交**

Run: `node --test apps/local-agent-bridge/src/*.test.mjs`

Expected: PASS。

```bash
git add apps/local-agent-bridge/src/travel-research-service.mjs apps/local-agent-bridge/src/travel-research-service.test.mjs apps/local-agent-bridge/src/runtime.mjs apps/local-agent-bridge/src/runtime.test.mjs
git commit -m "feat: orchestrate persistent travel research"
```

### Task 8: 暴露四个固定 loopback 端点

**Files:**

- Modify: `apps/local-agent-bridge/src/server.mjs`
- Modify: `apps/local-agent-bridge/src/server.test.mjs`
- Modify: `apps/local-agent-bridge/src/cli.mjs`
- Modify: `apps/local-agent-bridge/src/cli.test.mjs`

- [ ] **Step 1: 写严格路由矩阵测试**

允许且仅允许：

```text
POST /v1/agent-runs/prepare
POST /v1/agent-runs/claim
POST /v1/agent-runs/execute-travel-research
GET  /v1/agent-runs/research-status
POST /v1/agent-runs/resume-travel-research
POST /v1/agent-runs/cancel-research
OPTIONS 上述路径
```

execute body 精确四字段；resume 精确三字段；cancel 精确 task ID；status 无 body/query。额外 prompt、URL、hostname、Cookie、验证码、命令、模型、sandbox 或 action 字段全部 400。

prepare 的请求体精确为 `{}`；scope 不再由浏览器提交。claim 请求体仍精确为 `{agentRunId}`，私钥与 pairing code 继续只存在 Bridge 内存中。

- [ ] **Step 2: 写错误投影与旧防线回归测试**

稳定业务错误返回 `{ok:false,error:<enum>}`，不返回 detail/stack/log。保留 Host、Origin、PNA、content-type、method、body-size、slow body、no-store 和 strict 127.0.0.1 防线。GET status 的 CORS `allow-methods` 包含 GET。

- [ ] **Step 3: 运行测试并确认失败**

Run: `node --test apps/local-agent-bridge/src/server.test.mjs apps/local-agent-bridge/src/cli.test.mjs`

Expected: FAIL，新路径尚未实现。

- [ ] **Step 4: 实现路由和 CLI 组合根**

`server.mjs` 使用 pathname + method 映射，不开放通用 runtime 方法。`cli.mjs` 组合 `LocalAgentBridgeRuntime`、`CodexTravelRunner`、store、notifier 和 `TravelResearchService`；命令行仍只接受 `--app-url/--agent-endpoint/--port 0`，不接受模型、prompt、Codex 账号或权限覆盖。

- [ ] **Step 5: 运行测试并提交**

Run: `node --test apps/local-agent-bridge/src/*.test.mjs`

Expected: PASS。

```bash
git add apps/local-agent-bridge/src/server.mjs apps/local-agent-bridge/src/server.test.mjs apps/local-agent-bridge/src/cli.mjs apps/local-agent-bridge/src/cli.test.mjs
git commit -m "feat: expose fixed travel research loopback API"
```

### Task 9: 扩展 Web loopback 客户端

**Files:**

- Modify: `apps/web/src/infrastructure/localAgentBridgeClient.ts`
- Modify: `apps/web/src/infrastructure/localAgentBridgeClient.test.ts`

- [ ] **Step 1: 写四个方法的失败测试**

测试精确 method/path/body、prepare body 精确为 `{}`、GET status 无 body、`credentials: omit`、`cache: no-store`、abort/timeout 覆盖 body 读取、严格响应拒绝额外日志/URL/凭据字段，以及非 2xx 稳定错误码保留。

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm --dir apps/web exec vitest run src/infrastructure/localAgentBridgeClient.test.ts`

Expected: FAIL，接口只有 prepare/claim。

- [ ] **Step 3: 实现固定客户端方法**

```ts
interface LocalAgentBridge {
  prepare(options?: RequestOptions): Promise<PreparedAgentRun>;
  claim(agentRunId: string, options?: RequestOptions): Promise<LocalAgentClaim>;
  executeTravelResearch(input: ExecuteTravelResearchInput, options?: RequestOptions): Promise<ResearchStatus>;
  getResearchStatus(options?: RequestOptions): Promise<ResearchStatus>;
  resumeTravelResearch(input: ResumeTravelResearchInput, options?: RequestOptions): Promise<ResearchStatus>;
  cancelResearch(input: CancelResearchInput, options?: RequestOptions): Promise<ResearchStatus>;
}
```

增加 `LocalAgentBridgeError.code`，只接受 Contracts 中列出的稳定错误；服务端错误 body 含额外字段时按 `INVALID_BRIDGE_RESPONSE` 拒绝。

- [ ] **Step 4: 运行测试并提交**

Run: `pnpm --dir apps/web exec vitest run src/infrastructure/localAgentBridgeClient.test.ts`

Expected: PASS。

```bash
git add apps/web/src/infrastructure/localAgentBridgeClient.ts apps/web/src/infrastructure/localAgentBridgeClient.test.ts
git commit -m "feat: add fixed travel research Bridge client"
```

### Task 10: 实现管理员控制面与普通成员说明

**Files:**

- Create: `apps/web/src/features/decisions/DecisionAgentMemberNotice.tsx`
- Create: `apps/web/src/features/decisions/DecisionResearchDisclosure.tsx`
- Modify: `apps/web/src/features/decisions/DecisionAgentPanel.tsx`
- Modify: `apps/web/src/features/decisions/DecisionAgentPanel.test.tsx`
- Modify: `apps/web/src/features/decisions/DecisionWorkspacePage.tsx`
- Modify: `apps/web/src/features/decisions/DecisionWorkspacePage.test.tsx`
- Modify: `apps/web/src/features/decisions/decisionWorkspace.css`
- Modify: `apps/web/src/AppDecisionRoute.test.tsx`

- [ ] **Step 1: 先写角色分流测试**

管理员挂载控制面；普通成员即使收到 bridge，也只看到“Codex 研究由设备管理员运行，完成后候选会出现在共同决定中”，并且 prepare/status/execute/resume/cancel 全部零调用。普通成员仍可看到候选并使用反馈/共同确认。

- [ ] **Step 2: 写准备、目标和 disclosure 测试**

覆盖：prepare 不创建 AgentRun；scope 固定 `submitProposalBatch`；多 segment 必须选择；类别必须显式选择；展开显示 segment、类别、成员姓名、双方已完成偏好、共同摘要、相关反馈、已有候选摘要和本机 Codex 历史提示；commitment 不渲染；未确认不可开始；workspace/trip 投影变化立即清除确认。

- [ ] **Step 3: 写启动和阶段测试**

严格顺序为 create → claim → execute；execute body 只有四字段；重复点击只启动一次。覆盖 researching/resuming/validating/writing/completed/failed 的可访问文案、busy 状态和按钮。completed 调用父级 refresh，让候选立即出现。

- [ ] **Step 4: 写阻断、恢复、superseded 和取消测试**

认证阻断只显示“请在 ChatGPT/Codex 中恢复登录”；来源阻断只显示清洗 hostname；页面无凭据输入。resume 先 prepare/create/claim 新 run，再用旧 `researchTaskId` 调固定动作。fingerprint 不变不重复确认；变化则 superseded、清除确认且不 resume。停止顺序为 local cancel → 状态对账 → 云端 revoke；writing 响应不确定时不宣称取消成功。

- [ ] **Step 5: 运行测试并确认失败**

Run: `pnpm --dir apps/web exec vitest run src/features/decisions/DecisionAgentPanel.test.tsx src/features/decisions/DecisionWorkspacePage.test.tsx src/AppDecisionRoute.test.tsx`

Expected: FAIL，现有面板仍是旧授权状态机且普通成员可挂载。

- [ ] **Step 6: 实现组件和状态拆分**

`DecisionWorkspacePage` 做硬分流：

```tsx
{member.role === "admin"
  ? <DecisionAgentPanel
      repository={repository}
      bridge={agentBridge}
      trip={trip}
      workspace={workspace}
      onResearchCompleted={refreshAfterResearch}
      newIdempotencyKey={newIdempotencyKey}
    />
  : <DecisionAgentMemberNotice />}
```

面板把 `operation`、当前云端 `run`、本机 `researchStatus` 分开，避免旧 run 在 blocker 时已撤销却把持久 Codex 任务错误显示成“已停止”。重新打开 connection URL 后先 `getResearchStatus()` 恢复阻断状态，运行态使用无重叠轮询并在 unmount/角色/trip/bridge 变化时 abort。

- [ ] **Step 7: 统一视觉和可访问性**

继续使用 `control-button--primary/secondary/danger/text`，不新增按钮体系。目标用语义 `fieldset/legend/radio`，唯一授权 checkbox 有完整 label；进度 `role=status`，阻断/superseded/failed `role=alert`；错误后 focus 到恢复动作。320px 下动作满宽、控件至少 44px、不横向溢出。

- [ ] **Step 8: 运行 Web 测试并提交**

Run: `pnpm --dir apps/web exec vitest run src/features/decisions/DecisionAgentPanel.test.tsx src/features/decisions/DecisionWorkspacePage.test.tsx src/AppDecisionRoute.test.tsx`

Expected: PASS。

```bash
git add apps/web/src/features/decisions/DecisionAgentMemberNotice.tsx apps/web/src/features/decisions/DecisionResearchDisclosure.tsx apps/web/src/features/decisions/DecisionAgentPanel.tsx apps/web/src/features/decisions/DecisionAgentPanel.test.tsx apps/web/src/features/decisions/DecisionWorkspacePage.tsx apps/web/src/features/decisions/DecisionWorkspacePage.test.tsx apps/web/src/features/decisions/decisionWorkspace.css apps/web/src/AppDecisionRoute.test.tsx
git commit -m "feat: add admin-only Codex research controls"
```

### Task 11: 扩展浏览器测试夹具与端到端闭环

**Files:**

- Create: `e2e/fixtures/decisionResearchHarness.ts`
- Modify: `apps/web/src/app/BrowserRoot.tsx`
- Modify: `e2e/decision-agent-bridge.spec.ts`

- [ ] **Step 1: 写 dev-only 可脚本化夹具**

增加 `__testDecisionAgentRole=admin|member`，脚本化 create/revoke/status/workspace refresh、研究 phase 和候选原子写回。夹具只在 `import.meta.env.DEV && __testDecisionAgent=1` 生效，生产 bundle 路径不接收测试 coordinator。

- [ ] **Step 2: 写核心 Chromium E2E**

至少覆盖：管理员确认后才 create，最终候选出现；三类别不混合；多城市选段；确认后数据变化导致重新确认且不启动 Codex；普通成员 loopback 调用为零；auth blocker → 新 run → 同 task resume；来源 blocker → skip；关闭并重连后 blocker 仍存在；重复点击；停止后无候选；Codex unavailable 不影响既有共同决定。

保留现有 Origin 不匹配、非 loopback fragment、PNA 防线测试。定位器只用 role/label/text，不用固定 sleep。

- [ ] **Step 3: 运行 Chromium 并修到通过**

Run: `pnpm exec playwright test e2e/decision-agent-bridge.spec.ts --project=chromium`

Expected: PASS。

- [ ] **Step 4: 运行移动视口并修到通过**

Run: `pnpm exec playwright test e2e/decision-agent-bridge.spec.ts --project=iphone-15`

Expected: PASS；Bridge/PNA 专属用例按现有条件跳过，纯 UI/角色/布局用例通过。

```bash
git add e2e/fixtures/decisionResearchHarness.ts apps/web/src/app/BrowserRoot.tsx e2e/decision-agent-bridge.spec.ts
git commit -m "test: cover Codex travel research end to end"
```

### Task 12: 更新运行文档并执行全量验收

**Files:**

- Modify: `docs/operations/environment-setup.md`
- Modify: `docs/superpowers/specs/2026-08-31-codex-travel-agent-executor-design.md`

- [ ] **Step 1: 更新本地运行和安全门禁说明**

文档写明：只使用设备所有者现有 Codex 登录；项目没有登录/切换账号入口；普通成员不登录；启动真实任务会消耗额度并进入本机历史；隔离失败不降级；外部来源阻断不传 Cookie/密码/验证码；真实 smoke 仍需单独批准。

- [ ] **Step 2: 运行分层验证**

Run: `pnpm --filter @travel/contracts test`

Expected: PASS。

Run: `node --test functions/trip-api/lib/decision-agent-bridge.test.js functions/trip-api/lib/commands.test.js functions/trip-api/index.test.js`

Expected: PASS。

Run: `pnpm --filter @travel/local-agent-bridge test`

Expected: PASS，且没有真实 Codex 子进程。

Run: `pnpm --dir apps/web test`

Expected: PASS。

- [ ] **Step 3: 运行静态检查和完整回归**

Run: `pnpm -r typecheck && pnpm -r lint && pnpm -r build`

Expected: PASS。

Run: `pnpm test:backend`

Expected: PASS。

Run: `pnpm exec playwright test e2e/decision-agent-bridge.spec.ts`

Expected: Chromium 与 iPhone 项目均通过各自适用用例。

- [ ] **Step 4: 安全扫描和人工差异审查**

Run: `rg -n "TODO|TBD|pairingCode|privateKey|Authorization|Cookie|password|captcha|agentRunId|codexThreadId" apps/local-agent-bridge apps/web/src/features/decisions apps/web/src/infrastructure packages/contracts/src functions/trip-api`

Expected: 没有 TODO/TBD；秘密字段只出现在既有签名边界和明确的拒绝/测试断言中；Web 状态不出现 `codexThreadId`；没有凭据输入控件或自由 prompt API。

Run: `git diff --check && git status --short`

Expected: 无空白错误；只包含本计划范围内改动，既有未跟踪 BMAD/冲突副本保持不动。

- [ ] **Step 5: 更新规格状态并提交文档**

只有自动测试、类型、lint、build 和 E2E 全部通过后，把规格状态改为“已实施，真实 Codex 冒烟待单独批准”。不得把 fake runner 测试描述为真实 Codex 已验证。

```bash
git add docs/operations/environment-setup.md docs/superpowers/specs/2026-08-31-codex-travel-agent-executor-design.md
git commit -m "docs: document Codex travel research operations"
```

## 最终验收检查表

- [ ] 准备阶段不创建 AgentRun；点击明确的研究动作后才 create/claim/execute。
- [ ] 只有管理员可控制或查看本机任务；普通成员只看静态说明与最终候选。
- [ ] AgentRun scope 精确为 `submitProposalBatch`；context/self-revoke 是固定签名控制动作。
- [ ] Bridge 用最新签名 context 重算 segment 和 disclosure fingerprint。
- [ ] Codex 只收到安全投影、姓名和任务专用 alias，不收到 UID、业务 ID、源码或秘密。
- [ ] 隔离、认证、联网或持久化探针任一失败时 fail closed。
- [ ] 阻断先自撤销 run，再持久化、通知；恢复用新 run 和同一 Codex thread。
- [ ] 每批 2–4 个同类候选，每个候选至少两个不同 HTTPS origin。
- [ ] 只调用一次原子 `submitProposalBatch`；失败、取消、超时、无效输出均零半成品。
- [ ] 自动测试只使用 fake Codex；真实 smoke 未获单独批准前不运行。
