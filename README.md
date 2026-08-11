# Spend Circle

Local-first monorepo for the Spend Circle web app, Convex backend, and domain package.

## Prerequisites

- Node.js
- pnpm
- Convex account/project
- Google OAuth web client

This repo uses pnpm workspaces. The `packageManager` field in `package.json` pins
pnpm; enable Corepack (`corepack enable`) or install pnpm ≥ that version.

## Install

```sh
pnpm install
```

## Environment

Copy `.env.example` to `.env.local` at the repo root and fill it in.

```sh
VITE_CONVEX_URL=https://<your-deployment>.convex.cloud
VITE_CONVEX_SITE_URL=https://<your-deployment>.convex.site
SITE_URL=http://127.0.0.1:5173
BETTER_AUTH_SECRET=<random-secret>
GOOGLE_CLIENT_ID=<google-oauth-client-id>
GOOGLE_CLIENT_SECRET=<google-oauth-client-secret>
```

Add this Google OAuth authorized redirect URI (auth runs as a Convex component
in SPA mode, so the callback lives at the Convex site URL, not the app origin):

```text
https://<your-deployment>.convex.site/api/auth/callback/google
```

(`<your-deployment>` is the same subdomain as in `VITE_CONVEX_SITE_URL`.)

## Configure Convex

Push backend code, install the Better Auth component, and generate the typed
API. Convex lives in `packages/convex`. The Convex CLI keeps its deployment
selector in `packages/convex/.env.local` (gitignored) — running the dev command
below for the first time walks you through login/project setup and writes
`CONVEX_DEPLOYMENT` there itself. The repo-root `.env.local` is the web app's env
file (Vite loads it via `envDir`); the Convex CLI does not read it. When switching
between cloud dev and self-hosted E2E, see [e2e/README.md — The `.env.local` gotcha](e2e/README.md#the-envlocal-gotcha).

```sh
pnpm --filter @spend-circle/convex dev
```

Set the backend auth env vars on the Convex dev deployment (the app origin and
Google credentials Better Auth needs):

```sh
pnpm --filter @spend-circle/convex exec convex env set SITE_URL http://127.0.0.1:5173
pnpm --filter @spend-circle/convex exec convex env set GOOGLE_CLIENT_ID <id>
pnpm --filter @spend-circle/convex exec convex env set GOOGLE_CLIENT_SECRET <secret>
pnpm --filter @spend-circle/convex exec convex env set BETTER_AUTH_SECRET <secret>
pnpm --filter @spend-circle/convex exec convex env set RESEND_API_KEY <resend-api-key>
pnpm --filter @spend-circle/convex exec convex env set RESEND_FROM_EMAIL <verified-from-address>
# Feedback delivery recipient (set to the public support address unless intentionally routed elsewhere)
pnpm --filter @spend-circle/convex exec convex env set SUPPORT_EMAIL arpitdalalm@gmail.com
# Optional: log email subject + HTML to the Convex console on every send (also logs when Resend creds are unset)
pnpm --filter @spend-circle/convex exec convex env set EMAIL_DEV_LOG 1
```

Open `/dev/email-preview` while running the web app in dev (or E2E) to render sample transactional emails in the browser.

## Run App

```sh
pnpm --filter @spend-circle/web-app dev --host 127.0.0.1
```

Open:

```text
http://127.0.0.1:5173/
```

In normal local dev, `Continue with Google` starts the real Google OAuth flow against real vendors, so authentication is exercised before production.

To bypass auth and mock third-party vendors (Resend, PostHog, Sentry) via MSW, run mock mode with the `VITE_MOCKS` flag:

```sh
pnpm --filter @spend-circle/web-app dev:mocks --host 127.0.0.1
```

## Checks

```sh
pnpm test
pnpm typecheck
pnpm build
```

### End-to-end (Playwright)

E2E runs against a real, ephemeral self-hosted Convex backend, not mocks (ADR
[0019](docs/adr/0019-e2e-against-self-hosted-convex-backend.md)). `pnpm test:e2e` alone
only boots the frontend and fails with `Failed to fetch`; use the wrapper, which boots
the backend, deploys, runs the suite, and tears it down (needs Docker):

```sh
pnpm test:e2e:local
```

See [`e2e/README.md`](e2e/README.md) for details and how to reproduce a red CI E2E job.
