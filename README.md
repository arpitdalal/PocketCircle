# PocketCircle

Local-first monorepo for the PocketCircle web app, Convex backend, and domain package.

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
pnpm --filter @pocketcircle/convex dev
```

Set the backend auth env vars on the Convex dev deployment (the app origin and
Google credentials Better Auth needs):

```sh
pnpm --filter @pocketcircle/convex exec convex env set SITE_URL http://127.0.0.1:5173
pnpm --filter @pocketcircle/convex exec convex env set GOOGLE_CLIENT_ID <id>
pnpm --filter @pocketcircle/convex exec convex env set GOOGLE_CLIENT_SECRET <secret>
pnpm --filter @pocketcircle/convex exec convex env set BETTER_AUTH_SECRET <secret>
pnpm --filter @pocketcircle/convex exec convex env set RESEND_API_KEY <resend-api-key>
pnpm --filter @pocketcircle/convex exec convex env set RESEND_FROM_EMAIL <verified-from-address>
# Feedback delivery recipient (set to the public support address unless intentionally routed elsewhere)
pnpm --filter @pocketcircle/convex exec convex env set SUPPORT_EMAIL arpitdalalm@gmail.com
# Optional: log email subject + HTML to the Convex console on every send (also logs when Resend creds are unset)
pnpm --filter @pocketcircle/convex exec convex env set EMAIL_DEV_LOG 1
```

Open `/dev/email-preview` while running the web app in dev (or E2E) to render sample transactional emails in the browser.

## Run App

```sh
pnpm --filter @pocketcircle/web-app dev --host 127.0.0.1
```

Open:

```text
http://127.0.0.1:5173/
```

In normal local dev, `Continue with Google` starts the real Google OAuth flow against real vendors, so authentication is exercised before production.

To bypass auth and mock third-party vendors (Resend, PostHog, Sentry) via MSW, run mock mode with the `VITE_MOCKS` flag:

```sh
pnpm --filter @pocketcircle/web-app dev:mocks --host 127.0.0.1
```

## Checks

```sh
pnpm test
pnpm typecheck
pnpm build
```

## Production Deployment

Production uses the default provider URLs documented in ADR 0007:

- Web: `https://pocketcircle.app`
- API: the production deployment's `*.convex.cloud` URL
- Auth/HTTP actions: the same production deployment's `*.convex.site` URL

`.github/workflows/deploy.yml` validates and builds the app, deploys the Convex
backend, then publishes `apps/web-app/build/client` as Cloudflare Worker static
assets. Cloudflare's `single-page-application` fallback in `wrangler.jsonc`
serves `index.html` for direct navigation to client routes.

Configure the GitHub `production` environment before the first deployment:

- Under **Deployment branches and tags**, allow only the selected tag pattern `v*`.
- Add at least one required reviewer who is not the person initiating deployments,
  then enable **Prevent self-review**.
- Add a tag ruleset for `v*` that restricts updates and deletion. Release tags are
  immutable; use a new tag for a fix or rollback.

The release workflow runs the real E2E suite again, waits for the production
approval, then deploys only an immutable stable SemVer tag (`vMAJOR.MINOR.PATCH`).
Merges to `main` run CI/E2E but never deploy production.

Configure these GitHub Actions secrets:

```text
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
CONVEX_DEPLOY_KEY
```

The Cloudflare token needs `Account → Workers Scripts → Edit`, scoped to the
deployment account, and `Zone → Workers Routes → Edit`, scoped to
`pocketcircle.app`. The Convex key needs only `deployment:deploy`, scoped to the
production deployment.

Configure these GitHub Actions variables with the URLs shown by the Convex
production deployment:

```text
VITE_CONVEX_URL=https://<production-deployment>.convex.cloud
VITE_CONVEX_SITE_URL=https://<production-deployment>.convex.site
```

The MCP Worker is bound to `VITE_CONVEX_SITE_URL` at deploy time (same origin the
SPA uses). Do not hardcode a guessed `*.convex.site` host in
`packages/mcp-worker/wrangler.jsonc`.

These observability variables are optional for the first infrastructure deploy;
set them and redeploy before beta monitoring begins:

```text
VITE_SENTRY_DSN=https://<key>@<org>.ingest.sentry.io/<project>
VITE_POSTHOG_KEY=phc_<project-key>
VITE_POSTHOG_HOST=https://us.i.posthog.com
```

`VITE_SENTRY_DSN` is the single production DSN. After a successful Convex deploy,
`.github/workflows/deploy.yml` copies it to Convex `SENTRY_DSN` and sets
`APP_RELEASE` (release tag plus full commit SHA) plus `SENTRY_ENVIRONMENT=production`.
Clearing the GitHub variable removes `SENTRY_DSN` so backend reporting stops with
the frontend. Do not set those three Convex vars by hand in production.

Set the remaining backend variables on the **production** Convex deployment:

```text
SITE_URL=https://pocketcircle.app
BETTER_AUTH_SECRET=<new-production-secret>
GOOGLE_CLIENT_ID=<google-oauth-client-id>
GOOGLE_CLIENT_SECRET=<google-oauth-client-secret>
RESEND_API_KEY=<resend-api-key>
RESEND_FROM_EMAIL=<verified-from-address>
SUPPORT_EMAIL=arpitdalalm@gmail.com
```

Leave `E2E_TEST_AUTH` and `EMAIL_DEV_LOG` unset in production. Google OAuth must
allow the exact callback URL:

```text
https://<production-deployment>.convex.site/api/auth/callback/google
```

Resend's `onboarding@resend.dev` test sender can deliver only to the Resend
account owner. Invitations and Account Deletion verification for other beta
users require a verified sender domain.

Before tagging, prepare the versioned `CHANGELOG.md` section on `main` (the
repo-local `$generate-changelog` skill drafts it). The deployment workflow
requires the exact heading `## [vMAJOR.MINOR.PATCH] - YYYY-MM-DD`, then
publishes that section as the GitHub Release only after production succeeds.

Tag the tested release-preparation commit and push the tag:

```sh
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0
```

The workflow fails before deployment when a required secret or Convex URL
variable is missing.

### End-to-end (Playwright)

E2E runs against a real, ephemeral self-hosted Convex backend, not mocks (ADR
[0019](docs/adr/0019-e2e-against-self-hosted-convex-backend.md)). `pnpm test:e2e` alone
only boots the frontend and fails with `Failed to fetch`; use the wrapper, which boots
the backend, deploys, runs the suite, and tears it down (needs Docker):

```sh
pnpm test:e2e:local
```

See [`e2e/README.md`](e2e/README.md) for details and how to reproduce a red CI E2E job.
