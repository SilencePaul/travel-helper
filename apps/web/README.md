# Travel Planner

## Local setup

From the repository root, install dependencies and start the Vite app:

```bash
pnpm install
pnpm dev
```

Copy the root `.env.example` to the ignored root `.env.local`. Vite is configured with `envDir: "../.."`, so the web app reads `VITE_AMAP_JS_KEY` and `VITE_AMAP_SECURITY_CODE` from that one location. `AMAP_WEB_SERVICE_KEY` stays server-only and must never be prefixed with `VITE_`.

CloudBase mode also requires `VITE_CLOUDBASE_ENV_ID` and `VITE_AUTH_SERVICE_URL`. The latter is the public URL assigned to the deployed `auth-service` HTTP function; configure it explicitly instead of relying on a same-origin gateway route.

## Validation

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm e2e --grep "travel app shell"
```

After changing committed AMap POI IDs or coordinates, validate them locally without exposing the server key:

```bash
pnpm check:amap-pois
```
