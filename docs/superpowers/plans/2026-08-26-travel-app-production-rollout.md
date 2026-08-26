# Travel App Production Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the app for offline use, deploy it safely to Tencent CloudBase, verify production behavior, and replace the existing Feishu document's temporary prototype with the final embedded app and readable summary.

**Architecture:** Vite produces a cache-safe PWA; IndexedDB stores the last validated snapshot and idempotent pending commands. CloudBase declarative deployment publishes functions before hosting, production credentials live only in managed environment variables, and the Feishu document embeds the deployed HTTPS app with a link-card fallback.

**Tech Stack:** `vite-plugin-pwa`, IndexedDB, Playwright, CloudBase CLI v3.8+, CloudBase static hosting/functions, Feishu Docx/Wiki APIs.

---

### Task 1: Add PWA installability and offline snapshot/queue

**Files:**
- Modify: `apps/web/vite.config.ts`
- Create: `apps/web/src/infrastructure/offlineStore.ts`
- Create: `apps/web/src/infrastructure/offlineQueue.ts`
- Create: `apps/web/src/infrastructure/offlineQueue.test.ts`
- Create: `apps/web/src/components/OfflineStatus.tsx`
- Modify: `apps/web/package.json`

- [ ] **Step 1: Write failing queue tests**

Tests cover enqueue, idempotent replay, ordered replay, a version conflict that pauses the queue, and successful removal only after server acknowledgement.

- [ ] **Step 2: Implement IndexedDB stores**

Install the PWA plugin and small IndexedDB wrapper:

```bash
pnpm --dir apps/web add idb
pnpm --dir apps/web add -D vite-plugin-pwa
```

Use two stores: `tripSnapshots` keyed by trip ID and `pendingCommands` keyed by idempotency ID. Save a snapshot only after `TripSchema` validation. Queue commands contain trip ID, expected version, patch, created time, and idempotency ID; never store Feishu tokens, CloudBase tickets, map keys, or QWeather credentials.

- [ ] **Step 3: Configure the service worker**

Cache the app shell and versioned static assets. Use network-first for HTML, network-only for authentication/API routes, and cache-first for owned image assets. Never put OAuth callbacks, tokens, CloudBase responses, or third-party map tiles into custom service-worker caches; offline trip data comes only from the validated IndexedDB snapshot.

- [ ] **Step 4: Add offline E2E**

Load the trip online, switch the browser context offline, reload and assert the last snapshot renders, edit a note, return online, and assert the queued command syncs once.

- [ ] **Step 5: Verify and commit**

Run: `pnpm test && pnpm build && pnpm e2e --grep "offline"`

Expected: PASS and the build emits a web manifest plus service worker.

```bash
git add apps/web e2e
git commit -m "feat: add offline travel PWA"
```

### Task 2: Prepare production configuration and security checks

**Files:**
- Create: `docs/operations/environment-setup.md`
- Create: `scripts/check-production-config.mjs`
- Create: `scripts/check-production-config.test.mjs`
- Modify: `cloudbaserc.json`

- [ ] **Step 1: Write a redacting configuration checker**

The checker reports presence and format only. It verifies production domain, Feishu redirect URL, exactly two allowed Open IDs, CloudBase environment, AMap JS/Web keys, AMap security code, QWeather host/project/credential/private key, and Codex import token. It must never print values, lengths, hashes, or prefixes.

- [ ] **Step 2: Document exact console setup**

The runbook covers:

- CloudBase custom login enabled and private credential stored as a function secret
- CloudBase database collections, member-based read rules, no client writes to authoritative collections
- Feishu app redirect URL and minimum identity permissions
- AMap domain whitelist and verified mainland/Hong Kong route entitlements
- QWeather public key registration and private key storage
- CloudBase safe-origin configuration for localhost and production domain
- backup/export and rollback owner

- [ ] **Step 3: Validate deployment configuration**

Run: `node scripts/check-production-config.mjs && pnpm exec tcb validate`

Expected: all named checks show `PASS`; CloudBase validation exits `0`.

- [ ] **Step 4: Commit**

```bash
git add docs/operations scripts cloudbaserc.json
git commit -m "chore: document secure production configuration"
```

### Task 3: Deploy with a preview and explicit rollback point

**Files:**
- Modify only deployment configuration implicated by dry-run findings

- [ ] **Step 1: Tag the verified pre-deploy commit**

Run:

```bash
git status --short
git tag travel-app-predeploy-2026-08-26
```

