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
# Web Push VAPID (separate key pairs for development and production — required for Push)
# Generate with: node -e "console.log(require('web-push').generateVAPIDKeys())"
pnpm --filter @pocketcircle/convex exec convex env set VAPID_PUBLIC_KEY <url-safe-base64-public>
pnpm --filter @pocketcircle/convex exec convex env set VAPID_PRIVATE_KEY <url-safe-base64-private>
pnpm --filter @pocketcircle/convex exec convex env set VAPID_SUBJECT mailto:<contact-email>
pnpm --filter @pocketcircle/convex exec convex env set VAPID_KEY_ID primary
# Gate Push sends until the display-capable service worker is live (prod deploy
# toggles this around Cloudflare; set to 1 for local/dev).
pnpm --filter @pocketcircle/convex exec convex env set PUSH_DELIVERY_ENABLED 1
# Optional: log email subject + HTML to the Convex console on every send (also logs when Resend creds are unset)
pnpm --filter @pocketcircle/convex exec convex env set EMAIL_DEV_LOG 1
```

Open `/dev/email-preview` while running the web app in dev (or E2E) to render branded transactional email templates (sample data + desktop/mobile widths).

## Run App

The marketing site is a separate static build. To serve it locally:

```sh
pnpm --filter @pocketcircle/site dev
```

### ChatGPT local MCP testing

After the one-time setup below, start the complete host-testing stack with:

```sh
pnpm dev:chatgpt
```

This starts the web app on `127.0.0.1:5173`, the local MCP Worker on
`127.0.0.1:8788`, and the named Cloudflare Tunnel configured at
`~/.cloudflared/pocketcircle-dev.yml`. The tunnel publishes
`https://mcp-dev.pocketcircle.app/mcp` to ChatGPT and supports streamed MCP
responses. Press Ctrl-C in that terminal to stop all three processes.

The script expects the cloud Convex dev deployment already configured in the
root `.env.local` and matching Worker credentials in
`packages/mcp-worker/.dev.vars`. It does not start a local Convex backend or
deploy anything. If either port is already occupied, stop the old process first.

One-time Cloudflare setup:

```sh
brew install cloudflared
cloudflared tunnel login
cloudflared tunnel create pocketcircle-dev
cloudflared tunnel route dns pocketcircle-dev mcp-dev.pocketcircle.app
```

Create `~/.cloudflared/pocketcircle-dev.yml` with the tunnel UUID and credentials
file produced by `cloudflared tunnel create`, forwarding
`mcp-dev.pocketcircle.app` to `http://127.0.0.1:8788`. Put a `^/cdn-cgi/.*`
404 rule before the Worker rule and a final catch-all 404. Keep this file and
the credentials outside the repository. The script validates that the config
exists before starting.

```yaml
tunnel: <tunnel-uuid>
credentials-file: /Users/<you>/.cloudflared/<tunnel-uuid>.json
ingress:
  - hostname: mcp-dev.pocketcircle.app
    path: ^/cdn-cgi/.*
    service: http_status:404
  - hostname: mcp-dev.pocketcircle.app
    service: http://127.0.0.1:8788
  - service: http_status:404
```

In ChatGPT developer mode, create a separate **PocketCircle Dev** connection for
`https://mcp-dev.pocketcircle.app/mcp`, complete Google sign-in and Circle
consent, and refresh the connection after Worker tool metadata changes. Start a
new chat after refreshing. Keep the production PocketCircle connection pointed
at `https://mcp.pocketcircle.app/mcp`.

MCP (optional but required for Connections / consent locally):

