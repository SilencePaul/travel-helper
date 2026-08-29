# Decision Access Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bare `/decisions` authorization fallback with an accessible travel-pass access guard while preserving the existing privacy condition and return navigation.

**Architecture:** Add one presentational `DecisionAccessGuard` component inside the decisions feature and compose it from `App.tsx` only when either the member or decision repository is absent. Keep styling scoped in the existing decision workspace stylesheet and cover the guard contract in a focused component test plus the route regression suite.

**Tech Stack:** React 19, TypeScript, React Router 7, Vitest, Testing Library, CSS.

---

## File structure

- Create: `apps/web/src/features/decisions/DecisionAccessGuard.tsx` — semantic access-condition presentation and return action.
- Create: `apps/web/src/features/decisions/DecisionAccessGuard.test.tsx` — heading, status message, and callback contract.
- Modify: `apps/web/src/App.tsx` — render the guard under the existing authorization condition.
- Modify: `apps/web/src/AppDecisionRoute.test.tsx` — verify the unauthenticated route remains protected and can return home.
- Modify: `apps/web/src/features/decisions/decisionWorkspace.css` — scoped desktop, mobile, focus, and reduced-motion styling.

## Task 1: Lock the access-guard contract with failing tests

- [ ] Create `DecisionAccessGuard.test.tsx`, import the not-yet-created component, render it with an `onBack` spy, and assert the heading `共同决定，需要两张同行票` and status copy are visible.
- [ ] Click `返回行程` and assert the callback runs once.
- [ ] Run `pnpm --filter @travel/web exec vitest run src/features/decisions/DecisionAccessGuard.test.tsx` and confirm RED because the component module does not exist.

## Task 2: Implement the smallest protected state

- [ ] Create `DecisionAccessGuard.tsx` with one `<main>`, one `<h1>`, the existing shared-trip condition as `role="status"`, a native return button, and decorative ticket metadata hidden from assistive technology.
- [ ] Import and render the component from the existing `/decisions` fallback branch in `App.tsx`; do not change the `decisionRepository && member` condition.
- [ ] Add only `.decision-access-*` rules to `decisionWorkspace.css`, reusing the existing decision palette and typography with a two-column desktop layout and single-column mobile layout.
- [ ] Run the focused test again and confirm GREEN.

## Task 3: Protect route behavior and verify the rendered result

- [ ] Extend `AppDecisionRoute.test.tsx` with a `/decisions` render lacking member/repository, assert the guard heading, click `返回行程`, and assert the overview heading appears.
- [ ] Run the focused route and component tests, then the full web unit suite, typecheck, lint, and production build.
- [ ] Exercise `app loads -> 共同决定 -> protected ticket renders -> 返回行程 -> overview renders` in the in-app Browser on desktop and mobile; verify URL/title, nonblank DOM, no framework overlay, clean console, screenshot evidence, and the return interaction.
- [ ] Commit the source, tests, design, and plan with `fix: style shared decision access guard`.
