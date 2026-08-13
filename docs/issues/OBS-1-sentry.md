# OBS-1 · Sentry error monitoring

|                 |                                              |
| --------------- | -------------------------------------------- |
| **Status**      | Done                                         |
| **Labels**      | `area:observability`, `frontend`, `security` |
| **Depends on**  | F0                                           |
| **PRD stories** | 92                                           |
| **ADRs**        | 0012, 0013                                   |
| **Glossary**    | —                                            |

## Intent

Operational error monitoring from beta (PRD 92, ADR 0012): wire **Sentry** with **strict masked,
error-triggered Session Replay only** — **no normal replay sampling**. Sentry is **always on**,
independent of the product-analytics opt-out (ADR 0013 / PRD 181) — it's how beta issues get
diagnosed. There's already a `reportAppError` seam ([`report-error.ts`](../../apps/web-app/app/lib/report-error.ts))
whose doc comment says "Sentry wiring lands here (ADR 0012) without touching any call site"; this
slice makes it real.

**Note — SET-1 already shipped** ([PR #204](https://github.com/arpitdalal/PocketCircle/pull/204)): the
analytics opt-out exists (`analyticsOptOut` on the User; `useSetAnalyticsOptOut`; the Privacy section
in [`settings.tsx`](../../apps/web-app/app/routes/settings.tsx)). Its UI copy already **promises the
user** "Operational error monitoring (Sentry) stays on regardless." This slice must make that true —
Sentry init must NOT read `analyticsOptOut`. Also note the **MSW Sentry handler already exists**
([`packages/mocks/src/handlers.ts`](../../packages/mocks/src/handlers.ts), `vendor: "sentry"`,
`https://*.ingest.sentry.io/*`) capturing envelopes into `capturedRequests` — no new handler needed.

## Implement

The app is a client-only SPA (ADR 0017, React Router v7 framework mode, no SSR). Init runs in the
browser entry only. There is **no `@sentry/*` dependency yet** — add one (`@sentry/react`; it provides
`Sentry.init`, `replayIntegration`, and the capture API). Keep React Compiler / ADR rules: no `as`
casts, no explicit return types, infer where possible.

- **DSN env var (client → MUST be `VITE_`-prefixed):** Vite only exposes `VITE_*` to
  `import.meta.env` (see existing `VITE_CONVEX_URL`). Name it **`VITE_SENTRY_DSN`** — a bare
  `SENTRY_DSN` is invisible to the client bundle. Wire it through the central env module, don't read
  `import.meta.env` ad hoc:
  - Add `export const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN;` to
    [`app/lib/env.ts`](../../apps/web-app/app/lib/env.ts).
  - Add `readonly VITE_SENTRY_DSN?: string;` to `ImportMetaEnv` in
    [`app/env.d.ts`](../../apps/web-app/app/env.d.ts).
  - Document it in [`.env.example`](../../.env.example) (optional locally; set in prod/beta).

- **Init in the SPA entry:** initialize inside `boot()` in
  [`app/entry.client.tsx`](../../apps/web-app/app/entry.client.tsx), **before `hydrateRoot`** and
  guarded by DSN presence (`if (SENTRY_DSN) { … }`). Prefer a small `app/lib/sentry.ts` module
  exporting an `initSentry()` so the boot file stays thin and the config is unit-testable. Config:
  - `dsn: SENTRY_DSN`
  - `environment: import.meta.env.MODE` (vite sets `development`/`production`)
  - `release: __APP_VERSION__` (build-time constant from SET-1, injected in
    [`vite.config.ts`](../../apps/web-app/vite.config.ts) from `package.json` `version`; typed in
    `env.d.ts`)
  - `replaysSessionSampleRate: 0` — never sample normal sessions
  - `replaysOnErrorSampleRate: 1.0` — capture replay on every error (low beta volume; the whole point)
  - `replayIntegration({ maskAllText: true, blockAllMedia: true })`

- **Route `reportAppError` through to Sentry:** in
  [`report-error.ts`](../../apps/web-app/app/lib/report-error.ts) (current signature
  `reportAppError(message: string, context?: Record<string, unknown>)`, only call site
  [`use-resolved-ref.ts:112`](../../apps/web-app/app/lib/use-resolved-ref.ts)), forward to
  `Sentry.captureMessage(message, { extra: context })`. **Keep the `console.warn` in dev**
  (`import.meta.env.DEV`) so the local signal is unchanged. No call sites change.

- **Privacy:** the masking/blocking flags above must prevent any financial content/PII (Transaction
  titles, notes, amounts, Feedback text — same exclusion list as ADR 0013) from being captured in
  replays. Do not attach financial fields to error `extra`/tags.

## Why this way

- **Error-only replay, fully masked** (PRD 92) — no ambient session recording; replays exist only to
  debug an actual error and must not leak financial data.
- **Independent of opt-out** (ADR 0013): the analytics toggle (SET-1, shipped) must NOT gate Sentry —
  the Settings copy already commits us to this.
- **Route through `reportAppError`** so the existing seam becomes the single client-error funnel.
- **DSN-gated init** so dev/mock and any env without a DSN are a clean no-op (the production bundle
  also dead-code-eliminates nothing it can't — the SDK is still bundled, but never initializes).

## How to test

Test-first (ADR 0006). The Sentry SDK is a genuine 3rd-party boundary, so spying on it is allowed
(CLAUDE.md). Don't re-scaffold shared render/seed wiring — reuse the existing helpers and the MSW
`capturedRequests` log. Cover:

- **Config:** `initSentry()` (or the init options object) has `replaysSessionSampleRate === 0`,
  `replaysOnErrorSampleRate > 0`, and replay masking flags (`maskAllText`, `blockAllMedia`) on — assert
  the options passed to `Sentry.init`.
- **Independence:** Sentry init runs regardless of `analyticsOptOut` — assert init is reached with the
  opt-out set, i.e. it never reads the analytics preference.
- **Seam:** `reportAppError` forwards to Sentry capture (spy on the SDK's capture fn); dev still
  `console.warn`s.
- **Privacy:** masking options are set such that text/media are masked (assert config; no financial
  fields attached to `extra`).
- **DSN absent → no-op:** with `VITE_SENTRY_DSN` unset (dev/mock), `Sentry.init` is never called and
  nothing throws.

## Done when

- Sentry runs from beta with masked, error-only replay (no normal sampling), always-on regardless of
  the analytics opt-out, fed by `reportAppError`, with no financial-content capture; `VITE_SENTRY_DSN`
  documented in `.env.example` + `env.d.ts` + `env.ts`; release tagged from `__APP_VERSION__`.
- All gates green: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`.

## Out of scope

Product analytics / PostHog (OBS-2). The opt-out toggle + Settings UI (SET-1 — already shipped; this
slice only honors its promise that Sentry stays on).