1. Set in root `.env.local` (see `.env.example`):
   `VITE_MCP_WORKER_ORIGIN=http://127.0.0.1:8788`
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
   Vite (`localhost` and `127.0.0.1` are interchangeable for Worker CORS). Keep the
   example `MCP_ISSUER` / `MCP_RESOURCE_URI` so Cursor against `:8788` gets matching
   OAuth metadata (local wrangler remaps the custom domain into `request.url`).
   Worker uses **8788** so Cursor can bind its OAuth loopback on **8787**.
   `MCP_DCR_ALLOWED_SCHEMES` lists private-use redirect schemes for DCR
   (`cursor,vscode` by default in wrangler / `.dev.vars.example`).

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
pnpm build:site
node plugins/pocketcircle/assert-package.mjs
```

## ChatGPT / Codex plugin (local)

Repo marketplace at `.agents/plugins/marketplace.json` → `plugins/pocketcircle`.
Install/update steps and host notes: [plugins/pocketcircle/README.md](plugins/pocketcircle/README.md).
Local install is not public directory publication.

## Production Deployment

Production uses the default provider URLs documented in ADR 0007:

- Marketing site: `https://pocketcircle.app` — the apex, served by `apps/site` as
  static files (`/`, `/privacy`, `/terms`, `/support`, `/whats-new`)
- Product app: `https://app.pocketcircle.app` — the app subdomain, served by the
  root Worker as an SPA
- API: the production deployment's `*.convex.cloud` URL
- Auth/HTTP actions: the same production deployment's `*.convex.site` URL

The apex and the app subdomain are separate origins and each has exactly one Worker,
because two Workers cannot claim one hostname. Anything a User reaches **while
signed in** — sign-in, an MCP consent screen, an Invitation, a shared Transaction
link — is on the app origin; everything public is on the apex. Every product path
the apex used to serve is a static 302 to the same path on the app origin
(`apps/site/src/legacy-redirects.ts`), so a bookmark, a shared link, or an
already-delivered email still resolves.

