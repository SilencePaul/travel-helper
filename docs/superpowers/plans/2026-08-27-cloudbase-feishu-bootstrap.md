# CloudBase Feishu Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let 一鸣 bootstrap a single administrator through Feishu OAuth, approve 美垚 as the second member, and synchronise the existing travel plan through CloudBase without exposing server credentials.

**Architecture:** A public HTTP CloudBase function owns the Feishu code exchange, bootstrap-code verification, membership approval, and custom-login ticket issue. A separate authenticated `trip-api` function owns versioned trip writes. The browser uses CloudBase custom login and watches the approved trip only after it has a valid ticket; local mode continues to use the current repository.

**Tech Stack:** React 19, TypeScript, Vite, Zod, Vitest, Playwright, CloudBase Web SDK v3, CloudBase Node SDK, CloudBase HTTP/event functions, Feishu OAuth.

---

## File structure

- `packages/contracts/src/environment.ts`: client/server environment schemas with secret-safe validation.
- `packages/contracts/src/membership.ts`: role and member schemas shared by browser and functions.
- `apps/web/src/infrastructure/cloudbaseClient.ts`: one lazily created custom-login CloudBase browser client.
- `apps/web/src/features/auth/*`: login, callback, first-admin bootstrap, waiting, and member-management views.
- `apps/web/src/infrastructure/authSession.ts`: browser session state and ticket exchange client.
- `apps/web/src/infrastructure/cloudbaseTripRepository.ts`: authenticated CloudBase implementation of `TripRepository` and watcher lifecycle.
- `functions/auth-service/*`: public HTTP Feishu OAuth and membership function, with no client secret exposure.
- `functions/trip-api/*`: authenticated event function for versioned trip save and audit logging.
- `cloudbase/*` / `cloudbaserc.json`: least-privilege resource declarations and rules.

### Task 1: Establish contracts and secret-safe configuration

**Files:**
- Create: `packages/contracts/src/environment.ts`
- Create: `packages/contracts/src/environment.test.ts`
- Create: `packages/contracts/src/membership.ts`
- Create: `packages/contracts/src/membership.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write failing environment tests**

```ts
import { describe, expect, it } from "vitest";
import { ClientEnvironmentSchema, ServerEnvironmentSchema } from "./environment";

describe("environment", () => {
  it("accepts only a public CloudBase environment ID in browser configuration", () => {
    expect(ClientEnvironmentSchema.parse({ VITE_DATA_MODE: "cloudbase", VITE_CLOUDBASE_ENV_ID: "travel-123" }))
      .toEqual({ VITE_DATA_MODE: "cloudbase", VITE_CLOUDBASE_ENV_ID: "travel-123" });
  });

  it("rejects a missing bootstrap secret or Feishu secret on the server", () => {
    expect(() => ServerEnvironmentSchema.parse({ VITE_CLOUDBASE_ENV_ID: "travel-123" }))
      .toThrow(/FEISHU_APP_ID|ADMIN_BOOTSTRAP_CODE/);
  });
});
```

- [ ] **Step 2: Run the contract test to confirm it fails**

Run: `pnpm --dir packages/contracts test -- environment.test.ts`

Expected: FAIL because `environment.ts` does not exist.

- [ ] **Step 3: Implement minimal schemas and membership types**

```ts
export const MemberRoleSchema = z.enum(["admin", "member", "pending", "removed"]);
export const MemberSchema = z.object({
  uid: z.string().min(4).max(32),
  displayName: z.string().min(1).max(100),
  avatarUrl: z.url().optional(),
  role: MemberRoleSchema,
  version: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  approvedAt: z.string().datetime().optional(),
});
```

`ClientEnvironmentSchema` accepts only `VITE_DATA_MODE` (`local` or `cloudbase`) and a nonempty `VITE_CLOUDBASE_ENV_ID` for cloudbase mode. `ServerEnvironmentSchema` requires the CloudBase environment, Feishu ID/secret, redirect URI, public app URL, `ADMIN_BOOTSTRAP_CODE`, `AUTH_SESSION_SECRET`, and `CLOUDBASE_CUSTOM_LOGIN_CREDENTIALS_BASE64`, which must decode to a JSON object. It must trim strings and never return or log malformed values.

Add these blank, documented variables to `.env.example` without putting secrets in committed files:

```dotenv
ADMIN_BOOTSTRAP_CODE=
PUBLIC_APP_URL=http://localhost:5173
CLOUDBASE_CUSTOM_LOGIN_CREDENTIALS_BASE64=
```

- [ ] **Step 4: Verify and commit contracts**

Run: `pnpm --dir packages/contracts test && pnpm typecheck && git diff --check`

Expected: PASS.

```bash
git add packages/contracts .env.example
git commit -m "feat: define collaboration environment contracts"
```

### Task 2: Declare CloudBase resources and secure function boundary

**Files:**
- Create: `functions/auth-service/package.json`
- Create: `functions/auth-service/index.js`
- Create: `functions/trip-api/package.json`
- Create: `functions/trip-api/index.js`
- Create: `cloudbase/database.rules.json`
- Create: `cloudbase/storage.rules.json`
- Create: `cloudbaserc.json`
- Create: `scripts/check-production-config.mjs`
- Create: `scripts/check-production-config.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing configuration checker tests**

