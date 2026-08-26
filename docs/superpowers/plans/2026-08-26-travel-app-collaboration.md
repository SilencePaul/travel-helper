# Travel App CloudBase Collaboration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the local repository with a secure CloudBase implementation where only the two allowlisted Feishu users can log in, edit the trip, observe real-time changes, resolve conflicts, inspect history, and upload images.

**Architecture:** Feishu OAuth ends at a public CloudBase callback that verifies identity and creates a short-lived single-use exchange code. The browser exchanges that code for a CloudBase custom-login ticket, then reads and watches allowlisted trip data; all versioned writes go through `trip-api` transactions so conflicts and audit records are authoritative.

**Tech Stack:** CloudBase Web SDK v3, CloudBase custom login, CloudBase document database/watch/storage/functions, Feishu OpenAPI OAuth, Zod, Vitest, Playwright.

---

### Task 1: Add CloudBase configuration and environment validation

**Files:**
- Create: `packages/contracts/src/environment.ts`
- Create: `packages/contracts/src/environment.test.ts`
- Create: `apps/web/src/infrastructure/cloudbaseClient.ts`
- Create: `functions/trip-api/package.json`
- Create: `functions/trip-api/index.js`
- Create: `functions/auth-callback/package.json`
- Create: `functions/auth-callback/index.js`
- Create: `cloudbase/database.rules.json`
- Create: `cloudbase/storage.rules.json`
- Create: `cloudbaserc.json`
- Modify: `.env.example`

- [ ] **Step 1: Write failing environment-schema tests**

```ts
import { expect, test } from "vitest";
import { ServerEnvironmentSchema } from "./environment";

test("rejects missing server secrets", () => {
  expect(() => ServerEnvironmentSchema.parse({ CLOUDBASE_ENV_ID: "env" }))
    .toThrow(/FEISHU_APP_ID/);
});

test("parses exactly two allowed Feishu IDs", () => {
  const parsed = ServerEnvironmentSchema.parse(validEnvironment);
  expect(parsed.FEISHU_ALLOWED_OPEN_IDS.split(",")).toHaveLength(2);
});
```

- [ ] **Step 2: Implement exact client/server environment schemas**

Client fields: `VITE_CLOUDBASE_ENV_ID`, `VITE_CLOUDBASE_PUBLISHABLE_KEY`, `VITE_AUTH_CALLBACK_URL`, `VITE_DATA_MODE`. Server fields: CloudBase environment and custom-login credential JSON, Feishu app credentials, two comma-separated allowed Open IDs, public app URL, and 32-byte auth-code signing secret. Trim values and reject empty strings.

- [ ] **Step 3: Initialize one browser SDK instance**

Install the browser and function dependencies after the directories and their package files exist:

```bash
pnpm --dir apps/web add @cloudbase/js-sdk
pnpm --dir functions/auth-callback add @cloudbase/js-sdk zod jsonwebtoken
pnpm --dir functions/trip-api add @cloudbase/js-sdk zod
pnpm add -Dw @cloudbase/cli
```

Create `cloudbaseClient.ts`:

```ts
import cloudbase from "@cloudbase/js-sdk";
import { ClientEnvironmentSchema } from "@travel/contracts";

const env = ClientEnvironmentSchema.parse(import.meta.env);
export const cloudbaseApp = cloudbase.init({
  env: env.VITE_CLOUDBASE_ENV_ID,
  accessKey: env.VITE_CLOUDBASE_PUBLISHABLE_KEY
});
export const cloudbaseAuth = cloudbaseApp.auth();
export const cloudbaseDb = cloudbaseApp.database();
```

- [ ] **Step 4: Add declarative function configuration**

`cloudbaserc.json` must declare `functions/auth-callback` as a public HTTP function at `/auth/feishu/callback` and `functions/trip-api` as an authenticated event function. Use environment ID interpolation supported by the CLI; do not put secrets in the file.

