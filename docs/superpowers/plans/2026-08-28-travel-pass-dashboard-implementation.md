# Travel Pass Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the authenticated trip overview into the approved “旅行通行证” desktop-first prototype while retaining every existing overview action, route, and accessible keyboard interaction.

**Architecture:** Keep `OverviewPage` as the stateful owner of all current mutations and dialogs. Extract the purely presentational first-screen storytelling (route SVG and ticket) into focused overview components, then apply a scoped `travel-pass-*` CSS layer. Reuse the existing tablist and day mutation handlers rather than introducing product state or changing repository contracts.

**Tech Stack:** React 19, TypeScript, React Router 7, Vitest, Testing Library, CSS, inline SVG.

---

## File structure

- Create: `apps/web/src/features/overview/TravelPassHero.tsx` — semantic editorial hero, route SVG, and ticket presentation.
- Create: `apps/web/src/features/overview/TravelPassHero.test.tsx` — route/ticket content and endpoint accessibility contract.
- Modify: `apps/web/src/features/overview/OverviewPage.tsx` — compose the hero, move existing header actions into text navigation, and retain all callbacks/dialogs.
- Modify: `apps/web/src/features/overview/OverviewPage.test.tsx` — verify actions remain discoverable and dynamic day data still renders.
- Modify: `apps/web/src/features/overview/DayStrip.tsx` — add minimal structural hooks for the continuous manifest presentation without changing tablist/DnD behavior.
- Modify: `apps/web/src/styles/global.css` — scoped travel-pass desktop/mobile visual system and reduced-motion-safe detail treatment.

## Task 1: Lock the approved visual narrative in a testable hero component

**Files:**

- Create: `apps/web/src/features/overview/TravelPassHero.tsx`
- Create: `apps/web/src/features/overview/TravelPassHero.test.tsx`

- [ ] **Step 1: Write failing content and route tests**

Create `TravelPassHero.test.tsx`. Render the component with the fixture trip and assert:

```tsx
expect(screen.getByRole("heading", { name: "两个人，一条向南的路线。" })).toBeVisible();
expect(screen.getByLabelText("北京出发，经深圳、香港、澳门、珠海，返回北京的路线")).toBeVisible();
expect(screen.getByText("SZX 第一站·深圳")).toBeVisible();
expect(screen.queryByText("PEK → PEK")).not.toBeInTheDocument();
```

Assert the SVG path has `data-testid="travel-route-wave"` and terminates at the final Beijing node: the `d` attribute must contain no drawing command after that endpoint. This guards against the rejected endpoint tail.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @travel/web exec vitest run src/features/overview/TravelPassHero.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the semantic hero and continuous route**

Create `TravelPassHero.tsx` with display-only props already owned by `OverviewPage` (`trip`, `member`, and action render slots/callbacks as needed). Include:

- an editorial heading split over two visual lines, with orange-red emphasis only on “一条向南的路线。”;
- a labelled inline SVG using one deep-green dashed cubic path to form the accepted S/wave;
- six stations in exact order: `PEK 北京`, `SZX 深圳`, `HKG 香港`, `MFM 澳门`, `ZUH 珠海`, `PEK 北京`;
- orange-red outlined start/end nodes, deep-green middle nodes, and a deliberately larger ZUH-to-final-PEK interval;
- a route path terminating at the final node centre with no further segment;
- a right-side ticket with `TRIP PASS`, `PRIVATE JOURNEY`, `PEK 北京出发`, `SZX 第一站·深圳`, D1 date/current status, member names, serial number, perforation line, ticket notches, and date stamp.

Do not put mutation logic, generic button UI, or a hard-coded `PEK → PEK` route into this component. Use real first-day date/city values when available, with benign fallback copy for empty trips.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 5: Commit the isolated component**

```bash
git add apps/web/src/features/overview/TravelPassHero.tsx apps/web/src/features/overview/TravelPassHero.test.tsx
git commit -m "feat: add travel pass overview hero"
```

## Task 2: Recompose the overview without changing its functional contract

**Files:**

- Modify: `apps/web/src/features/overview/OverviewPage.tsx`
- Modify: `apps/web/src/features/overview/OverviewPage.test.tsx`

- [ ] **Step 1: Add failing interaction regression assertions**

Extend the overview tests so the hero navigation and existing controls remain accessible. Render with spies for `onOpenHotels`, `onManageMembers`, and `onLogout`; click `酒店比较`, `成员管理`, and `退出登录`; assert the original callbacks were called. Also assert `新增一天`, `复制当天`, and `删除当天` remain visible. Preserve the existing keyboard-tablist and deletion/date-warning tests unchanged.

- [ ] **Step 2: Run the overview test and verify RED**

Run:

```bash
pnpm --filter @travel/web exec vitest run src/features/overview/OverviewPage.test.tsx
```

Expected: FAIL until the new semantic hero/navigation is composed.