```js
import { strict as assert } from "node:assert";
import { validateProductionConfig } from "./check-production-config.mjs";

assert.deepEqual(
  validateProductionConfig({ VITE_CLOUDBASE_ENV_ID: "env", FEISHU_APP_ID: "cli", FEISHU_APP_SECRET: "secret", ADMIN_BOOTSTRAP_CODE: "code", AUTH_SESSION_SECRET: "session", CLOUDBASE_CUSTOM_LOGIN_CREDENTIALS_BASE64: "e30=", PUBLIC_APP_URL: "https://trip.example" }),
  { ok: true, missing: [] },
);
assert.equal(validateProductionConfig({}).ok, false);
```

- [ ] **Step 2: Run the checker test to confirm it fails**

Run: `node scripts/check-production-config.test.mjs`

Expected: FAIL because the checker does not exist.

- [ ] **Step 3: Create declarative security configuration**

Declare one public HTTP function `auth-service` with only `/api/auth/*` routes and one authenticated event function `trip-api`. Configure database reads as member-only and all browser writes as denied:

```json
{ "read": "auth != null && auth.uid in doc.memberUids", "write": false }
```

The checker reports only `PASS`/`MISSING <VARIABLE>` names; it must not print values, length, prefixes, hashes, JSON errors, or `process.env`.

- [ ] **Step 4: Add dependencies and validate**

Run:

```bash
pnpm --dir apps/web add @cloudbase/js-sdk
pnpm --dir functions/auth-service add @cloudbase/node-sdk zod
pnpm --dir functions/trip-api add @cloudbase/node-sdk zod
pnpm add -Dw @cloudbase/cli
node scripts/check-production-config.test.mjs
pnpm exec tcb validate
```

Expected: checker test passes; CLI validates declarations without embedding a secret.

- [ ] **Step 5: Commit resource configuration**

```bash
git add functions cloudbase cloudbaserc.json scripts package.json pnpm-lock.yaml
git commit -m "chore: configure CloudBase collaboration services"
```

### Task 3: Implement Feishu OAuth, one-time administrator bootstrap, and ticket exchange

**Files:**
- Create: `functions/auth-service/lib/feishu.js`
- Create: `functions/auth-service/lib/members.js`
- Create: `functions/auth-service/lib/tickets.js`
- Create: `functions/auth-service/index.test.js`
- Modify: `functions/auth-service/index.js`
- Create: `apps/web/src/infrastructure/cloudbaseClient.ts`
- Create: `apps/web/src/infrastructure/authSession.ts`
- Create: `apps/web/src/infrastructure/authSession.test.ts`
- Create: `apps/web/src/features/auth/LoginPage.tsx`
- Create: `apps/web/src/features/auth/AuthCallbackPage.tsx`
- Create: `apps/web/src/features/auth/BootstrapPage.tsx`
- Create: `apps/web/src/features/auth/PendingApprovalPage.tsx`

- [ ] **Step 1: Write failing OAuth and bootstrap tests**

