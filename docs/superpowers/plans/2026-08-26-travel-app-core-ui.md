# Travel App Core UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a polished local-first travel planner that proves dynamic dates, real AMap routes, map/timeline sync, place details, hotel comparison, orders, budget, and direct AMap navigation before backend work begins.

**Architecture:** A pnpm workspace separates pure schemas and date/score logic from a React PWA. The web app consumes `TripRepository`, `RouteService`, and `NavigationService` interfaces; Phase 1 supplies local adapters while keeping the screens ready for CloudBase replacements.

**Tech Stack:** React, TypeScript, Vite, React Router, Zod, date-fns, AMap JS API 2.0, `@amap/amap-jsapi-loader`, Vitest, Testing Library, Playwright, CSS.

---

### Task 1: Scaffold the workspace and verification harness

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `apps/web/**` through Vite
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `playwright.config.ts`
- Create: `e2e/smoke.spec.ts`

- [ ] **Step 1: Scaffold the React app and install only required dependencies**

Run:

```bash
mkdir -p packages/contracts/src e2e
pnpm create vite apps/web --template react-ts
pnpm --dir apps/web add react-router-dom zod date-fns @amap/amap-jsapi-loader @dnd-kit/core @dnd-kit/sortable
pnpm --dir apps/web add -D vitest jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event
pnpm add -Dw typescript eslint @playwright/test
```

Expected: `apps/web/package.json` exists and all installs exit `0`.

- [ ] **Step 2: Add root scripts and workspace declarations**

Create `package.json`:

```json
{
  "name": "travel-planner",
  "private": true,
  "packageManager": "pnpm@11.0.5",
  "scripts": {
    "dev": "pnpm --dir apps/web dev",
    "build": "pnpm -r build",
    "lint": "pnpm -r lint",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test",
    "e2e": "playwright test"
  },
  "devDependencies": {
    "@playwright/test": "latest",
    "eslint": "latest",
    "typescript": "latest"
  }
}
```

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - apps/*
  - packages/*
  - functions/*
```

Create `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "resolveJsonModule": true,
    "skipLibCheck": true
  }
}
```

Create `packages/contracts/package.json`:

```json
{
  "name": "@travel/contracts",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "build": "tsc --noEmit",
    "lint": "eslint src",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": { "date-fns": "latest", "zod": "latest" },
  "devDependencies": { "eslint": "latest", "typescript": "latest", "vitest": "latest" }
}
```

Create `packages/contracts/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src"]
}
```

Add `"test": "vitest run"` and `"typecheck": "tsc --noEmit"` to the generated `apps/web/package.json` scripts.

Run `pnpm --dir apps/web add '@travel/contracts@workspace:*' && pnpm install` after both workspace package files exist.

Create `.env.example`:

```dotenv
VITE_AMAP_JS_KEY=
VITE_AMAP_SECURITY_CODE=
AMAP_WEB_SERVICE_KEY=
VITE_DATA_MODE=local
```

Create `.gitignore`:

```gitignore
node_modules/
dist/
.env
.env.local
.env.*.local
playwright-report/
test-results/
.DS_Store
*.pem
tcb_custom_login.json
```

- [ ] **Step 3: Write the first failing browser smoke test**

Create `e2e/smoke.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

test("renders the travel app shell", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "一鸣与美垚的旅行" })).toBeVisible();
  await expect(page.getByText("正在使用本地计划")).toBeVisible();
});
```

Create `playwright.config.ts`:

```ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: "http://127.0.0.1:4173", trace: "retain-on-failure" },
  webServer: {
    command: "pnpm --dir apps/web dev --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: true
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 15"] } }
  ]
});
```

- [ ] **Step 4: Run the smoke test and verify the expected failure**

Run: `pnpm e2e --grep "travel app shell"`

Expected: FAIL because the requested heading and local-mode indicator do not exist.

- [ ] **Step 5: Add the minimal app shell**

Replace `apps/web/src/App.tsx` with:

```tsx
import "./styles/global.css";

export default function App() {
  return (
    <main className="app-shell">
      <header>
        <p className="eyebrow">2026 深港澳珠</p>
        <h1>一鸣与美垚的旅行</h1>
        <span className="sync-state">正在使用本地计划</span>
      </header>
    </main>
  );
}
```

Create `apps/web/src/styles/global.css`:

```css
:root {
  color: #18181b;
  background: #f5f5f2;
  font-family: Inter, "PingFang SC", "Microsoft YaHei", sans-serif;
  font-synthesis: none;
}
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; min-height: 100vh; }
button, input, textarea { font: inherit; }
.app-shell { min-height: 100vh; padding: 24px; }
.eyebrow { color: #71717a; font-size: 12px; letter-spacing: .12em; }
.sync-state { color: #657166; font-size: 13px; }
```

- [ ] **Step 6: Verify and commit**

Run: `pnpm e2e --grep "travel app shell" && pnpm build`

Expected: PASS and a successful Vite production build.

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json .gitignore .env.example apps packages playwright.config.ts e2e
git commit -m "chore: scaffold travel planner workspace"
```

### Task 2: Define contracts and dynamic-day behavior

**Files:**
- Create: `packages/contracts/src/trip.ts`
- Create: `packages/contracts/src/dates.ts`
- Create: `packages/contracts/src/dates.test.ts`
- Create: `packages/contracts/src/index.ts`

- [ ] **Step 1: Write failing tests for 4/6/8-day ranges and removed content**

Create `packages/contracts/src/dates.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { reconcileDays } from "./dates";

describe("reconcileDays", () => {
  it.each([
    ["2026-10-03", "2026-10-06", 4],
    ["2026-10-03", "2026-10-08", 6],
    ["2026-10-03", "2026-10-10", 8]
  ])("builds an inclusive range", (start, end, count) => {
    expect(reconcileDays([], start, end).days).toHaveLength(count);
  });

  it("keeps removed content in the unscheduled bucket", () => {
    const current = [
      { id: "day-1", date: "2026-10-03", city: "深圳", itemIds: ["place-1"] },
      { id: "day-2", date: "2026-10-04", city: "香港", itemIds: ["place-2"] }
    ];
    const result = reconcileDays(current, "2026-10-03", "2026-10-03");
    expect(result.days.map(day => day.id)).toEqual(["day-1"]);
    expect(result.unscheduledItemIds).toEqual(["place-2"]);
  });
});
```

- [ ] **Step 2: Run the test to verify failure**

Run: `pnpm --dir packages/contracts test -- dates.test.ts`

Expected: FAIL because `reconcileDays` does not exist.

- [ ] **Step 3: Add schemas and the minimal reconciliation function**

Create `packages/contracts/src/trip.ts`:

```ts
import { z } from "zod";

export const TravelDaySchema = z.object({
  id: z.string().min(1),
  date: z.string().date(),
  city: z.string(),
  itemIds: z.array(z.string()),
  hotelId: z.string().nullable().optional()
});

export const TripSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  startDate: z.string().date(),
  endDate: z.string().date(),
  travelers: z.array(z.object({ id: z.string(), name: z.string() })),
  days: z.array(TravelDaySchema),
  unscheduledItemIds: z.array(z.string()),
  version: z.number().int().nonnegative()
});

export type TravelDay = z.infer<typeof TravelDaySchema>;
export type Trip = z.infer<typeof TripSchema>;
```

Create `packages/contracts/src/dates.ts`:

```ts
import { addDays, differenceInCalendarDays, formatISO, parseISO } from "date-fns";
import type { TravelDay } from "./trip";

export function reconcileDays(current: TravelDay[], start: string, end: string) {
  const count = differenceInCalendarDays(parseISO(end), parseISO(start)) + 1;
  if (count < 1) throw new Error("结束日期不能早于开始日期");
  const byDate = new Map(current.map(day => [day.date, day]));
  const dates = Array.from({ length: count }, (_, index) =>
    formatISO(addDays(parseISO(start), index), { representation: "date" })
  );
  const days = dates.map((date, index) => byDate.get(date) ?? ({
    id: `day-${date}`,
    date,
    city: index === 0 ? "待安排" : "",
    itemIds: []
  }));
  const retained = new Set(dates);
  const unscheduledItemIds = current
    .filter(day => !retained.has(day.date))
    .flatMap(day => day.itemIds);
  return { days, unscheduledItemIds };
}
```

Create `packages/contracts/src/index.ts`:

```ts
export * from "./dates";
export * from "./trip";
```

- [ ] **Step 4: Add pure operations for manual day editing**

Extend the tests to cover inserting a blank day, duplicating a day with new stable IDs, moving a day, and removing a populated day into `unscheduledItemIds`. Implement and export `insertDay`, `duplicateDay`, `moveDay`, and `removeDay`. All four functions return new arrays and must not mutate their input.

- [ ] **Step 5: Run contract tests and typecheck**

Run: `pnpm --dir packages/contracts test && pnpm --dir packages/contracts typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts
git commit -m "feat: model dynamic travel days"
```

### Task 3: Add a repository boundary and validated local seed

**Files:**
- Create: `packages/contracts/src/repository.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `content/trip.seed.json`
- Create: `apps/web/src/infrastructure/localTripRepository.ts`
- Create: `apps/web/src/infrastructure/localTripRepository.test.ts`

- [ ] **Step 1: Define the repository contract**

Create `packages/contracts/src/repository.ts`:

```ts
import type { Trip } from "./trip";

export type TripChange = { trip: Trip; actorName: string; changedAt: string };

export interface TripRepository {
  load(tripId: string): Promise<Trip>;
  save(next: Trip, expectedVersion: number): Promise<Trip>;
  subscribe(tripId: string, onChange: (change: TripChange) => void): () => void;
}
```

Append `export * from "./repository";` to `packages/contracts/src/index.ts`.

- [ ] **Step 2: Write the failing version-conflict test**

Create `apps/web/src/infrastructure/localTripRepository.test.ts`:

```ts
import { expect, test } from "vitest";
import { LocalTripRepository } from "./localTripRepository";
import seed from "../../../../content/trip.seed.json";

test("rejects stale writes", async () => {
  const repository = new LocalTripRepository(seed);
  const trip = await repository.load(seed.id);
  await repository.save({ ...trip, title: "first" }, trip.version);
  await expect(repository.save({ ...trip, title: "stale" }, trip.version))
    .rejects.toThrow("VERSION_CONFLICT");
});
```

- [ ] **Step 3: Add a six-day seed and minimal repository**

Create `content/trip.seed.json` with the approved current route, traveler names `一鸣` and `美垚`, inclusive dates `2026-10-03` through `2026-10-08`, stable day IDs, and empty `itemIds` arrays. The complete initial file is:

```json
{
  "id": "trip-2026-gba",
  "title": "2026 十一深港澳珠旅行",
  "startDate": "2026-10-03",
  "endDate": "2026-10-08",
  "travelers": [
    { "id": "traveler-yiming", "name": "一鸣" },
    { "id": "traveler-meiyao", "name": "美垚" }
  ],
  "days": [
    { "id": "day-2026-10-03", "date": "2026-10-03", "city": "深圳", "itemIds": [] },
    { "id": "day-2026-10-04", "date": "2026-10-04", "city": "香港", "itemIds": [] },
    { "id": "day-2026-10-05", "date": "2026-10-05", "city": "香港", "itemIds": [] },
    { "id": "day-2026-10-06", "date": "2026-10-06", "city": "澳门", "itemIds": [] },
    { "id": "day-2026-10-07", "date": "2026-10-07", "city": "澳门 / 珠海", "itemIds": [] },
    { "id": "day-2026-10-08", "date": "2026-10-08", "city": "珠海 / 北京", "itemIds": [] }
  ],
  "unscheduledItemIds": [],
  "version": 0
}
```

Validate it at module load with `TripSchema.parse`.

Create `apps/web/src/infrastructure/localTripRepository.ts`:

```ts
import { TripSchema, type Trip, type TripChange, type TripRepository } from "@travel/contracts";

export class LocalTripRepository implements TripRepository {
  private trip: Trip;
  private listeners = new Set<(change: TripChange) => void>();

  constructor(seed: unknown) { this.trip = TripSchema.parse(seed); }
  async load(_tripId: string) { return structuredClone(this.trip); }
  async save(next: Trip, expectedVersion: number) {
    if (this.trip.version !== expectedVersion) throw new Error("VERSION_CONFLICT");
    this.trip = TripSchema.parse({ ...next, version: expectedVersion + 1 });
    const change = { trip: structuredClone(this.trip), actorName: "本地用户", changedAt: new Date().toISOString() };
    this.listeners.forEach(listener => listener(change));
    return structuredClone(this.trip);
  }
  subscribe(_tripId: string, onChange: (change: TripChange) => void) {
    this.listeners.add(onChange);
    return () => this.listeners.delete(onChange);
  }
}
```

- [ ] **Step 4: Verify and commit**

Run: `pnpm test && pnpm typecheck`

Expected: PASS.

```bash
git add content packages/contracts apps/web/src/infrastructure
git commit -m "feat: add validated local trip repository"
```

### Task 4: Build the dynamic overview and day navigation

**Files:**
- Create: `apps/web/src/app/TripProvider.tsx`
- Create: `apps/web/src/features/overview/OverviewPage.tsx`
- Create: `apps/web/src/features/overview/DayStrip.tsx`
- Create: `apps/web/src/features/overview/OverviewPage.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/styles/global.css`

- [ ] **Step 1: Write a failing overview test**

```tsx
test("renders every dynamic travel day and traveler", async () => {
  render(<OverviewPage trip={eightDayTrip} onSelectDay={() => undefined} />);
  expect(screen.getAllByRole("button", { name: /D\d/ })).toHaveLength(8);
  expect(screen.getByText("一鸣 / 美垚")).toBeVisible();
  expect(screen.getAllByText("待预报").length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --dir apps/web test -- OverviewPage.test.tsx`

Expected: FAIL because the overview components do not exist.

- [ ] **Step 3: Implement the overview with derived labels**

`DayStrip` must map `trip.days` directly, derive `D${index + 1}`, render `date` and `city`, and use a horizontally scrollable `role="tablist"`. It must never branch on a fixed day count. `OverviewPage` renders trip title, `一鸣 / 美垚`, the current seed budget summary, booking progress, and weather state `待预报` until a weather record exists.

Use these accessible selectors:

```tsx
<button role="tab" aria-selected={selectedDayId === day.id} onClick={() => onSelectDay(day.id)}>
  <span>{`D${index + 1}`}</span>
  <strong>{day.city || "待安排"}</strong>
  <small>{day.date}</small>
</button>
```

- [ ] **Step 4: Add an E2E day-count check**

Append to `e2e/smoke.spec.ts`:

```ts
test("opens a day from the dynamic overview", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: /D3/ }).click();
  await expect(page).toHaveURL(/day\/day-2026-10-05/);
});
```

Add controls for `新增一天`, `复制当天`, and `删除当天`, plus drag handles backed by `@dnd-kit/sortable`. Tests must verify the stable day ID survives a move, a duplicate receives a new ID, and deleting a populated day moves its items to `待安排内容`.

- [ ] **Step 5: Verify and commit**

Run: `pnpm test && pnpm e2e --grep "dynamic overview|opens a day"`

Expected: PASS.

```bash
git add apps/web e2e
git commit -m "feat: add dynamic trip overview"
```

### Task 5: Audit the existing AMap account without exposing keys

**Files:**
- Create: `scripts/amap-capability-check.mjs`
- Create: `scripts/amap-capability-check.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write a failing result classifier test**

Create `scripts/amap-capability-check.test.mjs`:

```js
import assert from "node:assert/strict";
import { classifyAmapResponse } from "./amap-capability-check.mjs";

assert.deepEqual(classifyAmapResponse({ status: "1", route: { paths: [{}] } }), { ok: true, reason: "available" });
assert.deepEqual(classifyAmapResponse({ status: "0", info: "USERKEY_PLAT_NOMATCH" }), { ok: false, reason: "USERKEY_PLAT_NOMATCH" });
console.log("amap capability classifier: PASS");
```

- [ ] **Step 2: Add the redacting capability checker**

The script must:

1. Read `AMAP_WEB_SERVICE_KEY` from the environment.
2. Call walking and transit endpoints for one Beijing pair and one Hong Kong pair.
3. Set a 10-second timeout.
4. Print only `capability`, `city`, `PASS/FAIL`, and the API `info` code.
5. Never print the request URL, query string, key length, or any credential substring.
6. Exit `1` when a required capability fails.

Export this pure helper:

```js
export function classifyAmapResponse(body) {
  if (body?.status === "1") return { ok: true, reason: "available" };
  return { ok: false, reason: String(body?.info || "UNKNOWN_RESPONSE") };
}
```

- [ ] **Step 3: Verify the classifier, then run the real audit with local secrets**

Run:

```bash
node scripts/amap-capability-check.test.mjs
set -a; source .env.local; set +a; node scripts/amap-capability-check.mjs
```

Expected: the classifier prints `PASS`; the audit reports separate results for mainland walking/transit and Hong Kong walking/transit without printing secrets. If Hong Kong returns an entitlement error, stop AMap integration and document the exact missing console permission before continuing.

- [ ] **Step 4: Commit only the script, never `.env.local`**

```bash
git add scripts package.json
git commit -m "test: add safe AMap capability audit"
```

### Task 6: Render AMap and road-following route segments

**Files:**
- Create: `apps/web/src/features/map/types.ts`
- Create: `apps/web/src/features/map/amapLoader.ts`
- Create: `apps/web/src/amap.d.ts`
- Create: `apps/web/src/features/map/AmapRouteMap.tsx`
- Create: `apps/web/src/features/map/AmapRouteMap.test.tsx`
- Create: `apps/web/src/features/itinerary/DayPage.tsx`
- Create: `apps/web/src/features/itinerary/Timeline.tsx`

- [ ] **Step 1: Define the route contract and write a failing selection test**

Create `apps/web/src/features/map/types.ts`:

```ts
export type TravelMode = "walking" | "transit" | "driving";
export type Coordinate = { lng: number; lat: number; coordinateSystem: "GCJ02" };
export type RouteSegment = {
  id: string;
  fromPlaceId: string;
  toPlaceId: string;
  mode: TravelMode;
  distanceMeters: number;
  durationMinutes: number;
  path: Coordinate[];
  summary: string;
};

export interface RouteService {
  getSegments(input: { dayId: string; placeIds: string[]; modeByLeg: TravelMode[] }): Promise<RouteSegment[]>;
}

export interface NavigationService {
  open(destination: { name: string; lng: number; lat: number; mode: TravelMode }): void;
}
```

Create `apps/web/src/amap.d.ts`:

```ts
export {};

declare global {
  interface Window {
    _AMapSecurityConfig?: { securityJsCode: string };
  }
}
```

All place coordinates must come from an AMap POI result or be converted to GCJ-02 before storage. Store the AMap POI ID beside each location; do not mix WGS84 coordinates into route or navigation requests.

Write a component test that clicks timeline place `太平山顶`, expects `aria-current="location"`, and expects the injected map adapter's `focusPlace("peak")` spy to be called once.

- [ ] **Step 2: Run the test and verify failure**

Run: `pnpm --dir apps/web test -- AmapRouteMap.test.tsx`

Expected: FAIL because the map and day components do not exist.

- [ ] **Step 3: Load AMap safely and draw provider-returned paths**

Create `amapLoader.ts`:

```ts
import AMapLoader from "@amap/amap-jsapi-loader";

export async function loadAmap() {
  const key = import.meta.env.VITE_AMAP_JS_KEY;
  const securityJsCode = import.meta.env.VITE_AMAP_SECURITY_CODE;
  if (!key || !securityJsCode) throw new Error("AMAP_BROWSER_CREDENTIALS_MISSING");
  window._AMapSecurityConfig = { securityJsCode };
  return AMapLoader.load({
    key,
    version: "2.0",
    plugins: ["AMap.Walking", "AMap.Transfer", "AMap.Driving", "AMap.Marker"]
  });
}
```

`AmapRouteMap` must draw `RouteSegment.path` verbatim as a solid polyline. It must not construct a two-point path from origin and destination. When `path.length < 2`, render a visible textual fallback instead of a fake straight route.

- [ ] **Step 4: Show segment facts between timeline cards**

Render each connector as, for example, `步行 650 米 · 9 分钟` or `港铁 2 站 · 18 分钟`, using `distanceMeters`, `durationMinutes`, and `summary` from the same `RouteSegment` that feeds the map.

- [ ] **Step 5: Add browser proof that route points exceed two**

In E2E, expose a development-only `data-route-points` count on the selected polyline summary and assert it is greater than `2`. Also assert that clicking a map marker scrolls the matching timeline card into view.

- [ ] **Step 6: Verify and commit**

Run: `pnpm test && pnpm e2e --grep "route|timeline"`

Expected: PASS; the visible route is road-following, not a dashed direct line.

```bash
git add apps/web e2e
git commit -m "feat: add AMap itinerary routes"
```

### Task 7: Add restaurant and attraction smart drawers

**Files:**
- Create: `packages/contracts/src/place.ts`
- Create: `apps/web/src/features/places/PlaceDrawer.tsx`
- Create: `apps/web/src/features/places/RestaurantDetails.tsx`
- Create: `apps/web/src/features/places/AttractionDetails.tsx`
- Create: `apps/web/src/features/places/PlaceDrawer.test.tsx`
- Modify: `content/trip.seed.json`

- [ ] **Step 1: Add discriminated place schemas**

Define `RestaurantPlaceSchema` with `averagePrice`, `signatureDishes`, `twoPersonOrder`, `hours`, `queueNote`, `reservationUrl`, `images`, and `sources`. Define `AttractionPlaceSchema` with `ticketPrice`, `hours`, `stayMinutes`, `bestTime`, `crowdNote`, `photoSpots`, `rainAlternativeId`, `bookingUrl`, `images`, and `sources`. Both share stable ID, name, address, coordinate, summary, and `updatedAt`.

- [ ] **Step 2: Write failing desktop and mobile drawer tests**

Tests must assert:

- Restaurant selection shows environment image, average price, two-person order total, dish names, source timestamp, Xiaohongshu, and navigation.
- Attraction selection shows ticket, stay duration, best time, photo spot, rain alternative, official booking, and navigation.
- Escape closes the desktop drawer and focus returns to the triggering card.
- Mobile drawer has three states: closed, partial, and full-screen.

- [ ] **Step 3: Implement the shared drawer shell and typed detail bodies**

Use `role="dialog"`, `aria-modal="true"`, a labelled close button, focus trapping, and preserved scroll state. Desktop width is `min(42vw, 560px)`; below `800px`, anchor it to the bottom and use a full-width rounded top edge.

- [ ] **Step 4: Add sourced, verified seed entries**

Seed at least one real restaurant and one real attraction for the current Hong Kong day. Each source object must have `label`, `url`, `kind`, and ISO `checkedAt`. Image entries require `url`, `alt`, and `licenseOrOwner`.

- [ ] **Step 5: Verify and commit**

Run: `pnpm test && pnpm e2e --grep "restaurant drawer|attraction drawer"`

Expected: PASS on desktop and mobile projects.

```bash
git add packages/contracts content apps/web e2e
git commit -m "feat: add rich place detail drawers"
```

### Task 8: Build the hotel comparison and commute scoring

**Files:**
- Create: `packages/contracts/src/hotel.ts`
- Create: `packages/contracts/src/hotelScore.ts`
- Create: `packages/contracts/src/hotelScore.test.ts`
- Create: `apps/web/src/features/hotels/HotelComparePage.tsx`
- Create: `apps/web/src/features/hotels/HotelCard.tsx`
- Create: `apps/web/src/features/hotels/HotelComparePage.test.tsx`

- [ ] **Step 1: Write failing scoring tests**

```ts
it("labels the hotel with the lowest total commute as most energy-saving", () => {
  const result = scoreHotels([nearHotel, cheapFarHotel], { nights: 3 });
  expect(result.find(item => item.id === nearHotel.id)?.badges).toContain("最省体力");
});

it("uses tax-inclusive stay total instead of headline nightly price", () => {
  const result = scoreHotels([hotelWithTaxes], { nights: 3 });
  expect(result[0].stayTotal).toBe(4680);
});
```

- [ ] **Step 2: Implement explainable scores**

`scoreHotels` returns raw facts and badges; it must not hide the inputs. Calculate `stayTotal`, `totalCommuteMinutes`, and normalized price/commute scores. Badges are awarded by deterministic minimums, not an opaque weighted AI score.

- [ ] **Step 3: Implement map-linked comparison**

Selecting a hotel must highlight its marker, show each day's first/last-place commute, and update trip stay total, transit minutes, and estimated steps. Cards show tax-inclusive total, nightly price, room area, breakfast, cancellation, station walk, neighborhood, strengths, drawbacks, platform, and checked time.

- [ ] **Step 4: Add E2E proof**

Click the second hotel and assert the selected marker, total stay amount, and commute summary all update. Change the trip from six to eight days and assert the night count and total recalculate.

- [ ] **Step 5: Verify and commit**

Run: `pnpm test && pnpm e2e --grep "hotel"`

Expected: PASS.

```bash
git add packages/contracts apps/web e2e
git commit -m "feat: add map-linked hotel comparison"
```

### Task 9: Add orders, budget, and direct AMap navigation

**Files:**
- Create: `packages/contracts/src/budget.ts`
- Modify: `packages/contracts/src/trip.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/web/src/features/budget/BudgetPanel.tsx`
- Create: `apps/web/src/features/budget/OrdersPanel.tsx`
- Create: `apps/web/src/features/map/navigation.ts`
- Create: `apps/web/src/features/map/navigation.test.ts`

- [ ] **Step 1: Write failing navigation URI tests**

```ts
const url = buildAmapNavigationUrl({
  name: "太平山顶",
  lng: 114.1437,
  lat: 22.2759,
  coordinateSystem: "GCJ02",
  mode: "walking"
});
expect(url).toContain("https://uri.amap.com/navigation");
expect(url).toContain("mode=walk");
expect(url).toContain("callnative=1");
```

- [ ] **Step 2: Implement encoded direct launch with fallback**

```ts
import type { Coordinate, TravelMode } from "./types";

type Destination = Coordinate & { name: string; mode: TravelMode };

export function buildAmapNavigationUrl(destination: Destination) {
  const mode = { walking: "walk", transit: "bus", driving: "car" }[destination.mode];
  const params = new URLSearchParams({
    to: `${destination.lng},${destination.lat},${destination.name}`,
    mode,
    policy: "0",
    callnative: "1"
  });
  return `https://uri.amap.com/navigation?${params}`;
}
```

Clicking `开始导航` assigns this URL. The drawer also provides `复制地址` if the page remains visible after the launch attempt.

- [ ] **Step 3: Add budget totals and editable order states**

Budget categories are `flight`, `hotel`, `transport`, `ticket`, and `food`. Store `estimated`, `paid`, `currency`, `status`, and optional `dayId`. Add `orders: z.array(BudgetItemSchema).default([])` to `TripSchema`, export the budget contract, and display trip/category/day totals. Order status changes use the repository rather than component-local state.

- [ ] **Step 4: Test date-conflict warnings**

When the date range removes a day containing a hotel stay or ticket, assert that the UI lists the affected order and leaves it unchanged until the user confirms an edit.

- [ ] **Step 5: Verify and commit**

Run: `pnpm test && pnpm e2e --grep "budget|order|navigation"`

Expected: PASS.

```bash
git add packages/contracts apps/web e2e
git commit -m "feat: add orders budget and AMap launch"
```

### Task 10: Perform the Phase 1 browser QA checkpoint

**Files:**
- Modify only files implicated by verified findings

- [ ] **Step 1: Run the complete automated gate**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm e2e
```

Expected: all commands exit `0`.

- [ ] **Step 2: Exercise the target flow in the Browser plugin**

The flow under test is: overview → change date length → open a day → click a place → inspect restaurant/attraction drawer → select a hotel → start AMap navigation → return to overview.

Verify page identity, meaningful DOM, no framework overlay, no relevant console warnings/errors, desktop screenshot, mobile screenshot, and state change after every interaction.

- [ ] **Step 3: Keep a mismatch ledger against the accepted prototype direction**

Record only concrete mismatches in the task commentary: reference evidence, rendered evidence, fix, or intentional deviation. Fix clipping, unreadable map overlays, scroll traps, stale selections, or non-working tabs before claiming the checkpoint.

- [ ] **Step 4: Commit the verified checkpoint**

```bash
git add apps packages content scripts e2e
git commit -m "feat: deliver local-first travel planning core"
```
