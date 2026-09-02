# Daily Route Station Highlight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the overview route SVG highlight the city or cities from the selected daily plan with a static coral node, soft halo, coral label, and synchronized accessible name.

**Architecture:** Keep `TravelPassHero` as the single source of derived selected-day display data. Reuse its existing `routeStops()` parsing and `selectedRouteLeg()` fallback, derive recognized active cities without new React state, then expose activity on the existing static SVG station groups through `data-active`. Style those attributes in the existing overview stylesheet; do not change contracts, backend APIs, or the route path.

**Tech Stack:** React 19, TypeScript, SVG, CSS, Vitest, Testing Library, Playwright browser verification.

---

## File map

- Modify `apps/web/src/features/overview/TravelPassHero.tsx`: derive recognized cities for the selected day, mark the matching SVG groups, distinguish the right-side return PEK, and generate the dynamic SVG accessible name.
- Modify `apps/web/src/features/overview/TravelPassHero.test.tsx`: verify single-city, multi-city, return-city, fallback, unknown-city, and accessible-name behavior.
- Modify `apps/web/src/styles/global.css`: apply the approved static coral node, halo, and label treatment without layout movement or animation.

### Task 1: Selected-day station semantics

**Files:**
- Modify: `apps/web/src/features/overview/TravelPassHero.test.tsx`
- Modify: `apps/web/src/features/overview/TravelPassHero.tsx`

- [ ] **Step 1: Add failing tests for single-city, multi-city, return PEK, fallback, and unknown-city states**

Add a reusable route fixture and assertion helper to `TravelPassHero.test.tsx`:

```tsx
const completeTrip: Trip = {
  ...trip,
  endDate: "2026-10-08",
  days: [
    { id: "day-1", date: "2026-10-03", city: "深圳", itemIds: [] },
    { id: "day-2", date: "2026-10-04", city: "香港", itemIds: [] },
    { id: "day-3", date: "2026-10-05", city: "香港", itemIds: [] },
    { id: "day-4", date: "2026-10-06", city: "澳门", itemIds: [] },
    { id: "day-5", date: "2026-10-07", city: "澳门 / 珠海", itemIds: [] },
    { id: "day-6", date: "2026-10-08", city: "珠海 / 北京", itemIds: [] },
  ],
};

function activeStations(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll('[data-station][data-active="true"]'),
    (station) => station.getAttribute("data-station"),
  );
}
```

Add these focused tests:

```tsx
test.each([
  ["深圳", "SZX 深圳"],
  ["香港", "HKG 香港"],
  ["澳门", "MFM 澳门"],
  ["珠海", "ZUH 珠海"],
])("highlights only the selected single-city station for %s", (city, station) => {
  const singleCityTrip: Trip = {
    ...trip,
    days: [{ id: "selected-day", date: "2026-10-03", city, itemIds: [] }],
  };
  const { container } = render(<TravelPassHero trip={singleCityTrip} selectedDayId="selected-day" />);

  expect(activeStations(container)).toEqual([station]);
});

test("highlights both cities and announces them on a multi-city day", () => {
  const { container } = render(<TravelPassHero trip={completeTrip} selectedDayId="day-5" />);

  expect(activeStations(container)).toEqual(["MFM 澳门", "ZUH 珠海"]);
  expect(screen.getByRole("img", { name: /当前 D5，澳门、珠海已高亮/ })).toBeVisible();
});

test("highlights Zhuhai and only the return PEK on the final day", () => {
  const { container } = render(<TravelPassHero trip={completeTrip} selectedDayId="day-6" />);
  const pekStations = container.querySelectorAll('[data-station="PEK 北京"]');

  expect(activeStations(container)).toEqual(["ZUH 珠海", "PEK 北京"]);
  expect(pekStations[0]).not.toHaveAttribute("data-active", "true");
  expect(pekStations[1]).toHaveAttribute("data-active", "true");
  expect(screen.getByRole("img", { name: /当前 D6，珠海、北京已高亮/ })).toBeVisible();
});

test("keeps station fallback synchronized with the ticket for an invalid selected day", () => {
  const { container } = render(<TravelPassHero trip={completeTrip} selectedDayId="missing-day" />);

  expect(activeStations(container)).toEqual(["SZX 深圳"]);
  expect(screen.getByText("D1 · 2026.10.03 · 深圳")).toBeVisible();
});

test("does not falsely highlight a station for an unknown city", () => {
  const unknownTrip: Trip = {
    ...trip,
    days: [{ id: "day-unknown", date: "2026-10-03", city: "广州", itemIds: [] }],
  };
  const { container } = render(<TravelPassHero trip={unknownTrip} selectedDayId="day-unknown" />);

  expect(activeStations(container)).toEqual([]);
});
```

Update the original route-label assertion to accept the selected-day suffix:

```tsx
const route = screen.getByRole("img", {
  name: /北京出发，经深圳、香港、澳门、珠海，返回北京的路线/,
});
```