```js
it("consumes the bootstrap code once and creates exactly one admin", async () => {
  const first = await request("POST", "/api/auth/bootstrap", { code: "correct", oauthState: "state" });
  assert.equal(first.status, 200);
  assert.equal(first.body.role, "admin");
  const second = await request("POST", "/api/auth/bootstrap", { code: "correct", oauthState: "state" });
  assert.equal(second.status, 409);
});

it("creates a pending member without returning a custom-login ticket", async () => {
  const response = await request("GET", "/api/auth/callback?code=feishu-code&state=valid");
  assert.deepEqual(response.body, { status: "pending" });
});
```

- [ ] **Step 2: Run function and browser tests to confirm they fail**

Run: `node --test functions/auth-service/index.test.js && pnpm --dir apps/web test -- authSession.test.ts`

Expected: FAIL because routes and browser session client do not exist.

- [ ] **Step 3: Implement verified server flow**

`feishu.js` performs the Feishu app-token exchange, authorization-code exchange, and user-info request with checked HTTP status and Zod response parsing. It returns only `{ openId, displayName, avatarUrl }`.

`members.js` derives a valid CloudBase UID as `fs_${sha256(openId).slice(0, 29)}` and implements atomic operations:

```js
async function consumeBootstrap({ openId, code }) {
  // transaction: reject if an admin exists; compare the stored bootstrap-code hash;
  // create admin member and mark the bootstrap document consumed in the same transaction.
}
```

`tickets.js` creates a CloudBase custom-login ticket only for `admin` or `member` records. It never returns a ticket for `pending` or `removed` records. OAuth state is random, httpOnly/same-site cookie-backed, expires after ten minutes, and is single use. Feishu code, Feishu access tokens, ticket values, and secrets are never logged.

The public endpoints are:

```text
GET  /api/auth/start
GET  /api/auth/callback
POST /api/auth/bootstrap
POST /api/auth/ticket
POST /api/auth/logout
```

- [ ] **Step 4: Implement browser states**

`LoginPage` navigates to `/api/auth/start`. Callback page exchanges the short-lived server session for a custom ticket using:

```ts
await cloudbaseAuth.signInWithCustomTicket(async () => {
  const response = await fetch("/api/auth/ticket", { method: "POST", credentials: "include" });
  const body = await response.json() as { ticket: string };
  return body.ticket;
});
```

The bootstrap page sends the input code only once over HTTPS and then clears its field. Pending page polls no faster than every 15 seconds and has a manual refresh button. No page renders an open ID or membership list to a pending user.

- [ ] **Step 5: Verify and commit OAuth**

Run:

```bash
node --test functions/auth-service/index.test.js
pnpm --dir apps/web test -- authSession.test.ts
pnpm typecheck
```

Expected: allowed admin creates a ticket; code reuse, invalid state, pending and removed flows do not.

```bash
git add functions/auth-service apps/web/src/infrastructure apps/web/src/features/auth
git commit -m "feat: add Feishu administrator bootstrap"
```

### Task 4: Add administrator membership management and authoritative trip writes

**Files:**
- Create: `functions/trip-api/lib/commands.js`
- Create: `functions/trip-api/lib/commands.test.js`
- Modify: `functions/trip-api/index.js`
- Create: `apps/web/src/features/members/MemberManagementPage.tsx`
- Create: `apps/web/src/features/members/MemberManagementPage.test.tsx`
- Create: `apps/web/src/infrastructure/cloudbaseTripRepository.ts`
- Create: `apps/web/src/infrastructure/cloudbaseTripRepository.test.ts`
- Modify: `apps/web/src/app/TripProvider.tsx`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Write failing transaction tests**