Use deny-by-default rules. User-facing documents must carry `memberUids`; client reads require `auth != null && auth.uid in doc.memberUids`, and client writes are `false` because authoritative writes go through `trip-api`. Storage requires an authenticated custom-login user; `trip-api` still verifies trip membership before adding the resulting media record.

`cloudbase/database.rules.json`:

```json
{
  "read": "auth != null && auth.uid in doc.memberUids",
  "write": false
}
```

`cloudbase/storage.rules.json`:

```json
{
  "read": "auth != null && auth.loginType == 'CUSTOM'",
  "write": "auth != null && auth.loginType == 'CUSTOM'"
}
```

Apply the rule files to every user-readable trip collection and the travel-photo storage path, then verify in console that the default for all other resources remains deny.

- [ ] **Step 5: Verify and commit**

Run: `pnpm test && pnpm typecheck && pnpm exec tcb validate`

Expected: tests pass; `tcb validate` reports the two function resources and no embedded secret.

```bash
git add packages apps functions cloudbaserc.json .env.example
git commit -m "chore: configure CloudBase services"
```

### Task 2: Implement Feishu OAuth with an allowlist and one-time exchange

**Files:**
- Create: `functions/auth-callback/lib/feishu.js`
- Create: `functions/auth-callback/lib/exchangeCode.js`
- Create: `functions/auth-callback/index.test.js`
- Modify: `functions/auth-callback/index.js`
- Create: `apps/web/src/features/auth/LoginPage.tsx`
- Create: `apps/web/src/features/auth/AuthCallbackPage.tsx`
- Create: `apps/web/src/features/auth/authUrl.ts`
- Create: `apps/web/src/features/auth/authUrl.test.ts`

- [ ] **Step 1: Write failing OAuth URL and denied-user tests**

```ts
expect(buildFeishuAuthorizeUrl({ appId: "cli_1", redirectUri: "https://trip.example/auth", state: "abc" }))
  .toBe("https://accounts.feishu.cn/open-apis/authen/v1/authorize?app_id=cli_1&redirect_uri=https%3A%2F%2Ftrip.example%2Fauth&state=abc");
```

The callback test mocks Feishu user info with `open_id="ou_denied"` and expects HTTP `403` with a generic Chinese denial message; it must not include the received Open ID or allowlist.

- [ ] **Step 2: Exchange Feishu code for verified user identity**

`feishu.js` performs, with checked HTTP status and Zod response validation:

1. `POST https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal`
2. `POST https://open.feishu.cn/open-apis/authen/v1/access_token` with the authorization code
3. `GET https://open.feishu.cn/open-apis/authen/v1/user_info`

Return only `{ openId, name, avatarUrl }`. Never log Feishu app secret, app token, user token, authorization code, or response bodies.

- [ ] **Step 3: Map Feishu identity to a valid CloudBase custom UID**

Use SHA-256 so IDs meet the CloudBase 4–32 character restriction:

```js
import { createHash } from "node:crypto";

export function cloudbaseUid(openId) {
  return `fs_${createHash("sha256").update(openId).digest("hex").slice(0, 29)}`;
}
```

- [ ] **Step 4: Create a five-minute single-use exchange code**

After allowlist success, call the server SDK's `auth.createTicket(uid)`, store `{ codeHash, ticket, openId, expiresAt, usedAt: null }` in `auth_exchange_codes`, and redirect to `${PUBLIC_APP_URL}/auth/callback?code=<random-32-byte-base64url>&state=<state>`. Store only a SHA-256 hash of the raw code. The exchange action atomically marks the record used and returns the ticket once.

- [ ] **Step 5: Complete custom-ticket sign-in in the browser**

`LoginPage` creates a cryptographically random state, saves it to `sessionStorage`, and redirects to Feishu. `AuthCallbackPage` compares returned state with the stored value, calls public exchange, then executes:

