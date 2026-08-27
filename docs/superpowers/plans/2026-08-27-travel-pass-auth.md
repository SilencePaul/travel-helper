# Travel Pass Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bare authentication screens with the approved travel-boarding-pass experience and make a valid server session recover reliably without repeated Feishu authorization.

**Architecture:** Treat the auth-service `/profile` response as the authoritative membership state, then hydrate the CloudBase browser session only when necessary. Keep that recovery behavior in `authSession.ts`, and let each authentication screen await it before navigating. Share all authentication presentation through one focused `AuthShell` component.

**Tech Stack:** React 19, React Router 7, TypeScript, CloudBase JS SDK, Vitest, Testing Library, CSS.

---

## File structure

- Create `apps/web/src/features/auth/AuthShell.tsx`: shared boarding-pass page structure and route artwork.
- Create `apps/web/src/features/auth/AuthShell.test.tsx`: accessible content and responsive-structure contract.
- Modify `apps/web/src/infrastructure/authSession.ts`: authoritative server-session recovery helper.
- Modify `apps/web/src/infrastructure/authSession.test.ts`: recovery ordering and no-repeat-login tests.
- Modify `apps/web/src/app/BrowserRoot.tsx`: use recovered member state directly instead of gating on `getCurrentUser()`.
- Modify `apps/web/src/app/BrowserRoot.test.tsx`: reproduce the production login loop.
- Modify `apps/web/src/features/auth/LoginPage.tsx`: approved login copy and shared shell.
- Modify `apps/web/src/features/auth/AuthCallbackPage.tsx`: await recovery and handle stale bootstrap callbacks.
- Modify `apps/web/src/features/auth/BootstrapPage.tsx`: serialize bootstrap, recovery, state update, and navigation.
- Modify `apps/web/src/features/auth/PendingApprovalPage.tsx`: recover approved members through the same path.
- Modify `apps/web/src/styles/global.css`: scoped travel-pass visual system and responsive layout.

### Task 1: Make server membership authoritative

**Files:**
- Modify: `apps/web/src/infrastructure/authSession.ts`
- Modify: `apps/web/src/infrastructure/authSession.test.ts`

- [ ] **Step 1: Write the failing recovery tests**

Add tests proving profile lookup happens even when the CloudBase SDK has no current user, and that a missing browser user triggers exactly one ticket login:

```ts
it("recovers an approved server session when the CloudBase user is temporarily empty", async () => {
  const member = { uid: "fs_admin", displayName: "一鸣", role: "admin", version: 1, createdAt: "2026-08-27T00:00:00.000Z" } as const;
  const getProfile = vi.fn().mockResolvedValue(member);
  const getCurrentUser = vi.fn().mockResolvedValue(null);
  const signIn = vi.fn().mockResolvedValue(undefined);

  await expect(recoverAuthenticatedMember({ getProfile, getCurrentUser, signIn })).resolves.toEqual(member);
  expect(getProfile).toHaveBeenCalledTimes(1);
  expect(signIn).toHaveBeenCalledTimes(1);
});

it("does not request another ticket when the CloudBase user already exists", async () => {
  const member = { uid: "fs_admin", displayName: "一鸣", role: "admin", version: 1, createdAt: "2026-08-27T00:00:00.000Z" } as const;
  const signIn = vi.fn();

  await recoverAuthenticatedMember({
    getProfile: vi.fn().mockResolvedValue(member),
    getCurrentUser: vi.fn().mockResolvedValue({ uid: member.uid }),
    signIn,
  });

  expect(signIn).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `pnpm --filter @travel/web exec vitest run src/infrastructure/authSession.test.ts`

Expected: FAIL because `recoverAuthenticatedMember` is not exported.

- [ ] **Step 3: Implement the minimal recovery helper**

Add this dependency-injectable helper to `authSession.ts`:

```ts
type RecoveryDependencies = {
  getProfile?: () => Promise<Member>;
  getCurrentUser?: () => Promise<unknown>;
  signIn?: () => Promise<unknown>;
};

export async function recoverAuthenticatedMember({
  getProfile = () => getCurrentProfile(),
  getCurrentUser = () => getCloudbaseAuth().getCurrentUser(),
  signIn = () => signInWithCustomTicket(),
}: RecoveryDependencies = {}) {
  const member = await getProfile();
  if ((member.role === "admin" || member.role === "member") && !(await getCurrentUser())) await signIn();
  return member;
}
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `pnpm --filter @travel/web exec vitest run src/infrastructure/authSession.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/infrastructure/authSession.ts apps/web/src/infrastructure/authSession.test.ts
git commit -m "fix: recover auth from server session"
```

### Task 2: Remove the post-bootstrap authentication race

