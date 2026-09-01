# 发布可分享 HTML 汇报

## 目的

把单文件 HTML 汇报发布到 <https://trip.yiming.ca>，保留页面自己的 JavaScript、翻页和全屏交互。飞书云盘仅作为归档；公开分享使用个人网站。

## 一次性环境要求

Cloudflare Pages 当前使用 Node 22。开发机也必须使用 Node 22，避免 Homebrew `pnpm` 以 Node 23 运行 Vite 时 Workbox 构建后不退出的问题。

```bash
nvm install 22.22.0
nvm use
corepack enable
pnpm install --frozen-lockfile
```

项目根目录的 `.nvmrc` 固定为 `22.22.0`。若 Node 22 不在默认 PATH，可给下面命令显式提供 `TRAVEL_NODE=/absolute/path/to/node`。

## 日常发布：一条命令

```bash
pnpm briefing:publish -- /absolute/path/to/your-briefing.html your-briefing-slug
```

例如：

```bash
pnpm briefing:publish -- ~/wiki/briefings/刘一鸣-试用期转正汇报.html probation-review
```

该命令会依次：

1. 校验 slug 仅含小写字母、数字和单个连字符；
2. 复制 HTML 到 `apps/web/public/briefings/<slug>/index.html`；
3. 做字节级一致性校验；
4. 使用 Node 22 执行 TypeScript、Vite 与 Workbox/PWA 构建；
5. 核验 `dist` 中的汇报副本仍逐字节一致且 `sw.js` 已生成；
6. **只**暂存并提交该汇报页面；不会提交其它工作区改动；
7. 推送 `main`，触发 Cloudflare Pages 自动部署；
8. 输出稳定分享地址：`https://trip.yiming.ca/briefings/<slug>/`。

脚本要求当前分支为 `main`。若同一个 slug 的内容没有变化，它不会创建空提交，但仍会推送并输出 URL。

## 仅准备、不发布

如果只想把文件放进站点目录、稍后再检查或提交：

```bash
pnpm briefing:prepare -- /absolute/path/to/your-briefing.html your-briefing-slug
```

## 发布后核验

Cloudflare 构建完成后，打开：

```text
https://trip.yiming.ca/briefings/<slug>/
```

应确认标题是目标汇报，并测试至少一次页面内的“下一页”或键盘方向键。若旧的 PWA 缓存仍在，先以无痕窗口或带查询参数的地址重新打开；`/briefings/**` 已从旅行应用的导航回退中排除，不应再返回旅行首页。

## Cloudflare Pages 配置

当前 Pages 的构建命令可继续使用：

```bash
cd ../.. && pnpm install --frozen-lockfile && pnpm --filter @travel/web build
```

Cloudflare 使用 Node 22，因此该命令会正常完成 Workbox Service Worker 生成。不要为发布汇报而关闭 PWA。