```ts
await cloudbaseAuth.signInWithCustomTicket(async () => ticket);
window.history.replaceState({}, "", "/");
```

On mismatch, stop with `登录状态校验失败，请重新登录`.

- [ ] **Step 6: Verify and commit**

Run: `pnpm test && pnpm typecheck`

Expected: allowed user flow passes; denied user, expired code, reused code, and state mismatch tests pass.

```bash
git add functions/auth-callback apps/web/src/features/auth
git commit -m "feat: add allowlisted Feishu login"
```

### Task 3: Persist trips through versioned CloudBase commands

**Files:**
- Create: `functions/trip-api/lib/tripCommands.js`
- Create: `functions/trip-api/lib/authorization.js`
- Create: `functions/trip-api/lib/tripCommands.test.js`
- Create: `apps/web/src/infrastructure/cloudBaseTripRepository.ts`
- Create: `apps/web/src/infrastructure/cloudBaseTripRepository.test.ts`
- Modify: `apps/web/src/app/TripProvider.tsx`

- [ ] **Step 1: Write failing authorization and stale-write tests**

Tests must prove:

- A caller whose custom UID is absent from `trip.memberUids` receives `FORBIDDEN`.
- Saving with `expectedVersion=3` against version `4` returns `{ code: "VERSION_CONFLICT", currentVersion: 4 }` and does not change the trip.
- A successful save increments version exactly once and writes one operation log.

- [ ] **Step 2: Implement the transactional save command**

`saveTrip` accepts `{ tripId, expectedVersion, patch, idempotencyKey }`. In one database transaction:

1. Load caller identity and trip.
2. Verify membership.
3. Return the prior result when `idempotencyKey` already exists.
4. Compare versions.
5. Validate the patched trip with `TripSchema`.
6. Write the trip with `version + 1`.
7. Write an operation log containing actor, timestamp, changed fields, old values, new values, and idempotency key.

- [ ] **Step 3: Implement the CloudBase repository adapter**

`load` reads the trip and validates it. `save` invokes `trip-api` with action `saveTrip`. Map service errors to `VersionConflictError`, `ForbiddenError`, or `RepositoryUnavailableError`; UI code must not parse raw CloudBase messages.

- [ ] **Step 4: Switch repositories by environment**

`TripProvider` selects `LocalTripRepository` only when `VITE_DATA_MODE=local`; production uses `CloudBaseTripRepository`. Show the current sync state in the top bar.

- [ ] **Step 5: Verify and commit**

Run: `pnpm test && pnpm typecheck`

Expected: PASS.

```bash
git add functions/trip-api apps/web/src/infrastructure apps/web/src/app
git commit -m "feat: persist versioned travel plans"
```

### Task 4: Add real-time subscriptions with correct lifecycle

**Files:**
- Modify: `apps/web/src/infrastructure/cloudBaseTripRepository.ts`
- Create: `apps/web/src/infrastructure/realtimeReducer.ts`
- Create: `apps/web/src/infrastructure/realtimeReducer.test.ts`
- Modify: `apps/web/src/app/TripProvider.tsx`

- [ ] **Step 1: Write failing initialization/change/removal tests**

Test `snapshot.type="init"`, an incremental update, a document leaving the query, a repeated snapshot, and watcher error. The reducer must not duplicate a trip or treat a query removal as a hard delete.

- [ ] **Step 2: Implement one watcher per active trip**

Use:

```ts
const watcher = cloudbaseDb.collection("trips").doc(tripId).watch({
  onChange: snapshot => onChange(normalizeTripSnapshot(snapshot)),
  onError: error => onConnectionState("reconnecting", error)
});
return () => { void watcher.close(); };
```

Close the old watcher before starting another and on provider unmount. Ignore snapshots at or below the currently applied version.

- [ ] **Step 3: Surface honest connection states**

Top bar states are `已同步`, `正在保存`, `离线`, and `正在重连`. Never show `已同步` while a save or watcher recovery is pending.

