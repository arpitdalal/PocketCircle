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

MCP (optional but required for Connections / consent locally):

1. Set in root `.env.local` (see `.env.example`):
   `VITE_MCP_WORKER_ORIGIN=http://127.0.0.1:8787`
2. Generate shared Worker↔Convex secrets and install the Convex-side verifiers
   on the cloud dev deployment (root `.env.local` is not read by Convex):

```sh
MCP_WORKER_HMAC_SECRET="$(openssl rand -base64 32)"
MCP_KEY_OUTPUT="$(node scripts/generate-mcp-worker-key.mjs)"
MCP_WORKER_SIGNING_PRIVATE_JWK="$(printf '%s\n' "$MCP_KEY_OUTPUT" | sed -n '1s/^[^=]*=//p')"
MCP_WORKER_VERIFYING_JWKS="$(printf '%s\n' "$MCP_KEY_OUTPUT" | sed -n '2s/^[^=]*=//p')"
pnpm --filter @pocketcircle/convex exec convex env set MCP_WORKER_HMAC_SECRET "$MCP_WORKER_HMAC_SECRET"
pnpm --filter @pocketcircle/convex exec convex env set MCP_WORKER_VERIFYING_JWKS "$MCP_WORKER_VERIFYING_JWKS"
```

3. `cp packages/mcp-worker/.dev.vars.example packages/mcp-worker/.dev.vars` and set
   `MCP_WORKER_HMAC_SECRET` / `MCP_WORKER_SIGNING_PRIVATE_JWK` to those same values
   (private JWK stays Worker-only). Set `CONVEX_SITE_URL` to the same value as root
   `VITE_CONVEX_SITE_URL` (your cloud `*.convex.site`). Use `http://127.0.0.1:3211`
   only with the self-hosted Docker backend. Keep `APP_ORIGIN` on the same port as
   Vite (`localhost` and `127.0.0.1` are interchangeable for Worker CORS).

```sh
pnpm dev
```

Runs the web app, MCP Worker, and Convex together (`dev:web`, `dev:mcp`, `dev:convex`).
For web only: `pnpm dev:web`. MCP alone: `pnpm dev:mcp`.

Open:

```text
http://127.0.0.1:5173/
```

In normal local dev, `Continue with Google` starts the real Google OAuth flow against real vendors, so authentication is exercised before production.

To bypass auth and mock third-party vendors (Resend, PostHog, Sentry) via MSW:

```sh
pnpm dev:web:mocks -- --host 127.0.0.1
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
backend, publishes `apps/web-app/build/client` as Cloudflare Worker static
assets, then deploys and smoke-tests the MCP Worker. Cloudflare's
`single-page-application` fallback in `wrangler.jsonc` serves `index.html` for
direct navigation to client routes.

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
MCP_WORKER_HMAC_SECRET
MCP_WORKER_SIGNING_PRIVATE_JWK
MCP_WORKER_VERIFYING_JWKS
```

Generate `MCP_WORKER_HMAC_SECRET` with at least 32 random bytes. The workflow
installs it on both services only for signed browser handoffs and approval
tokens. Generate the Worker assertion key pair with:

```sh
node scripts/generate-mcp-worker-key.mjs
```

Store the printed private JWK as `MCP_WORKER_SIGNING_PRIVATE_JWK` and the public
JWKS as `MCP_WORKER_VERIFYING_JWKS`. Convex receives only the public keys, so it
cannot forge Worker service assertions. All three values are secrets, never
GitHub Actions variables or committed configuration.

The Cloudflare token needs `Account → Workers Scripts → Edit` and
`Account → Workers KV Storage → Edit`, scoped to the deployment account. The
root web Worker also needs `Zone → Workers Routes → Edit`, scoped to
`pocketcircle.app`. The Convex key needs only `deployment:deploy`, scoped to the
production deployment.

Configure these GitHub Actions variables with the URLs shown by the Convex
production deployment:

```text
VITE_CONVEX_URL=https://<production-deployment>.convex.cloud
VITE_CONVEX_SITE_URL=https://<production-deployment>.convex.site
MCP_OAUTH_KV_NAMESPACE_ID=<cloudflare-kv-namespace-id>
VITE_MCP_WORKER_ORIGIN=https://mcp.pocketcircle.app
```

Create the OAuth namespace once with the production Cloudflare account selected
(title is account-scoped; the Worker binds it as `POCKET_CIRCLE_OAUTH_KV`):