Expected: the tracked worktree is clean before tagging. Do not include `.env.local`, downloaded credentials, or auth screenshots.

- [ ] **Step 2: Build and preview CloudBase changes**

Run:

```bash
pnpm build
pnpm exec tcb validate
pnpm exec tcb deploy --dry-run
```

Expected: preview contains only the two known functions, database/security declarations, gateway routes, and web hosting output.

- [ ] **Step 3: Deploy only after the preview matches**

Run: `pnpm exec tcb deploy --yes`

Expected: functions deploy successfully before hosting; CLI returns the HTTPS production URL. Record the deployment ID and URL in the task commentary, not in a secret file.

- [ ] **Step 4: Verify rollback procedure without executing it**

Confirm CloudBase shows the prior hosting version and function revisions available for rollback. Do not roll back a healthy deployment.

### Task 4: Run production authentication, map, collaboration, and offline smoke tests

**Files:**
- Create: `e2e/production.spec.ts`

- [ ] **Step 1: Run anonymous and denied-user checks**

Anonymous users are redirected to Feishu login; a non-allowlisted account receives the denial page and no trip content.

- [ ] **Step 2: Run the two-user critical flow**

For 一鸣 and 美垚: log in, open overview, change a non-destructive note, observe real-time sync, open a Hong Kong day, verify route path has more than two points, inspect restaurant and attraction drawers, select a hotel, and inspect history.

- [ ] **Step 3: Verify AMap launch on a physical phone**

From the production HTTPS app, tap `开始导航`; confirm 高德 App opens with the correct destination and travel mode. Uninstall simulation or a separate browser check verifies the highde web fallback and copy-address action.

- [ ] **Step 4: Verify weather and suggestions**

Confirm outside-window dates show `待预报`; inject one signed test suggestion, verify no official change before adoption, then delete/ignore the test suggestion through the UI.

- [ ] **Step 5: Verify PWA and offline**

Install to home screen, open once online, switch offline, reopen, verify the last trip and route text are readable, queue one note, reconnect, and verify one synchronized write.

### Task 5: Update and verify the Feishu document

**Files:**
- No repository files unless a document snapshot is explicitly exported

- [ ] **Step 1: Fetch the current document and revision**

Read `https://icnk2498ysl1.feishu.cn/wiki/RQJtwKJaTireiQkdYzlcOMA7nHb?fromScene=spaceOverview` and record the current revision before editing. Preserve useful prose and existing booking facts.

- [ ] **Step 2: Replace incorrect naming and temporary prototype content**

Use `一鸣 / 美垚` for travelers. Phrase the intro as `昨天先浅浅计划了一下`; do not use `浅浅` as a person's name. Remove or replace the temporary Leaflet/OSM HTML prototype so it cannot be confused with production.

- [ ] **Step 3: Build the readable summary above the embed**

The document summary shows trip dates, current route, selected/shortlisted hotels, total budget, booking progress, next decisions, and a note that dates are editable in the app. Use image cards and compact tables rather than long uninterrupted text.

- [ ] **Step 4: Embed the production app with fallback**

Insert the CloudBase HTTPS app in the supported Feishu webpage/HTML block. Immediately below it add a normal link card labelled `在浏览器中打开完整旅行计划`, using the same URL.

- [ ] **Step 5: Re-fetch and verify**

Confirm the revision increased, the embed URL is exact, the fallback link opens, the traveler names are correct, the summary remains readable, and no secret or local URL (`localhost`, `file://`) appears.

### Task 6: Final verification and handoff

**Files:**
- Create: `docs/operations/release-checklist.md`

- [ ] **Step 1: Run the final gate**

Run:

```bash
pnpm content:validate
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm e2e
```

Expected: all exit `0`.

- [ ] **Step 2: Record verified operational facts**

The checklist includes production URL, CloudBase environment name, deployment ID, Feishu document revision, AMap capability result names, last content validation time, QWeather state, backup location, rollback tag, and next Codex scheduled run. It contains no credential values.

- [ ] **Step 3: Commit the release state**

```bash
git add apps packages functions content scripts e2e docs cloudbaserc.json
git commit -m "chore: deploy and embed travel app"
```

- [ ] **Step 4: Verify the final commit and clean tracked worktree**

Run: `git status --short && git log -5 --oneline`

Expected: no tracked modifications; unrelated pre-existing untracked research artifacts may remain untouched and must be reported separately.
