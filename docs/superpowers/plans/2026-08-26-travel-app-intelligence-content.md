# Travel App Intelligence and Content Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add truthful rain probability, verified hotel/place/food content with Chinese-community sources, and a Codex suggestion inbox where human approval is required before official itinerary changes.

**Architecture:** QWeather calls run server-side with short-lived Ed25519 JWTs and cached coordinate/date responses. Researched content is versioned JSON validated by shared schemas; Codex imports suggestions through a token-protected command, while adoption runs through the existing versioned trip transaction and audit system.

**Tech Stack:** QWeather Web API, `jose`, CloudBase functions/database, Zod, Codex scheduled tasks, Vitest, Playwright.

---

### Task 1: Add honest weather states and QWeather proxy

**Files:**
- Create: `packages/contracts/src/weather.ts`
- Create: `packages/contracts/src/weather.test.ts`
- Create: `functions/trip-api/lib/qweather.js`
- Create: `functions/trip-api/lib/qweather.test.js`
- Create: `apps/web/src/features/overview/WeatherSummary.tsx`
- Create: `apps/web/src/features/overview/WeatherSummary.test.tsx`

- [ ] **Step 1: Write failing forecast-window tests**

```ts
expect(weatherDisplayState("2026-08-26", "2026-10-03", null).kind).toBe("pending");
expect(weatherDisplayState("2026-09-25", "2026-10-03", validForecast).kind).toBe("forecast");
expect(weatherDisplayState("2026-10-02", "2026-10-03", severeForecast).kind).toBe("warning");
```

- [ ] **Step 2: Generate short-lived QWeather JWTs only in the cloud function**

Install the signer dependency: `pnpm --dir functions/trip-api add jose`.

Use `jose` with `EdDSA`, `kid=QWEATHER_CREDENTIAL_ID`, `sub=QWEATHER_PROJECT_ID`, `iat=now-30`, and `exp=iat+900`. Import the PKCS8 private key from an environment variable; never return or log the JWT.

- [ ] **Step 3: Fetch and cache coordinate-level daily forecasts**

For trip dates more than 10 days away, return `{ kind: "pending", availableFrom }` without calling the API. Within 10 days, fetch daily forecasts by coordinates, normalize daytime/nighttime precipitation probability, temperature, condition, warning, and provider update time, then cache by rounded coordinate and date for one hour.

- [ ] **Step 4: Render truthful overview and day weather**

`pending` shows `待预报` and the date the reliable window opens. `forecast` shows actual percentages and timestamps. `warning` also shows the official warning title and a rain-route suggestion link. Never convert seasonal climate data into a forecast percentage.

- [ ] **Step 5: Verify and commit**

Run: `pnpm test && pnpm e2e --grep "weather"`

Expected: outside-window, forecast, stale, and warning states pass.

```bash
git add packages/contracts functions/trip-api apps/web e2e
git commit -m "feat: add truthful trip weather"
```

### Task 2: Define and validate sourced travel content

**Files:**
- Create: `packages/contracts/src/source.ts`
- Create: `packages/contracts/src/contentValidation.test.ts`
- Create: `content/hotels.json`
- Create: `content/places.json`
- Create: `content/restaurants.json`
- Create: `scripts/validate-content.ts`

- [ ] **Step 1: Write failing provenance tests**

Every hard fact requires at least one `official` or `booking` source; every experience recommendation requires at least two distinct community domains. Every price requires `currency`, `amount`, `checkedAt`, and source URL. Every image requires alt text and `licenseOrOwner`.

- [ ] **Step 2: Add the source schema and validation command**

Source kinds are `official`, `booking`, `xiaohongshu`, `dianping`, `ctrip`, `mafengwo`, `bilibili`, and `open-image`. Reject invalid URLs, future check dates, missing owners, and duplicate normalized source URLs.

Install `tsx` at the workspace root and add the exact script:

```bash
pnpm add -Dw tsx
```

```json
"content:validate": "tsx scripts/validate-content.ts"
```

Run: `pnpm content:validate`

Expected before content is added: FAIL with exact entity IDs missing required evidence.

- [ ] **Step 3: Research the current itinerary systematically**

For every hotel, restaurant, and attraction:

1. Record official address, hours, booking/cancellation facts, and update date.
2. Record current price with tax status and platform date.
3. Find at least two recent Chinese-community sources for queue, menu, photo spot, or lived experience.
4. Record source disagreement explicitly in `cautions`.
5. Use only allowed/owned/open-license images and record ownership.

Do not copy long text from community posts; store a short original summary and the source link.

- [ ] **Step 4: Validate and commit the researched seed**