```sh
pnpm --filter @pocketcircle/mcp-worker exec wrangler kv namespace create POCKET_CIRCLE_OAUTH_KV
```

Copy the returned namespace ID into the GitHub Actions variable
`MCP_OAUTH_KV_NAMESPACE_ID` (repo or `production` environment — deploy reads
`vars.MCP_OAUTH_KV_NAMESPACE_ID`). Do not hardcode the id in `wrangler.jsonc`;
the deploy workflow substitutes the placeholder at release time. The MCP Worker
name is `pocketcircle-mcp-worker`. Production clients use custom domain
`https://mcp.pocketcircle.app` (`VITE_MCP_WORKER_ORIGIN`); `workers.dev` stays
enabled for rollback. The first MCP deployment creates the Durable Object namespace
and daily cleanup cron from `wrangler.jsonc`; KV is the only manually provisioned
resource. The workflow binds the Worker to `VITE_CONVEX_SITE_URL`. Do not hardcode
a guessed `*.convex.site` host in `packages/mcp-worker/wrangler.jsonc`.

Pre-register a launch client through the OAuth provider API; never write its KV
record by hand. Enable the provisioning route only for the operation, use a
fresh token containing at least 32 random bytes, then remove the secret so the
route returns `404`:

```sh
MCP_WORKER_ORIGIN="https://mcp.pocketcircle.app"
MCP_PROVISIONING_TOKEN="$(openssl rand -base64 32)"
printf '%s' "${MCP_PROVISIONING_TOKEN}" \
  | pnpm --filter @pocketcircle/mcp-worker exec wrangler secret put MCP_CLIENT_PROVISIONING_TOKEN
printf '%s\n' \
  "header = \"Authorization: Bearer ${MCP_PROVISIONING_TOKEN}\"" \
  'header = "Content-Type: application/json"' \
  'data = {"clientName":"<client-name>","clientUri":"https://<client-homepage>","redirectUris":["https://<client-callback>"]}' \
  | curl --fail-with-body --silent --show-error \
      --config - \
      "${MCP_WORKER_ORIGIN}/admin/oauth/clients"
unset MCP_PROVISIONING_TOKEN MCP_WORKER_ORIGIN
pnpm --filter @pocketcircle/mcp-worker exec wrangler secret delete MCP_CLIENT_PROVISIONING_TOKEN
```

The response contains the pre-registered `clientId` to configure in that client.
Repeating the exact metadata returns the same ID, so retrying a lost response is
safe. The endpoint always creates a public authorization-code client with PKCE;
it cannot create a client secret or enable another grant type. Prefer paste-URL
setup for assistants: CIMD (preferred) and rate-limited Dynamic Client
Registration (compatibility for Cursor-class clients) both work with only
`https://mcp.pocketcircle.app/mcp`. Keep admin pre-registration for rare
partner/static clients — do not leave `MCP_CLIENT_PROVISIONING_TOKEN` enabled
in production for normal use.

To rotate the browser-envelope HMAC without interrupting an authorization
already in progress:

1. Set `MCP_WORKER_HMAC_SECRET_PREVIOUS` to the old secret in the GitHub
   `production` environment.
2. Replace `MCP_WORKER_HMAC_SECRET` with the new secret and deploy a release.
3. Wait through the operational rollback window (and at least ten minutes) after
   the MCP Worker deployment.
4. Remove `MCP_WORKER_HMAC_SECRET_PREVIOUS` and deploy another release.

The workflow adds the previous Convex verifier before changing the current key.
It removes that verifier when the optional secret is absent. Never add the
previous secret to the Worker itself.

For rollback, keep the previous HMAC verifier through the full operational
rollback window, not only the ten-minute handoff lifetime. Across a key rotation,
redeploy compatible old code with the current Worker secret; do not use
`wrangler rollback` to restore a version bound to the retired secret. Do not
recreate or rebind the OAuth KV namespace, and do not remove the Convex bridge
while the MCP Worker is reachable; Cloudflare storage bindings and Durable
Object migrations do not roll back with Worker code.

To rotate the Worker assertion key pair, generate a new pair, set the private
JWK secret to the new key, and set the public JWKS secret to `{ "keys": [new,
old] }` before deploying. The workflow installs the public keys before the new
Worker signer. Keep the old public key through the operational rollback window,
then remove it and deploy again. JWKS accepts at most the current and previous
P-256 public keys, identified by unique `kid` values.

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
