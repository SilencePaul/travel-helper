# Production environment setup

This runbook is for the CloudBase production environment. It describes where each value belongs; it intentionally contains no credential values. Replace `<...>` entries from the CloudBase deployment output and Feishu/AMap consoles before using the commands.

## Deployment record

| Item | Value to record | Source |
| --- | --- | --- |
| Production app URL | `<PRODUCTION_APP_URL>` | CloudBase static hosting |
| CloudBase environment ID | `<CLOUDBASE_ENV_ID>` | CloudBase console |
| Public auth-service URL | `<AUTH_SERVICE_URL>` | CloudBase function details |
| Public Agent API URL | `<AGENT_API_URL>` | CloudBase gateway output; the value already ends in `/api/agent` |
| Feishu redirect URL | `<AUTH_SERVICE_URL>/api/auth/callback` | Must exactly match the Feishu app |
| Feishu document URL | `https://icnk2498ysl1.feishu.cn/wiki/RQJtwKJaTireiQkdYzlcOMA7nHb` | Existing document |

The production app and auth-service URLs must be HTTPS. Do not use a localhost, file URL, wildcard origin, or a URL copied from a preview deployment in the production Feishu app configuration.

## CloudBase project and custom login

1. Select the production environment `<CLOUDBASE_ENV_ID>` and enable Custom Login in Authentication.
2. Create or select the server credential used by the Node SDK. Store the complete JSON credential only in the function environment as `CLOUDBASE_CUSTOM_LOGIN_CREDENTIALS_BASE64`.
3. Encode locally on a trusted operator machine; do not paste the raw JSON into a shell history or commit it:

   ```bash
   base64 < tcb_custom_login.json | tr -d '\n'
   ```

   Set the resulting value through the CloudBase secret/environment-variable UI or an approved secret manager. The browser must never receive this variable.
4. Deploy and verify that the value is available to `auth-service`; function logs must not print it. `trip-api` uses the authenticated CloudBase runtime identity and does not receive this custom-login private credential.

The declarative config passes these variables by reference only. It must not contain a credential, Feishu secret, token, map key, or private key.

## Database, storage, and OPA policy

After taking the required backup, run `pnpm seed:cloudbase` before the first production bootstrap. The seed is idempotent: it creates only missing collections and absent bootstrap/index/trip records; it does not overwrite an existing trip. The exact collection set is `trips`, `membership_index`, `auth_bootstrap`, `auth_oauth_states`, `auth_sessions`, `auth_exchange_codes`, `members`, `trip_audits`, `trip_idempotency`, `trip_preferences`, `trip_decision_indexes`, `trip_preference_summaries`, `trip_decision_meta`, `trip_candidates`, `trip_evidence_snapshots`, `trip_candidate_feedback`, `trip_tentative_placements`, `trip_confirmation_receipts`, `trip_decision_events`, `trip_decision_audits`, `trip_decision_idempotency`, and `trip_agent_runs`. Keep this list synchronized with `scripts/cloudbaseSeed.mjs` rather than creating collections from an older runbook.

Use member-based reads and server-only authoritative writes:

```json
{
  "read": "auth != null && auth.uid in doc.memberUids",
  "write": false
}
```

Storage reads/writes require a custom-login session, and `trip-api` must still check trip membership before creating a media record. No client can write a trip, member, audit, or suggestion record directly.

If policy is managed in OPA, keep the equivalent deny-by-default policy in the policy repository and review it with the CloudBase rules:

```rego
package travel.authz

default allow := false

allow if {
  input.operation == "read"
  input.authenticated == true
  input.uid in input.resource.memberUids
}

allow if {
  input.operation == "server_command"
  input.authenticated == true
  input.function == "trip-api"
  input.uid in input.resource.memberUids
}
```

Test anonymous reads, a pending/non-member read, and a direct client write; all must be denied. Test an approved member read and a versioned `trip-api` command; both must be allowed.

## Function routes and environment variables

`auth-service` 与 Agent transport 是两个公网 HTTP 入口。配置以下路由：

`/api/auth` 与 `/api/agent` 网关路由都必须使用仓库中的按 Client IP QPS 限流；在控制台编辑路由时不得删除。

| Route | Purpose | Access |
| --- | --- | --- |
| `GET /api/auth/start` | Create OAuth state and redirect to Feishu | Public |
| `GET /api/auth/callback` | Exchange Feishu identity and redirect with a short-lived one-time exchange code | Public callback |
| `POST /api/auth/exchange` | Consume the one-time code and issue a CloudBase custom-login ticket | Public; code-bound and single-use |
| `POST /api/auth/bootstrap` | One-time administrator bootstrap | HTTPS, one-time code |
| `POST /api/auth/ticket` | Issue a short-lived CloudBase custom-login ticket | Authenticated server session |
| `POST /api/auth/logout` | Revoke the server session | Authenticated server session |
| `POST /api/agent` | Claim AgentRun and submit an existing signed Agent envelope | Public transport; ES256/run scope/sequence/idempotency verified server-side |

