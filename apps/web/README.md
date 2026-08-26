# Travel Planner

## Local setup

From the repository root, install dependencies and start the Vite app:

```bash
pnpm install
pnpm dev
```

Copy `apps/web/.env.example` to `apps/web/.env` for client configuration. Keep the server-only AMap service key in the root `.env`.

## Validation

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm e2e --grep "travel app shell"
```