The web and MCP origins are written down once, in
[`packages/domain/src/origins.ts`](packages/domain/src/origins.ts) (#404). Read
them from there instead of spelling one out in code — `canonical-origins.test.ts`
fails the build if any source, config, or script hardcodes an origin. The env
values in this README are examples of what to set per deployment, not the
canonical record.

`.github/workflows/deploy.yml` validates and builds the app, deploys the Convex
backend, publishes `apps/web-app/build/client` as Cloudflare Worker static assets,
then deploys the marketing Site and the MCP Worker and verifies all three.
Cloudflare's `single-page-application` fallback in `wrangler.jsonc` serves
`index.html` for direct navigation to client routes.

The two Worker deploys are **adjacent, product first** (#411), and that ordering is
the handover. The product Worker drops the apex and the marketing Worker claims it
in the next step, so there is a sub-minute window in which no Worker holds the
hostname — every path on it, including every bookmark and every already-delivered
email, fails until one does. `apps/site/src/wrangler.test.ts` asserts the two
deploys are consecutive steps, because a reordering there ships green and widens
the gap to the length of everything between them. Nothing may sit between them, and
`apps/site` is built early in the job (so a Site that does not compile aborts the tag
before anything moves) and deployed late.

Neither Worker has a Worker script, so both cost zero invocations per request —
including every legacy redirect, which is a static `_redirects` file rather than a
script. The marketing Site is also served on a `workers.dev` hostname, which is not
what the release verifies — it is a second handle on the same Worker, for inspecting
the Site without touching the public apex and for rolling back to it if the apex
claim is the thing that broke.

After the product Worker deploy, the workflow fetches the app shell, every bundle
it names, three deep links (a Transaction, its edit link with its filters, and a
filtered search), the web manifest and its icons, and the push service worker
from the app origin and compares the bytes to the artifact the same job built,
so DNS, TLS, the SPA fallback, the header policy, and push are checked on the
deployed host rather than assumed. The manifest's `start_url` and `scope` are
relative, so the app scopes its own origin and an install cannot launch the
marketing homepage. Before any of that, the configuration check reads the
trusted origins off the production Convex deployment and fails the release if auth
does not already name the app origin the Worker is about to claim.

The marketing Site's own check asserts what a visitor gets on the apex: the homepage
and every document byte-for-byte against the artifact the
same job built, the security headers derived from the product's policy, the
*absence* of a `noindex` (the Site carried one for its `workers.dev` staging
hostname and the cutover deleted it — a `noindex` on the apex is a Google branding
failure nothing else would catch), the not-found document answering a path nothing
matches, and every legacy product path answering `302` to the same path on the app
origin **with its query string intact**. That last one is the Account Deletion
verification link, which carries its token in the query; Cloudflare documents that
`_redirects` cannot *match* on a query and is silent on whether one survives, so the
deploy reads the `Location` back rather than assuming.

The Site's page list, its sitemap, and its redirect list are all derived rather than
written down: pages from the package directory, the sitemap from the page list
minus the not-found document, the redirects from a list held against
`apps/web-app/app/routes.ts`. A route added without a redirect fails the build; a
route deleted with one still in place fails the build.

The marketing site is its own Worker (`apps/site/wrangler.jsonc`): static HTML
from `pnpm --filter @pocketcircle/site build`, no Worker script, claiming the apex.
`apps/site/src/wrangler.test.ts` and `canonical-origins.test.ts` both hold which
Worker owns which hostname. The homepage is
`apps/site/index.html`, a checked-in document rather than a template: it ships no
JavaScript, and the build substitutes the values it writes as placeholders —
`%APEX_ORIGIN%` for the canonical link and for the marketing surfaces the apex
keeps (legal, support, What's New, sitemap), `%APP_ORIGIN%` for sign-in, which is
the only destination on the app origin, and `%YEAR%` for the copyright. The two
surfaces share one
palette, font, and shape from
[`packages/brand/src/tokens.css`](packages/brand/src/tokens.css), which
`tokens.test.ts` guards against redefinition, and the site build derives its
`_headers` from the product's, so the two origins serve one security-header
policy. It claims the apex as a **custom domain**, which is what the cutover
(#411) needed and what no earlier step did — so the `CLOUDFLARE_API_TOKEN` needs
Zone → Workers Routes → Edit, which the existing token already carries for
`app.pocketcircle.app`, and wrangler provisions the DNS record and the
certificate. No binding and no secret. `workers_dev` stays on, so the Site is
reachable on a non-apex hostname for inspection and as a rollback handle; the
release verifies on the apex, because that is the only origin where a wrong
answer is possible.

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
root web Worker also needs `Zone → Workers Routes → Edit` and `Zone → DNS →
Edit`, scoped to `pocketcircle.app`: attaching a custom domain makes Cloudflare
create the DNS record for it, so a token that can attach the apex can attach a
subdomain and one that cannot write DNS cannot. (Cloudflare's API reference
documents the attach itself as `Account → Workers Scripts → Edit`; DNS edit is
the scope that covers the record it creates.) No GitHub secret is added for
this. Confirm both scopes **before** the first release that claims
`app.pocketcircle.app`: the attach happens in the product Worker deploy, after
the Convex deploy and with push delivery paused, and wrangler's error does not
name the scope it is missing. Note too that wrangler is non-interactive in CI,
so it overrides a conflicting DNS record — or an existing custom domain — on that
hostname rather than asking. Make sure nothing else already answers there. The
Convex key needs only `deployment:deploy`, scoped to the production deployment.

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
SITE_URL=https://app.pocketcircle.app
BETTER_AUTH_SECRET=<new-production-secret>
GOOGLE_CLIENT_ID=<google-oauth-client-id>
GOOGLE_CLIENT_SECRET=<google-oauth-client-secret>
RESEND_API_KEY=<resend-api-key>
RESEND_FROM_EMAIL=<verified-from-address>
SUPPORT_EMAIL=arpitdalalm@gmail.com
VAPID_PUBLIC_KEY=<url-safe-base64-public>
VAPID_PRIVATE_KEY=<url-safe-base64-private>
VAPID_SUBJECT=mailto:<contact-email>
VAPID_KEY_ID=primary
```

Use a **different** VAPID key pair than development. Generate with
`node -e "console.log(require('web-push').generateVAPIDKeys())"`. During rotation
also set `VAPID_KEY_ID_PREVIOUS`, `VAPID_PUBLIC_KEY_PREVIOUS`, and
`VAPID_PRIVATE_KEY_PREVIOUS` (same subject) until devices remigrate.

Leave `E2E_TEST_AUTH` and `EMAIL_DEV_LOG` unset in production. Google OAuth must
allow the exact callback URL:

```text
https://<production-deployment>.convex.site/api/auth/callback/google
```

That callback URL is the only one: sign-in returns to whichever app origin the
User started from, but Google always redirects to the auth deployment, so no
per-app-origin redirect URI is needed or allowed.

**Authorized JavaScript origins.** The app is served from
`https://app.pocketcircle.app` and nothing else, so that is the one entry. The
apex is the marketing Site's and is deliberately *not* authorized: it never runs the
app, so a User who signs in from it is crossing origins for no reason. This app
signs in with a server-side redirect rather than the Google JavaScript library, so
the list is not what gates sign-in (the auth deployment's own origin check is); keep
it current anyway, so the client stays valid if that ever changes and branding
verification sees a consistent client. Google redirects to the
`*.convex.site` callback either way — the app origin is where the User is returned
to *after* Google, never where Google redirects.

**Branding.** The Google branding homepage and the Privacy and Terms URLs must share
a verified domain, so they are on the apex, and the apex must stay indexable: a
`noindex` there fails verification, which is why the Site's `_headers` no longer
carries the one its `workers.dev` staging hostname used to need. After the cutover,
re-check branding with a no-JS fetch of `https://pocketcircle.app/` — it must show
the product name, purpose copy, and a Privacy link.

**Origin migration ([ADR 0035](docs/adr/0035-static-marketing-site-on-apex-and-product-spa-on-app-subdomain.md), #411).**
`SITE_URL` is the app origin and the apex is the marketing Site's. It takes one bare
origin — no wildcard, no list, no path.
Anything else is refused, loudly, the first time the auth routes handle a request: a
bad trust decision should stop sign-in rather than quietly widen or narrow it. Note
that the refusal takes *all* auth down until the value is fixed, and the deploy that
carried it still succeeds. Do not widen the trusted origins with Better Auth's own
`BETTER_AUTH_TRUSTED_ORIGINS` instead: its origin check reads that variable but the
auth routes' CORS does not, so it produces a request that passes the server and is
then blocked in the browser. A User who lands on an origin that is not trusted gets
no CORS answer from the auth routes and sign-in fails in the browser with no detail,
which also means a Worker `workers.dev` host and a bumped local dev port are not
places sign-in works. Verify sign-in on a declared origin, and point `SITE_URL` at
the port you are serving from.

`SITE_URL` is the only origin auth trusts, and the deploy's configuration check fails
the release if it does not name the host the product Worker claims — the one failure
worth catching before anything is deployed, because the app loads on that host and
sign-in fails in the browser with no detail at all.

The cutover was two steps on purpose. Handing the apex to the marketing Site is the
tag-driven release. Flipping `SITE_URL` to the app origin and removing the second
trusted origin it replaced is a **separate** step that had to come **after** it, and it
is an env write only — no deploy, because the auth handler reads the trusted-origin list
per request. Both were run on 2026-09-27; this is what they were, kept because the
rollback below is the same commands in the other order:

```sh
pnpm --filter @pocketcircle/convex exec convex env set --prod SITE_URL https://app.pocketcircle.app
pnpm --filter @pocketcircle/convex exec convex env remove --prod MIGRATION_APP_ORIGIN
```

The `remove` has no observable effect now that nothing reads the variable — it is
housekeeping, deliberately not asserted anywhere.

`--prod` is not optional on either: without it the CLI writes to the development
deployment, where the variables do nothing. Note that the Convex CLI takes `--prod` on
`convex env` but **not** on `convex deploy` — targeting production there is
`CONVEX_DEPLOYMENT` or `CONVEX_DEPLOY_KEY`, and a bare `convex deploy` from
`packages/convex` would follow the `CONVEX_DEPLOYMENT=dev:…` in its `.env.local`.

Reading it back is a `convex env get`, which is unambiguous — the value, or `not
found`:

```sh
pnpm --filter @pocketcircle/convex exec convex env get --prod SITE_URL
```

Asking the auth routes instead is a **positive signal only**. An origin they answer
`Access-Control-Allow-Origin` for is trusted; the absence of the header does **not**
prove the opposite, because the component builds its CORS allowlist once per isolate
and memoises it, so a warm isolate can keep answering for an origin an env write has
already stopped trusting:

```sh
curl -s -o /dev/null -D - -H "Origin: https://app.pocketcircle.app" \
  https://lovable-snail-393.convex.site/api/auth/get-session | grep -i access-control-allow-origin
```

A missing header is worth a retry, never a conclusion. Note also that the auth
*handler* re-reads `SITE_URL` per request while the CORS list does not, so a
half-applied change can serve requests correctly and still refuse the browser.

**The MCP Worker trusts one app origin.** `APP_ORIGIN` moved to the app subdomain in
the cutover. It briefly trusted the apex alongside it, because the MCP Worker is not
one of the two Workers in the handover and not the first step of the release: between
the apex handover and the MCP Worker deploy the app was served from the subdomain by a
Worker that still named the apex alone, and its consent, revoke, and handoff endpoints
answered 403 to the only origin a User could reach. That retired origin is gone now
that the cutover is confirmed (#412), so `browserOriginAllowed` takes a single origin
and nothing depends on the order the deploys happen to run in.

The flip is what the release notes call out: **every User is signed out once.** The
session lives in origin-scoped `localStorage`, which no cookie setting can share
across origins, so nothing on the server is invalidated and re-auth is one Continue
with Google tap. Data, Circle history, MCP grants, and email delivery are untouched.
Device-local keys (last-used Google email, the PWA prompt and
notification-announcement dismissals) reset.

**Push is duplicated until one retirement step runs.** A Push subscription belongs to
the origin that created it, so a pre-cutover row is invisible to everything on the app
origin: reconcile reads the current origin's registration, the endpoint stays valid so
failed delivery never prunes it, and the per-user LRU cap only evicts once a later bind
reaches it. Every existing Push User would otherwise get each notification twice,
indefinitely. One call after the cutover clears them, and the User re-enables
Push in Settings — which they have to do anyway, because notification permission is
per-origin and does not carry over:

```sh
pnpm --filter @pocketcircle/convex exec convex run prod pushSubscriptions:retirePreCutoverPushSubscriptions
```

It reports `{"retired": N, "moreScheduled": true}` while it has more to do and drains
the rest itself — one bounded batch per transaction, because a Convex mutation that
throws rolls back everything it wrote, so a sweep cannot be "loud about not finishing"
from inside a single call. Run it a second time to confirm the settled state:
`{"retired": 0, "moreScheduled": false}`.

An **installed PWA does not move**, and this is a platform limit rather than a choice
here. A browser records the manifest URL and the resolved `start_url` at install time
and gives a site no way to redirect an existing installation to another origin, so the
icon a User installed from `pocketcircle.app` keeps launching that address — which is
the marketing homepage now, and whose `/site.webmanifest` and icons 404. The release
notes tell them to open `https://app.pocketcircle.app` once and **Add to Home Screen**
again. The manifest is left relative (`start_url` and `scope` are `/`) precisely so
that a *new* install from the app origin needs no edit and scopes its own origin; an
absolute app-origin value would be the same answer with a second place to keep in step.
A redirect rule for the PWA assets was considered and rejected: whether a manifest
served through a redirect re-bases an already-installed app's `start_url` is
browser-dependent and unverifiable here, and the redirect list's contract is that every
rule is a real product path — these are assets, not routes.

### Rolling the cutover back

**Revert #412 first.** It is what removed the second trusted origin, and the
pre-cutover backend is the code that reads it — so `MIGRATION_APP_ORIGIN` does nothing
until the older code is serving again. It is four steps, and the order is the whole of
it:

```sh
# 1. Revert #412 and tag it. This restores the second trusted origin in the backend,
#    the deploy check that accepts either variable naming the app host, and the MCP
#    Worker's retired apex. Reverting a merge commit needs `-m 1`, and the tag needs a
#    `## [vX.Y.Z] - YYYY-MM-DD` section with real content in CHANGELOG.md, because
#    `scripts/release-notes.sh` refuses to tag without one:
#    (git revert -m 1 <#412 merge SHA> && git tag vX.Y.Z && git push origin vX.Y.Z)
#    The variable is still unset in production, so at this point auth trusts the app
#    origin and nothing else — exactly as it does today. Step 2 is what changes that.

# 2. Trust the apex alongside it. The apex is not serving the app yet, so this only
#    has to be true by the time step 3 lands — but step 3 is what makes it load
#    bearing, so do not skip it. No deploy: the auth routes read the trusted-origin
#    list per request.
pnpm --filter @pocketcircle/convex exec convex env set --prod MIGRATION_APP_ORIGIN https://pocketcircle.app

# 3. Revert the cutover release and tag it, so the product Worker re-claims the apex
#    and the marketing Site drops it. Do NOT revert the two wrangler configs by hand:
#    canonical-origins.test.ts asserts the apex is claimed by apps/site/wrangler.jsonc
#    and the app. route by the product Worker, and apps/site/src/wrangler.test.ts
#    asserts the two deploys are adjacent, so a hand-edited config fails the build on
#    the next tag. git revert of the release commit restores the configs, the guards,
#    the origin constants, and the MCP Worker's APP_ORIGIN together.
#    From here the app is served from the apex again and auth trusts both.

# 4. Point SITE_URL at the apex and drop the second origin. From here the two stop
#    covering both hosts, so the deploy's configuration check fails if this is not the
#    same deploy that stops trusting the subdomain — or the subdomain keeps being
#    trusted and nothing is untrusted. That is the check working, not a release to
#    work around.
pnpm --filter @pocketcircle/convex exec convex env set --prod SITE_URL https://pocketcircle.app
pnpm --filter @pocketcircle/convex exec convex env remove --prod MIGRATION_APP_ORIGIN
```

The hazard step 2 exists to avoid: an origin that is untrusted while it is still
serving traffic fails sign-in in the browser with nothing to show for it. Skipping it
puts the apex back in service with nothing trusting it, which is the one failure this
whole arrangement was built to make impossible.

Rolling back is now materially harder than rolling forward was, and that asymmetry is
deliberate: the whole point of retiring the second origin is that there is one less
thing trusted. If you need it back, steps 1 and 2 are a normal revert and two env
writes.

### If the Site deploy fails, mid-handover

The two deploys are adjacent because a custom domain sends *every* path on its
hostname to the Worker bound to it: between the product Worker dropping the apex and
the Site claiming it, **no Worker holds `pocketcircle.app`**, so the marketing pages,
every legacy product redirect, every bookmark and every already-delivered email fail
together. The window is one `wrangler` invocation wide and the job fails loudly if the
Site deploy does, but "loudly" is not "repaired", so the recovery is one command:

```sh
pnpm build:site
pnpm --filter @pocketcircle/site exec wrangler deploy
```

That re-claims the apex with the same artifact, from the same account, and is
idempotent — a Worker already bound to the hostname is simply rebound to the new
version. Re-running the failed job does the same thing and is the better first try,
since it also re-runs the verification. Do not re-deploy the *product* Worker to
"put something back": it would claim the apex and collide with the Site.

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
