# End-to-end tests

These are **true E2E** tests (ADR [0019](../docs/adr/0019-e2e-against-self-hosted-convex-backend.md)): the real
browser → real Convex functions → real database. They run against an **ephemeral,
self-hosted Convex backend** (the OSS `convex-backend` Docker image), not fixtures and
not a cloud deployment. The only fakes are Google OAuth (replaced by a flag-gated
email+password bypass) and outbound vendors (MSW).

## Auth: one User per Playwright worker

Specs import `test` / `expect` from [`fixtures.ts`](fixtures.ts), not `@playwright/test`
directly. A **worker-scoped** fixture signs up a fresh User (via `window.__scE2E`) once
per parallel worker and saves `storageState` to `e2e/.auth/worker-<index>.json`
(gitignored). That isolates Personal Circles across workers so list/total assertions do
not race; a stray `@playwright/test` import would drop back to an unsigned-in context
and is easy to miss in review.

## CI sharding

CI splits the suite across three concurrent Playwright shards. Each shard owns an
ephemeral Convex container and runs at most two Playwright workers, so speed comes from
scaling the backend with the tests instead of overloading one backend. Shards upload
one-day blob reports; the final `true-e2e` job merges them into one seven-day HTML report
and fails when any shard fails.

## Running locally

`pnpm test:e2e` on its own only boots the **frontend** — it does **not** start the
Convex backend. With no backend on `127.0.0.1:3210`, the worker auth fixture fails with a
fetch / sign-in error.

Use the wrapper instead — it boots the backend, deploys, runs the suite, and tears
the backend down:

```sh
pnpm test:e2e:local                          # full run
pnpm test:e2e:local --headed                 # args pass through to `playwright test`
pnpm test:e2e:local e2e/transactions.spec.ts # a single spec
KEEP_BACKEND=1 pnpm test:e2e:local           # leave the backend up to debug
```

Requires Docker running. The script ([`scripts/e2e-local.sh`](../scripts/e2e-local.sh))
mirrors the CI **E2E** job ([`.github/workflows/e2e.yml`](../.github/workflows/e2e.yml))
step-for-step, so **when CI's E2E job goes red, reproduce it here** instead of pushing
speculative fixes. It reads the SHA-pinned backend image straight out of the workflow,
so it can't drift from CI.

## The `.env.local` gotcha

Your gitignored `packages/convex/.env.local` points the Convex CLI at the **cloud** dev
deployment. CI has no such file. The CLI refuses to deploy when `CONVEX_DEPLOYMENT` is
set alongside the self-hosted vars (*"CONVEX_DEPLOYMENT must not be set when
CONVEX_SELF_HOSTED_URL… are set"*). The script handles this by moving `.env.local` aside
for the deploy and restoring it on exit — so a hand-rolled `convex deploy` against the
local backend will fail where the script succeeds. Use the script.