CloudBase CLI v2 以网关路由而不是函数级 `aclRule` 配置公网入口：不得新增指向 `trip-api` 的公网路由。独立的 `agent-api` 入口复用同一函数目录的 `index.agentMain`，仅让 `/api/agent` 无 bearer 到达验签层。HTTP transport 在调用任何命令前拒绝非 Agent action；成员 action 仍然必须通过 CloudBase SDK 事件调用，并在处理器和命令层重新检查已登录身份及 Trip 成员资格。不得向 Agent Bridge 配置成员 bearer、CloudBase 凭据或浏览器 Cookie。

Set the following in the appropriate scope:

| Variable | Scope | Handling |
| --- | --- | --- |
| `VITE_DATA_MODE=cloudbase` | build + auth-service/trip-api | Required for production |
| `VITE_CLOUDBASE_ENV_ID` | build + functions | Public environment identifier |
| `VITE_AUTH_SERVICE_URL` | build | Exact HTTPS auth-service URL |
| `PUBLIC_APP_URL` | auth-service | Exact HTTPS app URL |
| `AGENT_API_URL` | operator/local Bridge | Exact public HTTPS URL ending in `/api/agent`; not a secret and never a `VITE_` value |
| `FEISHU_APP_ID` | auth-service | Secret-managed deployment input |
| `FEISHU_APP_SECRET` | auth-service | Secret; never log |
| `FEISHU_REDIRECT_URI` | auth-service | Exact callback URL above |
| `ADMIN_BOOTSTRAP_CODE` | auth-service | One-time secret; rotate/consume after bootstrap |
| `CLOUDBASE_CUSTOM_LOGIN_CREDENTIALS_BASE64` | auth-service | Base64 JSON private credential |
| `AMAP_WEB_SERVICE_KEY` | trip-api | Server-only Web Service key |
| `QWEATHER_API_HOST` | trip-api | Approved QWeather host |
| `QWEATHER_PROJECT_ID` | trip-api | Server-only project ID |
| `QWEATHER_CREDENTIAL_ID` | trip-api | Server-only credential ID |
| `QWEATHER_PRIVATE_KEY` | trip-api | PKCS#8 private key; secret-managed |
| `CODEX_IMPORT_TOKEN` | trip-api/import job | Secret-managed, never returned |

Browser build variables are limited to `VITE_AMAP_JS_KEY` and `VITE_AMAP_SECURITY_CODE` in addition to the CloudBase public identifiers. Never put Web Service, QWeather, Feishu, CloudBase private, or Codex credentials behind a `VITE_` prefix.

## 本机 Codex Bridge 启动与验证

### 设备与登录边界

- Bridge 只在设备所有者可控的 macOS 用户会话中运行，并且只使用设备所有者已在本机 ChatGPT/Codex 建立的登录态。项目不提供 Codex 登录、换号或凭据代理。
- 普通行程成员无需、也不得为此功能登录 Codex 或提交任何账号、令牌、Cookie 或验证码。他们只能看到权限说明和原子写入后的候选结果。
- Codex 登录失效，或外部来源要求登录、验证码或风控处理时，任务进入“等待设备管理员处理”。页面持续显示状态，Bridge 会尝试向设备所有者发送不含行程、账号或来源站点内容的本地通知；通知被禁用不会使任务失败。设备所有者处理后，在共同决定页选择“已恢复登录，继续研究”或“跳过该来源并继续”，Bridge 恢复同一个 Codex task/thread，不新建任务。

### 启动、状态与停止

使用 Node 20+，先确认设备所有者的 ChatGPT/Codex 已登录，再从信任的操作员终端启动。`--app-url` 必须是正式 HTTPS 应用 URL，`--agent-endpoint` 必须是以 `/api/agent` 结尾的 HTTPS 网关 URL，`--port 0` 由操作系统选择随机 loopback 端口：

```bash
node apps/local-agent-bridge/src/cli.mjs \
  --app-url "$PUBLIC_APP_URL" \
  --agent-endpoint "$AGENT_API_URL" \
  --port 0
```

终端会输出待打开的应用 URL，并在 Web 调用 prepare 后输出本机配对指纹，供设备所有者与页面显示值对照。URL fragment 只含非机密的 `http://127.0.0.1:<random-port>`；Web 在启动时立即尽力清除，不写入 DOM、localStorage 或 sessionStorage。P-256 私钥和 32-byte pairing code 只存在 Bridge 进程内存中，不打印、不落盘。

