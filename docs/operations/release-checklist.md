# Production release checklist

Complete this checklist for each release. Values below are identifiers and operational facts only; never record credential values, tokens, private keys, cookies, or screenshots containing them.

## Release record

- [ ] Release owner and reviewer recorded in the change ticket.
- [ ] Git worktree is clean except for explicitly approved untracked research artifacts.
- [ ] Rollback tag created: `travel-app-predeploy-<YYYY-MM-DD>`.
- [ ] Production app URL: `<PRODUCTION_APP_URL>`.
- [ ] CloudBase environment: `<CLOUDBASE_ENV_ID>`.
- [ ] CloudBase deployment ID: `<DEPLOYMENT_ID>`.
- [ ] Hosting version and `auth-service`/`trip-api`/`agent-api` revisions recorded in the change ticket.
- [ ] Backup/export location: `<BACKUP_LOCATION>`; restore owner: `<RESTORE_OWNER>`.

## Configuration and security gate

- [ ] `node scripts/check-production-config.mjs` passes without printing values.
- [ ] `pnpm exec tcb validate` exits `0` and shows only the intended functions/resources.
- [ ] Custom Login is enabled; the private credential is stored as `CLOUDBASE_CUSTOM_LOGIN_CREDENTIALS_BASE64` in managed function configuration, not in Git or `.env.local`.
- [ ] Database rules allow member reads only and deny browser writes to authoritative collections.
- [ ] OPA policy and CloudBase rules agree: default deny, member read, server-only command write.
- [ ] CloudBase safe origins contain only the production HTTPS origin and approved local origin.
- [ ] The public auth gateway route enforces per-client QPS limiting; OAuth/auth records have bounded lifecycle cleanup.
- [ ] `/api/agent` targets only `agent-api`/`index.agentMain`, retains the reviewed per-client QPS limit, and rejects a malformed action and an invalid signature without reading member/trip data.
- [ ] `trip-api` invoke ACL still requires authenticated CloudBase identity; only the isolated `agent-api` invoke ACL is public.
- [ ] Feishu redirect is exactly `<AUTH_SERVICE_URL>/api/auth/callback`; minimum identity permissions are enabled.
- [ ] Feishu application availability is limited to the intended tenant/users where possible; no identity or secret appears in logs.
- [ ] Membership approval is the admission boundary: the traveler sends the waiting-page identity code to the admin through a separate trusted Feishu chat or in person, pending accounts cannot read trip data, and approving a third active member is rejected.
- [ ] AMap JS/Web keys, security code, domain whitelist, mainland/Hong Kong route entitlements, quota, and QPS are verified.
- [ ] QWeather host/project/credential/private-key configuration is present server-side; no future forecast is fabricated.

## Build and deployment gate

- [ ] `pnpm content:validate`
- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] `pnpm e2e`
- [ ] `pnpm exec tcb deploy --dry-run` matches the reviewed diff.
- [ ] Deploy functions before hosting; record the deployment ID and revisions.
- [ ] Confirm previous hosting version and function revisions remain available for rollback.

## Production smoke test

- [ ] Anonymous browser is redirected to Feishu login; callback returns to the production app.
- [ ] A newly authenticated account sees only the pending-approval state and receives no trip content.
- [ ] The intended second traveler can be approved by an admin, is atomically attached to the trip, and can load and save it after refresh.
- [ ] Attempting to approve a third active traveler shows the capacity error and does not attach that account to the trip.
- [ ] 一鸣 and 美垚 can sign in and read the shared trip.
- [ ] A non-destructive note syncs once between two sessions; version conflict and audit history behave correctly.
- [ ] Mainland and Hong Kong route results contain real provider paths (more than two points), with route text fallback available.
- [ ] POI details, restaurant/attraction drawers, hotel selection, budget, and history are readable.
- [ ] `开始导航` opens the AMap app when installed and the AMap web fallback/copy-address action when not installed.
- [ ] Dates outside the reliable weather window show `待预报`; QWeather warning/forecast timestamps are visible when available.
- [ ] PWA opens offline with the last validated snapshot; one queued note replays exactly once after reconnect.
- [ ] Feishu document embeds the exact production app URL and has the browser link-card fallback.

## Handoff and rollback

- [ ] Feishu document revision after update: `<FEISHU_DOCUMENT_REVISION>`.
- [ ] AMap capability result names: `<MAINLAND_WALKING>`, `<MAINLAND_TRANSIT>`, `<HONG_KONG_WALKING>`, `<HONG_KONG_TRANSIT>`.
- [ ] Last content validation time (Asia/Shanghai): `<YYYY-MM-DD HH:MM>`.
- [ ] QWeather state: `<PENDING/FORECAST/WARNING/DEGRADED>`; incident link if degraded: `<...>`.
- [ ] Next Codex scheduled run: `<SCHEDULE_OR_NONE>`.
- [ ] Rollback owner and command/location are documented; rollback has not been executed on a healthy release.
- [ ] If rollback is needed: freeze writes, announce incident, restore the recorded hosting version and all three function revisions, restore/remove `agent-api` plus the `/api/agent` gateway target/QPS and `trip-api`/`agent-api` ACLs to the recorded state, verify auth/read/write/Agent-signature smoke tests, then reconcile any writes made after the rollback point.