- [ ] **Step 3: Replace only the visual layout around existing callbacks**

In `OverviewPage.tsx`:

- replace the old generic `.hero`, status-card, and pill-action header markup with `TravelPassHero` plus text navigation;
- keep `onOpenHotels`, `onManageMembers`, `signOut`, saving/error states, date-range state, and all dialog code in `OverviewPage`;
- keep the day actions as native `<button>` elements, but place them below `ROUTE MANIFEST / 每日计划` as an editorial control line;
- keep `DayStrip`, the selected-day panel, weather, date range, budget, orders, and unscheduled content in their current data order;
- add landmark/heading relationships where markup moves, without changing route navigation behavior.

Do not touch `App.tsx`, repository behavior, CloudBase, or Feishu code.

- [ ] **Step 4: Run focused overview tests and verify GREEN**

Run:

```bash
pnpm --filter @travel/web exec vitest run src/features/overview/OverviewPage.test.tsx src/features/overview/TravelPassHero.test.tsx
```

Expected: PASS, including existing date-warning, pending-save, day selection, and deletion coverage.

- [ ] **Step 5: Commit functional composition**

```bash
git add apps/web/src/features/overview/OverviewPage.tsx apps/web/src/features/overview/OverviewPage.test.tsx
git commit -m "feat: compose travel pass overview"
```

## Task 3: Convert the day strip and overview surfaces into the approved manifest system

**Files:**

- Modify: `apps/web/src/features/overview/DayStrip.tsx`
- Modify: `apps/web/src/styles/global.css`

- [ ] **Step 1: Add minimal manifest hooks**

In `DayStrip.tsx`, add only class/data hooks needed to mark the selected tab as current. Do not change element roles, roving tabindex, sensors, drag-handle label, or DnD callbacks.

- [ ] **Step 2: Implement scoped visual CSS**

Replace only the overview-specific rounded-card/pill rules with a `travel-pass-*` layer that:

- reuses the authentication palette already in `global.css` (`#e8e0cd`, deep green, orange-red) and `Songti SC` display treatment;
- creates wide editorial story + narrow lightly rotated ticket columns on desktop;
- styles perforations/notches, stamp, hairline/dashed dividers, and the S-wave without heavy gradients or generic dashboard cards;
- renders `ROUTE MANIFEST` tabs as joined narrow ticket slips with thin separators and an orange-red current marker;
- renders `新增一天 / 复制当天 / 删除当天` as small printed text controls, delete in orange-red, not rounded pills;
- renders top navigation as text with a restrained underline/current indicator;
- lets detailed sections breathe through rules and columns rather than adding new outer cards.

At `max-width: 799px`, stack story then ticket, keep ticket notches visible, allow the day strip to scroll horizontally, preserve all route nodes including return Beijing, and retain readable text actions. Respect `prefers-reduced-motion` by removing entrance/hover transforms.

- [ ] **Step 3: Run typecheck, lint, and focused UI tests**

Run:

```bash
pnpm --filter @travel/web typecheck
pnpm --filter @travel/web lint
pnpm --filter @travel/web exec vitest run src/features/overview/OverviewPage.test.tsx src/features/overview/dayTabIds.test.ts src/features/overview/TravelPassHero.test.tsx
```

Expected: all PASS.

- [ ] **Step 4: Perform visual browser verification**

Run the local web app and inspect desktop plus a narrow viewport. Verify:

1. Hero and login page share one visual family.
2. Route is a dashed S/wave, begins/ends in Beijing, and ends exactly at final PEK.
3. Ticket shows `PEK → SZX`, never `PEK → PEK`.
4. Last two route points are visibly separated.
5. Top navigation, day actions, day tabs, dialogs, budget, and order controls still work.
6. Narrow view clips no route node, ticket, or control text.

- [ ] **Step 5: Build the deployable frontend and commit**

Run:

```bash
pnpm --filter @travel/web build
git add apps/web/src/features/overview/DayStrip.tsx apps/web/src/styles/global.css
git commit -m "style: apply travel pass dashboard system"
```

Expected: production build completes successfully.

## Task 4: Final integration verification and handoff

**Files:** No new production files expected.

- [ ] **Step 1: Run the complete web test suite**

```bash
pnpm --filter @travel/web test
pnpm --filter @travel/web build
```

Expected: PASS.

- [ ] **Step 2: Inspect the change set**

```bash
git status --short
git log --oneline -3
git diff HEAD~3..HEAD -- apps/web/src/features/overview apps/web/src/styles/global.css
```

Expected: only approved overview components, tests, and scoped CSS changed; authentication and external-service configuration remain untouched.

- [ ] **Step 3: Publish after user review**

Push the commits and let existing Cloudflare Pages GitHub integration deploy. Verify `https://trip.yiming.ca` with an authenticated browser session.

Expected: live site renders the approved prototype and preserves the signed-in journey.

