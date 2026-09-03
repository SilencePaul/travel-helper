<!-- bmad:context -->
<!-- Verified 2026-09-03 against c247096. Managed by bmad-project-context; edits inside this block are replaced on refresh. Keep anything you want preserved outside the markers. -->

## 旅游计划

双人旅行计划应用：React Web、CloudBase 函数与本机 Codex Agent Bridge。已完成的规划与架构文档在 `bmad/docs/`；运行和发布规则在 `docs/operations/`。

## Policy

- 不提交或记录任何密钥、Cookie、配对码、私钥或真实旅行数据；生产配置仅按 `docs/operations/environment-setup.md` 操作。
- 所有旅行与决策写入必须经服务端命令；不要增加客户端直写 CloudBase 的路径。
- 本机 Agent 只能使用带签名、限范围的 AgentRun；不要向 Bridge 提供浏览器 bearer、CloudBase 凭据或 Codex 凭据。

## Where things are

- 前端：`apps/web/`；共享领域合同：`packages/contracts/`。
- CloudBase 服务：`functions/auth-service/` 与 `functions/trip-api/`；本机 Agent Bridge：`apps/local-agent-bridge/`。
- 已确认的产品、架构和实现规格：`bmad/docs/`；发布与环境操作：`docs/operations/`。
- 前端正式域名 `https://trip.yiming.ca` 走 Cloudflare Pages，不走 CloudBase 自定义域名；部署方案见 `docs/superpowers/plans/2026-08-28-cloudflare-pages-custom-domain.md`。
- 判断项目是否“完成”时，先读取相关 Codex 任务的最新完成结果及对应规格；`bmad/docs/implementation-artifacts/deferred-work.md` 是历史评审的范围外记录，不得未经复核就当作当前待办清单。
- 架构文档中的 Deferred 项只有在任务涉及相应范围时才处理；其中部署、密钥配置和数据源适配器不属于架构实现范围。

## Known pitfalls

- 发布前不能把本地、mock 或测试 transport 的结果称为生产验证；按 `docs/operations/release-checklist.md` 完成 staging/生产门禁。
- 不要要求配置 CloudBase 自定义域名、CNAME 或 ICP；该域名已确定由 Cloudflare Pages 承载，CloudBase 仅保留认证和数据服务。
- 不要把服务器密钥放在 `VITE_` 变量中；仅公开浏览器配置可使用该前缀。
- 不要为解决 Agent 或来源登录问题而降低隔离或绕过配对/签名检查；按环境操作文档的恢复流程处理。

<!-- /bmad:context -->