```js
it("only an admin may approve a pending member", async () => {
  await assert.rejects(() => approveMember({ actorUid: memberUid, targetUid: pendingUid }), { code: "FORBIDDEN" });
  const result = await approveMember({ actorUid: adminUid, targetUid: pendingUid });
  assert.equal(result.role, "member");
});

it("rejects a stale save without changing the trip", async () => {
  await assert.rejects(() => saveTrip({ actorUid: memberUid, expectedVersion: 2, patch, idempotencyKey: "write-1" }), { code: "VERSION_CONFLICT" });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `node --test functions/trip-api/lib/commands.test.js && pnpm --dir apps/web test -- cloudbaseTripRepository.test.ts`

Expected: FAIL because commands and repository do not exist.

- [ ] **Step 3: Implement commands and frontend adapter**

`trip-api` authenticates the CloudBase custom UID, rechecks membership on every command, and has `approveMember`, `rejectMember`, `removeMember`, and `saveTrip` actions. `removeMember` rejects an attempt to remove the last admin. Every role or trip change is one transaction that increments its document version and appends an audit record with actor UID, action, safe changed fields, and timestamp.

`CloudBaseTripRepository.save` sends `{ tripId, expectedVersion, trip, idempotencyKey }` to `trip-api`, maps only stable service error codes, and never parses raw provider messages. `subscribe` owns exactly one CloudBase document watcher and closes it on unsubscribe; snapshots at or below the current version are ignored.

`TripProvider` chooses local repository only for `VITE_DATA_MODE=local`; cloudbase mode uses the authenticated adapter and exposes `已同步` / `正在保存` / `正在重连` / `保存失败，请重试` states.

- [ ] **Step 4: Build the member page with least disclosure**

The admin-only page renders pending display names with `批准` and `拒绝`, and active display names with `移除`. It disables its controls while a command is in flight, restores focus after completion, and displays a generic failure message. Non-admins do not receive the page route or member-list payload.

- [ ] **Step 5: Verify and commit collaboration core**

Run:

```bash
node --test functions/trip-api/lib/commands.test.js
pnpm --dir apps/web test -- MemberManagementPage.test.tsx cloudbaseTripRepository.test.ts
pnpm lint && pnpm typecheck && pnpm test
```

Expected: PASS; stale writes preserve data, the final admin is protected, and pending users cannot subscribe.

```bash
git add functions/trip-api apps/web/src/features/members apps/web/src/infrastructure apps/web/src/app apps/web/src/App.tsx
git commit -m "feat: add governed CloudBase trip collaboration"
```

### Task 5: End-to-end verification and controlled deployment preparation

**Files:**
- Create: `e2e/collaboration.spec.ts`
- Create: `docs/operations/cloudbase-feishu-setup.md`
- Modify: `apps/web/README.md`

- [ ] **Step 1: Write browser scenarios using mocked auth services**

```ts
test("admin approves a first-time member and both receive a live itinerary update", async ({ browser }) => {
  const admin = await browser.newContext();
  const member = await browser.newContext();
  // Seed admin/member custom-login sessions through the test auth endpoint.
  // Assert member sees the pending page, then receives the day-note change after approval without reload.
});
```

- [ ] **Step 2: Run the E2E test to confirm it fails**

Run: `pnpm e2e --grep "admin approves"`

Expected: FAIL until the authenticated app shell and member view exist.

- [ ] **Step 3: Implement test fixtures and operational runbook**

The runbook must give exact console actions without showing real values:

1. CloudBase → 身份认证 → 登录方式 → 启用“自定义登录”并下载私钥; base64-encode its one-line JSON and put the result in the CloudBase function secret `CLOUDBASE_CUSTOM_LOGIN_CREDENTIALS_BASE64`.
2. CloudBase → 环境管理 → HTTP 访问服务: route `/api/auth/*` to `auth-service` before entering the final Feishu HTTPS redirect URL.
3. Feishu → 安全设置: enter the exact deployed `https://<domain>/api/auth/callback` URL and publish the self-built application to the two users.
4. CloudBase console: set function secrets; do not upload `.env.local` or the downloaded private-key file.
5. Run `node scripts/check-production-config.mjs` (presence only), `pnpm exec tcb validate`, then `pnpm exec tcb deploy --dry-run`; require human confirmation before any non-dry-run deployment.

- [ ] **Step 4: Verify all local gates**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm e2e
node scripts/check-production-config.mjs
pnpm exec tcb validate
```

Expected: code checks pass; production checker reports variable names and pass/fail only; deploy remains dry-run only.

- [ ] **Step 5: Commit verification assets**

```bash
git add e2e docs/operations apps/web/README.md
git commit -m "test: verify governed travel collaboration"
```
