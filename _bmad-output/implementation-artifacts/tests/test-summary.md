# Agent 交互自动化测试总结

## 测试范围

本轮覆盖本地 Agent Bridge、公网 Agent HTTP 入口、浏览器发现与成员授权链。未执行 staging/production 部署，也未把测试 transport 视为生产 E2E。

## 新增测试

### API 测试

- [x] `functions/trip-api/index.test.js` — 后端以稳定错误对象返回不可用时，公开 Agent 入口必须响应 `503`、`no-store`，且不泄露底层细节。

### E2E 测试

- [x] `e2e/decision-agent-bridge.spec.ts` — 真实 loopback Bridge 拒绝错误 Origin，且不得生成配对材料或创建 Agent 授权。
- [x] `e2e/decision-agent-bridge.spec.ts` — 非 loopback 恶意 fragment 在发起请求前被清除并安全失效。

## 覆盖结果

- Agent HTTP 入口测试：`19/19` 通过。
- Chromium Agent 用户链：`3/3` 通过，包括正常授权、错误 Origin、恶意 fragment。
- Local Bridge 加密与重试：`16/16` 通过。
- BD2 后端签名、命令与入口定向套件：`71/71` 通过。
- Web 全量组件测试：`280/280` 通过。
- 类型检查、生产配置检查、变更格式检查：通过。

## 测试质量检查

- [x] 使用项目既有 `node:test`、Vitest 与 Playwright。
- [x] 覆盖正常路径和关键安全错误路径。
- [x] Playwright 使用语义角色与可见文案定位。
- [x] 没有硬编码等待或测试顺序依赖。
- [x] 真实 loopback 测试在 `finally` 中关闭服务。

## 已知门禁与下一步

- `pnpm test:backend` 的未修改 `functions/auth-service/index.test.js` 子进程存在不退出问题；BD2 相关后端测试已单独验证。
- 根级 `pnpm lint` 在未修改的 `packages/contracts` ESLint 阶段不退出；Web 与 Local Bridge lint 均为 0 退出，仅有既有 React warning。
- PWA build 存在既有挂起记录，本轮未重复等待。
- 上线前仍需在获批的 staging 验证真实 CloudBase `agent-api` 路由、网关 QPS、Chromium/Safari Private Network Access 与回滚流程。