**Files:**
- Modify: `apps/web/src/app/BrowserRoot.tsx`
- Modify: `apps/web/src/app/BrowserRoot.test.tsx`
- Modify: `apps/web/src/features/auth/AuthCallbackPage.tsx`
- Modify: `apps/web/src/features/auth/BootstrapPage.tsx`
- Modify: `apps/web/src/features/auth/PendingApprovalPage.tsx`

- [ ] **Step 1: Write the failing gate test**

Mock `getCurrentProfile` to return an administrator while `getCurrentUser` returns null, render `ProductionAuthGate`, and assert that trip content appears instead of the login button:

```tsx
it("opens the trip from a valid server session even while the CloudBase user is empty", async () => {
  getCurrentProfile.mockResolvedValue({ uid: "fs_admin", displayName: "一鸣", role: "admin", version: 1, createdAt: "2026-08-27T00:00:00.000Z" });
  getCurrentUser.mockResolvedValue(null);
  signInWithCustomTicket.mockResolvedValue(undefined);

  render(<ProductionAuthGate />);

  expect(await screen.findByText("一鸣与美垚的旅行")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "使用飞书继续" })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Write failing screen-flow tests**

Cover these exact behaviors with MemoryRouter-based component tests:

```tsx
it("waits for member recovery before leaving bootstrap", async () => {
  const recovered = deferred<Member>();
  renderBootstrap({ recover: () => recovered.promise });
  await user.type(screen.getByLabelText("管理员口令"), "correct");
  await user.click(screen.getByRole("button", { name: "完成并进入行程" }));
  expect(screen.getByRole("button", { name: "正在确认身份…" })).toBeDisabled();
  expect(screen.queryByText("一鸣与美垚的旅行")).not.toBeInTheDocument();
  recovered.resolve(adminMember);
  expect(await screen.findByText("一鸣与美垚的旅行")).toBeInTheDocument();
});

it("skips bootstrap for an already-approved member on a stale callback", async () => {
  renderCallback({ url: "/?auth_callback=1&status=bootstrap&state=old", recover: async () => adminMember });
  expect(await screen.findByText("一鸣与美垚的旅行")).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "初始化管理员" })).not.toBeInTheDocument();
});
```

- [ ] **Step 3: Run the flow tests and verify RED**

Run: `pnpm --filter @travel/web exec vitest run src/app/BrowserRoot.test.tsx src/features/auth`

Expected: FAIL because the current gate stops at an empty CloudBase user and callbacks navigate before recovery settles.

- [ ] **Step 4: Update the gate and screen callbacks**

Use `recoverAuthenticatedMember()` in `ProductionAuthGate.refreshAuth`. Change screen callbacks to accept the recovered member directly:

```ts
type AuthenticatedHandler = (member: Member) => void;
```

For bootstrap, execute this exact sequence inside `submit`:

```ts
await bootstrapWithCode(authServiceUrl(), submittedCode, params.get("state") || "");
const member = await recoverAuthenticatedMember();
if (member.role !== "admin") throw new Error("ADMIN_RECOVERY_FAILED");
onAuthenticated?.(member);
navigate("/", { replace: true });
```

For callback and pending approval, recover the member, update parent state with that member, then navigate. A pending member remains on the pending screen. A stale bootstrap callback whose profile is already `admin` goes directly to `/`.

- [ ] **Step 5: Run the focused flow tests and verify GREEN**

Run: `pnpm --filter @travel/web exec vitest run src/app/BrowserRoot.test.tsx src/features/auth`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/BrowserRoot.tsx apps/web/src/app/BrowserRoot.test.tsx apps/web/src/features/auth/AuthCallbackPage.tsx apps/web/src/features/auth/BootstrapPage.tsx apps/web/src/features/auth/PendingApprovalPage.tsx
git commit -m "fix: serialize authentication recovery"
```

### Task 3: Build the travel-boarding-pass authentication shell

**Files:**
- Create: `apps/web/src/features/auth/AuthShell.tsx`
- Create: `apps/web/src/features/auth/AuthShell.test.tsx`
- Modify: `apps/web/src/features/auth/LoginPage.tsx`
- Modify: `apps/web/src/features/auth/AuthCallbackPage.tsx`
- Modify: `apps/web/src/features/auth/BootstrapPage.tsx`
- Modify: `apps/web/src/features/auth/PendingApprovalPage.tsx`
- Modify: `apps/web/src/styles/global.css`

- [ ] **Step 1: Write the failing shared-shell test**