- [ ] **Step 4: Add a two-page Playwright sync test**

Open two authenticated contexts, edit a note and toggle a booking in page A, and assert page B updates without reload. Then close and reopen the day page three times and assert only one update event is observed for the next write.

- [ ] **Step 5: Verify and commit**

Run: `pnpm test && pnpm e2e --grep "real-time"`

Expected: PASS.

```bash
git add apps/web e2e
git commit -m "feat: synchronize trip edits in real time"
```

### Task 5: Add conflicts, audit history, undo, and recoverable deletion

**Files:**
- Create: `packages/contracts/src/history.ts`
- Create: `functions/trip-api/lib/historyCommands.js`
- Create: `apps/web/src/features/history/ConflictDialog.tsx`
- Create: `apps/web/src/features/history/HistoryDrawer.tsx`
- Create: `apps/web/src/features/history/HistoryDrawer.test.tsx`

- [ ] **Step 1: Write failing same-field conflict tests**

Start from version `5`; have A change `hotelId`, then have B submit a different `hotelId` from version `5`. Assert B receives both current and attempted values and neither is silently discarded.

- [ ] **Step 2: Implement field-level conflict responses**

When the base version is stale, compare the submitted patch fields with the operation log since that version. Auto-rebase disjoint fields; return `FIELD_CONFLICT` for overlapping fields with `{ path, currentValue, attemptedValue, currentActor, currentChangedAt }`.

- [ ] **Step 3: Implement history and inverse operations**

History lists actor name, timestamp, entity, and human-readable change. Undo submits a new versioned command containing inverse values; it never deletes the original audit row. Delete actions set `deletedAt` and `deletedBy`; restore clears them via another logged command.

- [ ] **Step 4: Verify and commit**

Run: `pnpm test && pnpm e2e --grep "conflict|history|undo"`

Expected: PASS.

```bash
git add packages/contracts functions/trip-api apps/web e2e
git commit -m "feat: add conflict-safe travel history"
```

### Task 6: Add authorized photo upload

**Files:**
- Create: `packages/contracts/src/media.ts`
- Create: `apps/web/src/infrastructure/mediaRepository.ts`
- Create: `apps/web/src/features/places/PhotoUploader.tsx`
- Create: `apps/web/src/features/places/PhotoUploader.test.tsx`

- [ ] **Step 1: Write failing validation tests**

Accept JPEG, PNG, and WebP up to 8 MB. Reject SVG, executable content types, missing alt text, and oversized files before upload.

- [ ] **Step 2: Upload to an isolated trip path**

Use `trips/<tripId>/places/<placeId>/<uuid>.<ext>`. After storage upload, submit a versioned trip command containing storage file ID, width, height, alt text, uploader, and timestamp. Do not store a temporary signed URL in the trip record.

- [ ] **Step 3: Verify access control and commit**

Test that a non-member cannot obtain the photo record or download URL. Test upload progress, failure retry, and deletion restore.

```bash
git add packages/contracts apps/web
git commit -m "feat: add authorized travel photo uploads"
```

### Task 7: Perform the collaboration checkpoint

**Files:**
- Modify only files implicated by verified findings

- [ ] **Step 1: Run all automated checks**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm e2e`

Expected: all exit `0`.

- [ ] **Step 2: Verify three identities**

Use separate browser contexts for 一鸣, 美垚, and a non-allowlisted Feishu account. Both allowed users can load and sync edits; the third sees only the denial screen and no trip network payload.

- [ ] **Step 3: Verify conflict and recovery paths**

Simultaneously edit the same hotel, resolve the conflict, inspect history, undo, soft-delete a day item, and restore it. Confirm every action appears once in history.

- [ ] **Step 4: Commit the checkpoint**

```bash
git add apps packages functions e2e cloudbaserc.json
git commit -m "feat: add Feishu CloudBase collaboration"
```
