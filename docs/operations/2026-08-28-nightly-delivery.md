# 2026-08-28 夜间修复与发布记录

## 目标

修复旅行助手生产环境中飞书认证回调、会话恢复、行程加载和刷新后状态不一致的问题；让私人双人行程具备可审计的成员准入、可靠保存和明确的错误反馈。

## 今晚完成的改动

### 认证与会话

- 将飞书 OAuth 回调从静态站点深链接改为安全的一次性交换码流程：认证服务回调后跳转至静态首页，浏览器再交换短期 CloudBase Custom Login ticket。
- 交换码仅保存 SHA-256 摘要、五分钟过期、事务化单次消费；临时 ticket 签发失败时不会提前消费交换码，前端可重试。
- 修复 CloudBase SDK 对“不存在文档”返回空数组时被错误识别为有效认证记录的缺陷。无效交换码现在稳定返回 `400 INVALID_EXCHANGE_CODE`，不再产生 500。
- 将认证服务超时调为 30 秒，并为飞书请求加稳定超时/错误处理，避免页面长期卡住。
- 会话恢复发生网络异常时显示可重试状态，不会误判为已登出；退出时即使认证服务不可用也会清理本地 CloudBase 登录态。
- 在 Service Worker 注册前将地址栏中的一次性交换码移入 `sessionStorage`，减少其在历史记录、缓存键和静态访问日志中的暴露窗口。
- 每五分钟按批清理过期 OAuth state、交换码和会话记录，同时从成员会话关联中移除过期会话 ID。
- 认证网关增加总 100 QPS、单 IP 3 QPS 的 CloudBase 网关限频策略。

### 成员权限与数据安全

- `trip-api` 只信任 CloudBase 运行时的 `auth.getUserInfo().customUserId`，移除了事件载荷和上下文中的伪造身份兜底。
- 仅管理员可审批；审批在同一事务中同时更新成员、成员索引和行程 `memberUids`，批准后可立即加载并保存行程。
- 行程最多两名有效成员（admin/member）；pending 账号不占用名额，第三位成员审批会稳定拒绝。
- 新成员必须从等待页通过独立飞书私聊或当面提供身份校验码，管理员输入匹配代码后才可批准，避免只凭昵称/头像误批。
- CloudBase 规则拒绝客户端对成员、审计、认证和幂等记录的直接读写；`trip-api` ACL 要求非匿名登录。
- 离线快照与待同步命令按已认证 UID 隔离；旧版未归属离线记录被隔离并提示，不会被另一个账号重放。

### 产品体验与前端

- 增加认证回调、登录恢复、待审批、成员管理、行程加载和保存失败的可理解错误/重试状态。
- 管理员页增加成员加载空态、失败重试、成员上限提示、返回行程入口和审批身份核验。
- 生产构建配置若没有明确启用 CloudBase 模式会直接失败关闭，不会回退到本地种子数据。
- 增加离线未归属记录提示，完善保存/同步状态的展示。

### 运维与配置

- `seed:cloudbase` 只创建缺失集合和缺失索引/初始化记录，不覆盖现有行程或成员；补齐 `auth_exchange_codes` 集合。
- 生产配置检查现在验证 CloudBase 模式、HTTPS URL、精确飞书回调、Custom Login 凭据环境 ID 与可解析私钥。
- 移除未实际使用的 `AUTH_SESSION_SECRET` 配置要求，修正文档中已失效的 Open ID 白名单描述。
- 更新发布清单和环境搭建文档，使集合清单、凭据作用域、成员审批及上线检查与实际代码一致。

## 关键代码位置

| 范围 | 主要文件 |
| --- | --- |
| 飞书 OAuth / ticket / 清理 | `functions/auth-service/index.js`、`functions/auth-service/lib/authStore.js`、`functions/auth-service/lib/feishu.js` |
| 行程命令和权限 | `functions/trip-api/index.js`、`functions/trip-api/lib/commands.js` |
| 浏览器认证和生产入口 | `apps/web/src/app/BrowserRoot.tsx`、`apps/web/src/infrastructure/authSession.ts`、`apps/web/src/infrastructure/authCallbackExchange.ts` |
| 成员审批核验 | `apps/web/src/features/members/MemberManagementPage.tsx`、`apps/web/src/features/members/memberVerification.ts` |
| 离线隔离 | `apps/web/src/infrastructure/offlineQueue.ts`、`apps/web/src/infrastructure/offlineStore.ts`、`apps/web/src/app/TripProvider.tsx` |
| CloudBase 配置和运维 | `cloudbaserc.json`、`scripts/check-production-config.mjs`、`scripts/seed-cloudbase.mjs`、`scripts/apply-cloudbase-security.mjs` |

## 已执行验证

- 契约测试：56 项通过。
- 前端 Vitest：150 项通过。
- 云函数 Node 测试：47 项通过，包含 CloudBase 空记录/交换码回归测试。
- 运维、CloudBase 规则、种子、高德能力和 POI 校验通过。
- 类型检查、Lint、生产构建通过；Lint 仅保留既有 Fast Refresh 导出警告。
- Playwright：桌面和 iPhone 共 20 项通过，4 项按测试条件跳过。
- CloudBase 部署预检、生产配置检查、函数/网关部署、静态站点安全发布和远端一致性校验通过。
- 生产 HTTP 探针：静态首页 200 且新资源哈希生效；未登录 profile 返回 401；无效交换码返回 400 `INVALID_EXCHANGE_CODE`；CORS 精确匹配生产站点。
- 上线前后元数据核对：原行程保持版本 1、1 名行程成员、1 名成员、1 名管理员；只新增了缺失的 `auth_exchange_codes` 集合。

## 生产发布状态

已发布到：<https://shuati-d1gxqpl8b11342375-1439472732.tcloudbaseapp.com/>

已部署认证服务、行程服务、网关、CloudBase 数据库规则和静态前端。静态托管采用 `--safe --verify`，发布前备份保留在本地 `.cloudbase-backup/`，没有执行远端文件清理。

## 尚待完成的真实浏览器验收

Chrome 自动化在接管历史飞书回调标签页时被 Windows 自动化安全机制中止，因而以下“真实已登录浏览器”步骤尚未在本轮完成：

1. 飞书重登后回到静态首页。
2. 当前管理员加载行程、打开成员管理和关键行程页面。
3. 使用无业务差异的日期保存验证保存、刷新后版本一致。
4. 退出后重新登录并恢复会话。
5. 以第二个飞书账号验证等待页身份校验码、审批后加载/保存，以及第三账号/第三成员拒绝。

本地单元、集成和设备 E2E 已覆盖对应逻辑；但上述生产浏览器验收必须在当前已登录 Chrome 可重新接管后继续执行，不能用本地测试替代。

## 后续建议

- 在飞书控制台将应用可见范围限制为目标成员/租户。
- 为未来大量 pending 账号场景增加成员列表分页和独立活跃成员索引。
- 主前端包约 1.2 MB，可后续按地图、抽屉和数据面板做动态拆包。
- CloudBase 依赖树仍有 3 个上游传递依赖审计告警，等待上游发布可用修复版本后升级。