```tsx
it("renders the trip route and an accessible authentication card", () => {
  render(<AuthShell step="登录" title="浅浅计划，认真出发" description="使用飞书确认身份。"><button>使用飞书继续</button></AuthShell>);
  expect(screen.getByRole("main", { name: "浅浅计划，认真出发" })).toBeInTheDocument();
  expect(screen.getByLabelText("深圳、香港、澳门、珠海旅行路线")).toBeInTheDocument();
  expect(screen.getByText("一鸣 × 美垚")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `pnpm --filter @travel/web exec vitest run src/features/auth/AuthShell.test.tsx`

Expected: FAIL because `AuthShell.tsx` does not exist.

- [ ] **Step 3: Implement the semantic shell**

Create `AuthShell.tsx` with one `<main className="auth-shell">`, a decorative route SVG with an accessible label, a trip-introduction section, and one `<section className="auth-pass">` containing the current state and children. Use text content `一鸣 × 美垚`, `03—08 OCT · 2026`, `SZX`, `HKG`, `MFM`, and `ZUH`.

- [ ] **Step 4: Apply the approved visual system**

Add only `.auth-*` scoped CSS:

```css
.auth-shell { min-height: 100dvh; padding: clamp(20px, 5vw, 64px); color: #183229; background: #e8e0cd; }
.auth-layout { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(320px, .72fr); gap: clamp(28px, 7vw, 92px); align-items: center; width: min(1180px, 100%); min-height: calc(100dvh - 128px); margin: auto; }
.auth-pass { position: relative; padding: clamp(24px, 4vw, 34px); border: 1px solid rgb(24 50 41 / 25%); border-radius: 24px; background: #f8f1df; box-shadow: 0 30px 80px rgb(47 54 42 / 18%); }
.auth-primary { width: 100%; min-height: 50px; border: 0; border-radius: 13px; color: #fff; background: #204d3f; }
@media (max-width: 760px) { .auth-layout { grid-template-columns: 1fr; min-height: auto; } .auth-shell { padding: 18px; } }
```

Add the remaining approved states explicitly:

```css
.auth-shell::before { position: fixed; inset: 0; pointer-events: none; opacity: .28; background-image: radial-gradient(#6f796d .6px, transparent .6px); background-size: 7px 7px; content: ""; }
.auth-pass::before, .auth-pass::after { position: absolute; top: 148px; width: 22px; height: 22px; border-radius: 50%; background: #e8e0cd; content: ""; }
.auth-pass::before { left: -12px; }
.auth-pass::after { right: -12px; }
.auth-primary:focus-visible, .auth-input:focus-visible { outline: 3px solid #d85d3b; outline-offset: 3px; }
.auth-primary:disabled { cursor: wait; opacity: .62; }
.auth-error { color: #8a332d; }
@media (prefers-reduced-motion: reduce) { .auth-pass { animation: none; } }
```

Use a CSS-drawn route rather than a remote image, keep body text contrast at WCAG AA, and keep every interactive target at least 44px.

- [ ] **Step 5: Move all authentication pages into AuthShell**

Use these page-specific titles and actions:

- Login: `浅浅计划，认真出发` / `使用飞书继续`
- Callback: `正在确认这张旅行通行证` / progress status
- Bootstrap: `完成管理员初始化` / label `管理员口令` / button `完成并进入行程`
- Pending: `等待同行确认` / button `重新检查状态`

- [ ] **Step 6: Run auth component tests and verify GREEN**

Run: `pnpm --filter @travel/web exec vitest run src/features/auth src/app/BrowserRoot.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/features/auth apps/web/src/styles/global.css
git commit -m "feat: design travel pass authentication"
```

### Task 4: Full verification and production release

**Files:**
- Verify: `apps/web/dist/**`
- Deploy: `functions/auth-service/**`

- [ ] **Step 1: Run all automated checks**

Run:

```bash
node --test functions/auth-service/index.test.js functions/auth-service/lib/cloudbase-associations.test.js
pnpm test
pnpm build
git diff --check
```

Expected: all tests pass; build completes with only the known bundle-size advisory.

- [ ] **Step 2: Verify responsive rendering**

Run the production build locally and inspect the login, bootstrap, callback, and pending states at desktop and 320px widths. Confirm no overflow, readable copy, visible focus rings, disabled submitting controls, and no login-button flash during initial recovery.

- [ ] **Step 3: Deploy the web build**

Run:

```bash
pnpm exec tcb hosting deploy apps/web/dist --verify --env-id "$VITE_CLOUDBASE_ENV_ID"
```

Expected: upload and remote verification succeed.

- [ ] **Step 4: Deploy auth-service only if its code changed during implementation**

Run the existing environment-safe deployment wrapper so generic `CLOUDBASE_SERVER_SECRET_ID` and `CLOUDBASE_SERVER_SECRET_KEY` are provided without printing their values.

Expected: `Cloud function deployed successfully` or no function deployment when backend code is unchanged.

- [ ] **Step 5: Run production smoke checks**

Verify the hosting root returns the new hashed bundle, `/api/auth/start` returns 302 to Feishu, and `/api/auth/profile` without a cookie returns 401. Do not print OAuth state, cookies, tickets, or credentials.

- [ ] **Step 6: Commit any release-only documentation changes**

```bash
git status --short
```

Expected: clean worktree. If no documentation changed, do not create an empty commit.