- 状态：以共同决定页显示的“准备中 / 研究中 / 继续研究 / 校验中 / 写入中 / 等待设备管理员 / 完成 / 失败”为本机任务状态。页面无法读取时先使用“重新读取本机状态”，不要重复启动新任务。
- 停止单个研究：使用页面的“停止搜索”，等待状态进入“已取消”或完成安全对账。
- 停止 Bridge：在启动终端按 `Ctrl-C`，等待进程完成当前任务的取消、云端撤销对账和临时目录清理。不得用强制结束代替正常停止，除非进程已无法响应。

### 故障恢复

1. Bridge 中断后，用原命令重新启动，并打开新输出的应用 URL；刷新或旧 URL 不保留配对材料。Bridge 从本机应用数据中恢复最小任务状态，页面应先“重新读取本机状态”。
2. 显示 `CODEX_NOT_AUTHENTICATED` 时，只由设备所有者在 ChatGPT/Codex 内恢复登录，然后回到原页点击“已恢复登录，继续研究”。
3. 来源登录、验证码或风控无法在隔离环境中安全解决时，不要在项目页面输入账号、Cookie 或验证码；点击“跳过该来源并继续”，仍恢复原 Codex task/thread。
4. 显示 `CODEX_NOT_AVAILABLE` 时，确认本机 Codex CLI 来自受信任的 ChatGPT/Codex 安装并可执行；显示 `CODEX_ISOLATION_UNAVAILABLE` 时，不得绕过隔离探针或改成宽松权限，应先修复/更新本机 Codex 后重试准备。
5. 显示 Bridge 或 Agent transport 不可用时，检查本机进程、两个 HTTPS URL 和网关连通性，然后优先“重新读取本机状态”或继续已有对账，不要盲目创建新任务。

验证分层：

- 本地：运行 `node --test apps/local-agent-bridge/src/*.test.mjs` 与 `pnpm exec playwright test e2e/decision-agent-bridge.spec.ts --project=chromium`；这些使用真实 loopback HTTP/P-256 和测试 transport，不是生产 E2E。
- Staging：将两个 URL 替换为 staging HTTPS 值，确认 prepare → create → claim → getDecisionContext，同时检查无效签名、匿名成员命令和限流均被拒绝。
- 生产：只在发布审批后执行相同验收；仓库中的 mock/本地结果不得记录为生产 E2E 成功。本指南不表示已执行真实部署或写入真实旅行数据。

上述自动测试使用假 Codex 可执行文件和测试 transport，不启动真实 Codex、不消耗 Codex 额度。真实 Codex 冒烟会创建可见的持久任务、消耗设备所有者额度并执行真实联网搜索，必须在当次操作前获得单独明确批准；本指南不表示已执行该冒烟。

## Feishu and AMap console setup

In the Feishu app, register exactly `FEISHU_REDIRECT_URI`, enable the minimum identity/OAuth permissions required for app access token, user access token, and user information, and restrict application availability to the intended tenant/users where possible. Do not put names or IDs in client logs.

The production admission boundary is administrator approval, not an environment-variable Open ID list. A new Feishu identity is stored as `pending` and cannot read trip data. The traveler must send the identity verification code shown on their waiting page to the administrator through a separate trusted Feishu chat or in person; the approval control stays disabled until that code is entered. An administrator approval transaction both changes the role and attaches that identity to the administrator's trip; it rejects the operation once two active `admin`/`member` identities already exist. Pending identities do not consume an active seat.

In AMap security settings:

- Allow only `<PRODUCTION_APP_URL>` (and the explicitly approved local development origin when needed); do not use `*`.
- Bind the JS key to the production domain and its security code.
- Verify Web Service permissions for walking, transit, driving, POI, mainland China, and Hong Kong routes.
- Keep the Web Service key server-side and check daily quota/QPS before release.

## Safe-origin, backup, and rollback preparation

Configure CloudBase safe origins for the production HTTPS origin and the documented local development origin only. Before deployment, export database collections and record the backup location in `release-checklist.md`. Record the hosting version, all function revisions, Agent gateway route/QPS configuration, deployment ID, and rollback tag. A rollback restores the prior hosting version, `auth-service`, `trip-api`, public `agent-api`, and `/api/agent` gateway configuration together; do not roll back only the web bundle or only one function.

Run the secret-safe check before deployment:

```bash
node scripts/check-production-config.mjs
pnpm exec tcb validate
```

The checker may report variable names and `PASS`/`MISSING` status only. If a command prints a value, stop, rotate the exposed credential, and fix the command before continuing.