- [ ] **Step 2: Run the focused test and verify the new assertions fail**

Run:

```bash
pnpm --dir apps/web test -- TravelPassHero.test.tsx
```

Expected: FAIL because no SVG station currently renders `data-active="true"`, and the route accessible name has no current-day suffix.

- [ ] **Step 3: Derive recognized active cities from the same selected-day fallback used by the ticket**

In `TravelPassHero.tsx`, immediately after `const day = selectedRouteLeg(...)`, add:

```tsx
const activeStops = routeStops(day.city).filter((stop) => cityCodes[stop]);
const routeDescription = "北京出发，经深圳、香港、澳门、珠海，返回北京的路线";
const routeAriaLabel = activeStops.length > 0
  ? `${routeDescription}；当前 D${day.dayNumber}，${activeStops.join("、")}已高亮`
  : routeDescription;
```

Use the derived label on the SVG:

```tsx
aria-label={routeAriaLabel}
```

Add `data-active` only to matching existing station groups:

```tsx
<g data-station="SZX 深圳" data-active={activeStops.includes("深圳") || undefined} ...>
<g data-station="HKG 香港" data-active={activeStops.includes("香港") || undefined} ...>
<g data-station="MFM 澳门" data-active={activeStops.includes("澳门") || undefined} ...>
<g data-station="ZUH 珠海" data-active={activeStops.includes("珠海") || undefined} ...>
```

Leave the first PEK group without `data-active`; add the Beijing condition only to the final PEK group:

```tsx
<g
  data-station="PEK 北京"
  data-active={activeStops.includes("北京") || undefined}
  className="travel-pass-hero__station travel-pass-hero__station--endpoint"
  transform="translate(720 102)"
>
```

- [ ] **Step 4: Run the focused tests and verify they pass**

Run:

```bash
pnpm --dir apps/web test -- TravelPassHero.test.tsx
```

Expected: the `TravelPassHero` test file passes, including the existing ticket and route structure assertions.

- [ ] **Step 5: Commit station behavior**

```bash
git add apps/web/src/features/overview/TravelPassHero.tsx apps/web/src/features/overview/TravelPassHero.test.tsx
git commit -m "feat: sync route stations with selected day"
```

### Task 2: Approved static highlight styling

**Files:**
- Modify: `apps/web/src/styles/global.css`

- [ ] **Step 1: Add the coral active-state style**

Immediately after the existing endpoint text rule, add:

```css
.travel-pass-hero__station[data-active="true"] circle {
  fill: var(--pass-coral);
  stroke: var(--pass-coral);
  filter: drop-shadow(0 0 6px rgb(216 93 59 / 48%));
}
.travel-pass-hero__station[data-active="true"] text { fill: var(--pass-coral); }
```

This is static, introduces no transition or keyframe animation, and does not alter SVG geometry.

- [ ] **Step 2: Run the component tests and web static checks**

Run:

```bash
pnpm --dir apps/web test -- TravelPassHero.test.tsx
pnpm --dir apps/web typecheck
pnpm --dir apps/web lint
```

Expected: all commands exit 0. Existing lint warnings may remain, but there must be no new error attributable to these files.

- [ ] **Step 3: Commit the visual treatment**

```bash
git add apps/web/src/styles/global.css
git commit -m "style: highlight active travel route stations"
```

### Task 3: Regression and browser verification

**Files:**
- No source changes expected.
- Modify only the files above if verification reveals a defect directly caused by this feature.

- [ ] **Step 1: Run the complete web test suite and build**

Run:

```bash
pnpm --dir apps/web test
pnpm --dir apps/web typecheck
pnpm --dir apps/web build
```

Expected: all web tests pass, TypeScript exits 0, and Vite produces the production build.

- [ ] **Step 2: Verify the live overview in the existing local preview**

Open `http://127.0.0.1:4182/`, sign in using the existing local state if required, and verify:

1. D1 highlights only Shenzhen.
2. D5 highlights Macau and Zhuhai simultaneously.
3. D6 highlights Zhuhai and the right-side Beijing endpoint only.
4. Coral fill, soft halo, and coral text match the existing pass palette.
5. The route line stays green, nodes do not animate, and selection causes no layout shift.
6. At a narrow viewport, labels and halos remain visible without route clipping.
7. Browser console has no new errors or warnings.

- [ ] **Step 3: Run the relevant overview regression test**

Run:

```bash
pnpm --dir apps/web test -- OverviewPage.test.tsx TravelPassHero.test.tsx
```

Expected: both overview test files pass, including selected-day synchronization.

- [ ] **Step 4: Record verification without creating an empty commit**

If verification requires a code correction, rerun the failing check and commit only the directly related correction:

```bash
git add apps/web/src/features/overview/TravelPassHero.tsx apps/web/src/features/overview/TravelPassHero.test.tsx apps/web/src/styles/global.css
git commit -m "fix: correct route station highlight verification"
```

If no correction is required, leave the two implementation commits as the completed history.
