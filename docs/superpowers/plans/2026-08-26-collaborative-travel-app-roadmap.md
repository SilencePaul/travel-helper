# Collaborative Travel App Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved two-person travel planner as four working, independently verifiable increments, ending with a Tencent CloudBase deployment embedded in the existing Feishu document.

**Architecture:** A React/TypeScript PWA renders the overview, dynamic itinerary, AMap map, detail drawers, hotel comparison, orders, and budget. CloudBase provides Feishu-backed custom authentication, document storage, real-time subscriptions, cloud functions, and media storage; Codex writes sourced suggestions through a protected import path, and QWeather supplies precipitation probability.

**Tech Stack:** pnpm workspace, React, TypeScript, Vite, Vitest, Testing Library, Playwright, Zod, AMap JS API 2.0, CloudBase Web SDK v3, QWeather Web API, Feishu OpenAPI, CloudBase CLI.

---

## Delivery order

1. [Core interactive app](2026-08-26-travel-app-core-ui.md): local-first vertical slice with dynamic days, overview, AMap routes, detail drawers, hotel comparison, orders, budget, and direct AMap navigation.
2. [CloudBase and Feishu collaboration](2026-08-26-travel-app-collaboration.md): two-account login, persistence, real-time updates, conflict handling, audit history, and image upload.
3. [Weather, Codex suggestions, and researched content](2026-08-26-travel-app-intelligence-content.md): truthful precipitation states, sourced travel content, suggestion review, and protected Codex imports.
4. [Production rollout and Feishu embedding](2026-08-26-travel-app-production-rollout.md): PWA/offline hardening, declarative Tencent deployment, production QA, and document update.

Each phase must be demonstrably usable before the next begins. Do not start a later phase to conceal a failed gate in an earlier one.

## Locked repository structure

```text
.
├── apps/
│   └── web/
│       ├── src/
│       │   ├── app/                 # composition, routing, providers
│       │   ├── components/          # reusable UI primitives only
│       │   ├── features/
│       │   │   ├── overview/        # trip-level control center
│       │   │   ├── itinerary/       # day strip and timeline
│       │   │   ├── map/             # AMap adapter and route rendering
│       │   │   ├── places/          # restaurant/attraction drawer
│       │   │   ├── hotels/          # comparison and commute scoring
│       │   │   ├── budget/          # orders and totals
│       │   │   ├── suggestions/     # Codex review inbox
│       │   │   └── history/         # audit and conflicts
│       │   ├── infrastructure/      # repositories, auth, offline queue
│       │   └── styles/              # design tokens and global layout
│       └── tests/
├── packages/
│   └── contracts/                   # shared Zod schemas and pure domain logic
├── functions/
│   ├── auth-callback/                # Feishu OAuth and CloudBase ticket
│   └── trip-api/                     # commands, AMap/QWeather proxy, suggestions
├── content/                          # versioned, sourced seed data
├── scripts/                          # permission checks and Codex import CLI
├── e2e/                              # Playwright cross-feature flows
├── cloudbaserc.json
└── pnpm-workspace.yaml
```

`packages/contracts` contains no browser, map, CloudBase, or React imports. UI features talk to repository and service interfaces, not directly to CloudBase. That boundary lets Phase 1 use deterministic local adapters and Phase 2 replace them without rewriting screens.

## Required credentials and safe handling

Never commit or print these values:

- `AMAP_JS_KEY`, `AMAP_SECURITY_CODE`, `AMAP_WEB_SERVICE_KEY`
- `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_ALLOWED_OPEN_IDS`
- `CLOUDBASE_ENV_ID`, `CLOUDBASE_PUBLISHABLE_KEY`, `CLOUDBASE_CUSTOM_LOGIN_CREDENTIALS_BASE64`
- `QWEATHER_API_HOST`, `QWEATHER_PROJECT_ID`, `QWEATHER_CREDENTIAL_ID`, `QWEATHER_PRIVATE_KEY`
- `CODEX_IMPORT_TOKEN`

Commit only `.env.example` with empty values. Capability scripts may print capability names and status codes, never full request URLs or credential substrings.

## Cross-phase acceptance gates

| Approved requirement | Owning plan | Evidence |
|---|---|---|
| Dynamic 4/6/8-day itinerary | Core UI | unit tests plus browser day-strip interaction |
| Real road-following walking/transit routes | Core UI | AMap capability report and rendered route screenshot |
| Restaurant/attraction smart drawer | Core UI | desktop and mobile interaction tests |
| Hotel location/price/commute comparison | Core UI | score unit tests and map-selection E2E |
| Direct AMap launch | Core UI | generated URI test and mobile/manual smoke check |
| Feishu allowlisted two-person login | Collaboration | two allowed sessions and one denied account test |
| Real-time check/edit sync | Collaboration | two-browser Playwright test |
| Conflict history and recovery | Collaboration | concurrent version test and audit assertion |
| Honest rain probability | Intelligence/content | outside-window and inside-window weather tests |
| Sourced Chinese-community content | Intelligence/content | content validation and visible source links |
| Codex suggests; human approves | Intelligence/content | import/approve/ignore E2E |
| PWA offline viewing and queued edits | Production rollout | offline Playwright test |
| Tencent deployment and Feishu embed | Production rollout | public smoke test and final document fetch |

## Global verification commands

Run at every phase checkpoint:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm exec playwright test
```

Expected: every command exits `0`; Playwright attaches no framework error overlay or relevant console error.

## Primary implementation references

- AMap JS API and routes: <https://lbs.amap.com/api/javascript-api-v2/summary> and <https://lbs.amap.com/api/webservice/guide/api/newroute>
- AMap URI navigation: <https://lbs.amap.com/api/uri-api/guide/travel/route>
- CloudBase custom login: <https://docs.cloudbase.net/authentication-v2/method/custom-login>
- CloudBase real-time database watch: <https://docs.cloudbase.net/database/realtime>
- CloudBase database security rules: <https://docs.cloudbase.net/database/security-rules>
- CloudBase declarative deployment: <https://docs.cloudbase.net/en/cli-v1/declarative-deploy/deploy>
- QWeather daily forecast: <https://dev.qweather.com/en/docs/api/weather/weather-daily-forecast/>
- QWeather JWT authentication: <https://dev.qweather.com/en/docs/configuration/authentication/>
- Feishu identity exchange: `POST https://open.feishu.cn/open-apis/authen/v1/access_token` followed by `GET https://open.feishu.cn/open-apis/authen/v1/user_info`

## Phase checkpoint commits

- [ ] **Phase 1 checkpoint:** `feat: deliver local-first travel planning core`
- [ ] **Phase 2 checkpoint:** `feat: add Feishu CloudBase collaboration`
- [ ] **Phase 3 checkpoint:** `feat: add sourced travel intelligence`
- [ ] **Phase 4 checkpoint:** `chore: deploy and embed travel app`
