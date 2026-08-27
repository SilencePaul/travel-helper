# Production environment setup

This runbook is for the CloudBase production environment. It describes where each value belongs; it intentionally contains no credential values. Replace `<...>` entries from the CloudBase deployment output and Feishu/AMap consoles before using the commands.

## Deployment record

| Item | Value to record | Source |
| --- | --- | --- |
| Production app URL | `<PRODUCTION_APP_URL>` | CloudBase static hosting |
| CloudBase environment ID | `<CLOUDBASE_ENV_ID>` | CloudBase console |
| Public auth-service URL | `<AUTH_SERVICE_URL>` | CloudBase function details |
| Feishu redirect URL | `<AUTH_SERVICE_URL>/api/auth/callback` | Must exactly match the Feishu app |
| Feishu document URL | `https://icnk2498ysl1.feishu.cn/wiki/RQJtwKJaTireiQkdYzlcOMA7nHb` | Existing document |

The production app and auth-service URLs must be HTTPS. Do not use a localhost, file URL, wildcard origin, or a URL copied from a preview deployment in the production Feishu app configuration.

## CloudBase project and custom login

1. Select the production environment `<CLOUDBASE_ENV_ID>` and enable Custom Login in Authentication.
2. Create or select the server credential used by the Node SDK. Store the complete JSON credential only in the function environment as `CLOUDBASE_CUSTOM_LOGIN_CREDENTIALS_BASE64`.
3. Encode locally on a trusted operator machine; do not paste the raw JSON into a shell history or commit it:

   ```bash
   base64 < tcb_custom_login.json | tr -d '\n'
   ```

   Set the resulting value through the CloudBase secret/environment-variable UI or an approved secret manager. The browser must never receive this variable.
4. Deploy and verify that the value is available to both `auth-service` and `trip-api`; function logs must not print it.

The declarative config passes these variables by reference only. It must not contain a credential, Feishu secret, token, map key, or private key.

## Database, storage, and OPA policy

Create the collections used by the application (`trips`, `members`, `member_trip`, `auth_sessions`, `auth_exchange_codes`, `audit_logs`, and `suggestions`) before the first production bootstrap. Apply backups/point-in-time recovery according to the CloudBase plan.

Use member-based reads and server-only authoritative writes:

```json
{
  "read": "auth != null && auth.uid in doc.memberUids",
  "write": false
}
```

Storage reads/writes require a custom-login session, and `trip-api` must still check trip membership before creating a media record. No client can write a trip, member, audit, or suggestion record directly.

If policy is managed in OPA, keep the equivalent deny-by-default policy in the policy repository and review it with the CloudBase rules:

```rego
package travel.authz

default allow := false

allow if {
  input.operation == "read"
  input.authenticated == true
  input.uid in input.resource.memberUids
}

allow if {
  input.operation == "server_command"
  input.authenticated == true
  input.function == "trip-api"
  input.uid in input.resource.memberUids
}
```

Test anonymous reads, a non-member read, and a direct client write; all must be denied. Test an allowlisted member read and a versioned `trip-api` command; both must be allowed.

## Function routes and environment variables

`auth-service` is the only public HTTP function. Configure these routes:

| Route | Purpose | Access |
| --- | --- | --- |
| `GET /api/auth/start` | Create OAuth state and redirect to Feishu | Public |
| `GET /api/auth/callback` | Exchange Feishu identity and establish server session | Public callback |
| `POST /api/auth/bootstrap` | One-time administrator bootstrap | HTTPS, one-time code |
| `POST /api/auth/ticket` | Issue a short-lived CloudBase custom-login ticket | Authenticated server session |
| `POST /api/auth/logout` | Revoke the server session | Authenticated server session |

`trip-api` is an authenticated event function. It owns version checks, idempotency, membership authorization, and audit writes; it is not a browser-facing public endpoint.

Set the following in the appropriate scope:

| Variable | Scope | Handling |
| --- | --- | --- |
| `VITE_DATA_MODE=cloudbase` | build + auth-service/trip-api | Required for production |
| `VITE_CLOUDBASE_ENV_ID` | build + functions | Public environment identifier |
| `VITE_AUTH_SERVICE_URL` | build | Exact HTTPS auth-service URL |
| `PUBLIC_APP_URL` | auth-service | Exact HTTPS app URL |
| `FEISHU_APP_ID` | auth-service | Secret-managed deployment input |
| `FEISHU_APP_SECRET` | auth-service | Secret; never log |
| `FEISHU_REDIRECT_URI` | auth-service | Exact callback URL above |
| `FEISHU_ALLOWED_OPEN_IDS` | auth-service | Exactly two approved Open IDs |
| `ADMIN_BOOTSTRAP_CODE` | auth-service | One-time secret; rotate/consume after bootstrap |
| `AUTH_SESSION_SECRET` | auth-service | Long random signing secret |
| `CLOUDBASE_CUSTOM_LOGIN_CREDENTIALS_BASE64` | auth-service + trip-api | Base64 JSON private credential |
| `AMAP_WEB_SERVICE_KEY` | trip-api | Server-only Web Service key |
| `QWEATHER_API_HOST` | trip-api | Approved QWeather host |
| `QWEATHER_PROJECT_ID` | trip-api | Server-only project ID |
| `QWEATHER_CREDENTIAL_ID` | trip-api | Server-only credential ID |
| `QWEATHER_PRIVATE_KEY` | trip-api | PKCS#8 private key; secret-managed |
| `CODEX_IMPORT_TOKEN` | trip-api/import job | Secret-managed, never returned |

Browser build variables are limited to `VITE_AMAP_JS_KEY` and `VITE_AMAP_SECURITY_CODE` in addition to the CloudBase public identifiers. Never put Web Service, QWeather, Feishu, CloudBase private, or Codex credentials behind a `VITE_` prefix.

## Feishu and AMap console setup

In the Feishu app, register exactly `FEISHU_REDIRECT_URI`, enable the minimum identity/OAuth permissions required for app access token, user access token, and user information, and verify that the two approved Open IDs are the intended users (`一鸣` and `美垚`). Do not put names or IDs in client logs.

In AMap security settings:

- Allow only `<PRODUCTION_APP_URL>` (and the explicitly approved local development origin when needed); do not use `*`.
- Bind the JS key to the production domain and its security code.
- Verify Web Service permissions for walking, transit, driving, POI, mainland China, and Hong Kong routes.
- Keep the Web Service key server-side and check daily quota/QPS before release.

## Safe-origin, backup, and rollback preparation

Configure CloudBase safe origins for the production HTTPS origin and the documented local development origin only. Before deployment, export database collections and record the backup location in `release-checklist.md`. Record the hosting version, function revisions, deployment ID, and rollback tag. A rollback restores the prior hosting version and both function revisions together; do not roll back only the web bundle or only one function.

Run the secret-safe check before deployment:

```bash
node scripts/check-production-config.mjs
pnpm exec tcb validate
```

The checker may report variable names and `PASS`/`MISSING` status only. If a command prints a value, stop, rotate the exposed credential, and fix the command before continuing.