Run: `pnpm content:validate && pnpm test`

Expected: PASS with zero missing source, price timestamp, or image attribution errors.

```bash
git add packages/contracts content scripts package.json
git commit -m "data: add sourced travel recommendations"
```

### Task 3: Add the source viewer and Xiaohongshu behavior

**Files:**
- Create: `apps/web/src/features/places/SourceList.tsx`
- Create: `apps/web/src/features/places/XiaohongshuPanel.tsx`
- Create: `apps/web/src/features/places/XiaohongshuPanel.test.tsx`
- Modify: `apps/web/src/features/places/PlaceDrawer.tsx`

- [ ] **Step 1: Write failing source-panel tests**

Clicking `小红书攻略` must first open an in-app list of curated notes. Each entry shows summary, date, creator label when available, and an external-link button. The panel also renders encoded search links for `地点名 推荐菜单`, `地点名 避雷`, and `地点名 拍照机位`.

- [ ] **Step 2: Implement safe external links**

Use `target="_blank" rel="noreferrer noopener"`. Display broken/removed sources as `原链接暂不可用 · 核验于 YYYY-MM-DD` while retaining the local summary and provider label.

- [ ] **Step 3: Verify and commit**

Run: `pnpm test && pnpm e2e --grep "source|小红书"`

Expected: PASS; clicking the main button does not jump immediately to a generic search.

```bash
git add apps/web e2e
git commit -m "feat: add curated travel source panels"
```

### Task 4: Add Codex suggestion import, review, and adoption

**Files:**
- Create: `packages/contracts/src/suggestion.ts`
- Create: `functions/trip-api/lib/suggestionCommands.js`
- Create: `functions/trip-api/lib/suggestionCommands.test.js`
- Create: `scripts/import-suggestions.ts`
- Create: `apps/web/src/features/suggestions/SuggestionInbox.tsx`
- Create: `apps/web/src/features/suggestions/SuggestionDiff.tsx`
- Create: `apps/web/src/features/suggestions/SuggestionInbox.test.tsx`

- [ ] **Step 1: Write failing import and adoption tests**

Tests must reject missing sources, stale observed times, an invalid import token, and direct mutation of the official trip. A valid import creates `status="pending"`; adoption changes the trip and audit log in one transaction; ignore changes only suggestion status.

- [ ] **Step 2: Implement the protected import action**

`importSuggestions` compares a constant-time SHA-256 digest of the provided token with the configured digest, validates an array of suggestions, deduplicates by `fingerprint`, and writes pending records. The function returns only imported/skipped counts.

- [ ] **Step 3: Implement the local Codex importer**

`scripts/import-suggestions.ts` reads a JSON file path, validates it, calls the public import endpoint with `Authorization: Bearer ${CODEX_IMPORT_TOKEN}`, and prints counts. It never prints the token or full suggestion bodies.

- [ ] **Step 4: Implement review UI and transactional adoption**

Each card shows category, affected day/place/hotel, observed time, source links, impact, and before/after diff. `采纳` requires confirmation for booking/date/hotel changes. `忽略` records actor and time. Pending count appears on the overview.

- [ ] **Step 5: Configure the Codex task after the importer is proven**

Create a Codex scheduled task that checks weather/price/hours/transport/community updates, writes validated JSON to a temporary local path, runs the importer, and reports only the new suggestion summary. The task must not modify official itinerary records itself.

- [ ] **Step 6: Verify and commit**

Run: `pnpm test && pnpm e2e --grep "suggestion"`

Expected: pending, adopt, ignore, deduplication, and unauthorized import tests pass.

```bash
git add packages/contracts functions/trip-api scripts apps/web e2e
git commit -m "feat: add human-reviewed Codex suggestions"
```

### Task 5: Perform the intelligence/content checkpoint

**Files:**
- Modify only files implicated by verified findings

- [ ] **Step 1: Run all gates**

Run: `pnpm content:validate && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm e2e`

Expected: all exit `0`.

- [ ] **Step 2: Verify truthfulness and provenance in the Browser plugin**

Inspect one pending-weather day, one forecast day, one restaurant, one attraction, one hotel, and one imported suggestion. Confirm each visible fact has a source/timestamp and no unavailable future forecast is displayed as a percentage.

- [ ] **Step 3: Verify human control**

Import a hotel-price suggestion, confirm the official budget does not change, adopt it, confirm one versioned budget change and audit entry, then undo it.

- [ ] **Step 4: Commit the checkpoint**

```bash
git add apps packages functions content scripts e2e
git commit -m "feat: add sourced travel intelligence"
```
