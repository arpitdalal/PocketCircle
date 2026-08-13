# MNT-1 · React Router v8 future flag adoption

| | |
|---|---|
| **Status** | Done · [PR #199](https://github.com/arpitdalal/PocketCircle/pull/199) |
| **Labels** | `area:maintenance`, `frontend`, `routing` |
| **Depends on** | F0 |
| **Unlocks** | React Router v8 upgrade |
| **PRD stories** | — |
| **ADRs** | 0017 |
| **Glossary** | — |

## Intent

React Router 7.16 emits future-flag warnings on every `typecheck`/build for the behavior
changes landing in v8. Adopting the flags **now, one at a time, on the current 7.x line** lets
us absorb each breaking change in isolation behind green gates, so the eventual `react-router@8`
bump is a no-op instead of a big-bang migration. This is the standard React Router upgrade path
(opt into `future.*`, fix fallout, then bump the major once all flags are on).

The flags surfaced today (from `pnpm typecheck`):

- `v8_middleware` — route middleware support is changing.
- `v8_splitRouteModules` — route module splitting behavior is changing.
- `v8_viteEnvironmentApi` — Vite Environment API usage is changing.
- `v8_passThroughRequests` — request handling behavior is changing.
- `v8_trailingSlashAwareDataRequests` — data-request URL formats are changing.

## Implement

- **Config:** enable the flags in `apps/web-app/react-router.config.ts` (`future: { ... }`),
  turning them on **one per PR** so each behavior change is isolated and bisectable. Order from
  lowest-blast-radius to highest; land `v8_trailingSlashAwareDataRequests` and
  `v8_passThroughRequests` (request/URL semantics) carefully since they touch every loader.
- **Routing (ADR 0017):** the app uses config-based object routes (`routes.ts`). Re-verify
  resolved-ref adapters, `useResolvedRef` guards, and the deep-link/URL-state behavior from
  TXN-5 still hold under each flag — especially `v8_trailingSlashAwareDataRequests` against the
  `?month=`/`?new=` query-state and canonical object links.
- **Vite:** `v8_viteEnvironmentApi` interacts with the Vite 8 + `resolve.tsconfigPaths` setup
  from the dependency refresh — confirm dev/build/SSR entry still resolve and the React Router
  Vite plugin wiring is unchanged.
- **Cleanup:** once all five flags are on and gates are green, the warnings disappear; the
  follow-up `react-router@8` bump should then be mechanical.

## Why this way

- **One flag per PR, not all at once.** Each flag is an independent behavior change; bundling
  them makes a regression impossible to bisect. Incremental adoption is the whole point of the
  future-flag mechanism.
- **Adopt on 7.x before bumping to 8.** Staying on the current major while flipping flags keeps
  the dependency stable and lets us roll back a single flag without reverting a major upgrade.
- **Routing/URL behavior is load-bearing.** TXN-5 made the URL the source of truth for ledger
  month and form state; `v8_trailingSlashAwareDataRequests` and `v8_passThroughRequests` can
  shift loader/request semantics under that, so they need explicit re-verification, not a blind
  flip.

## How to test

- **Per flag:** flip one flag → `pnpm typecheck && pnpm lint && pnpm test && pnpm build` all
  green, and the corresponding warning is gone from the typecheck output.
- **Routing/URL (TXN-5 regression):** ledger `month=YYYY-MM` restore on reload, `?new=`
  create deep links, and `/transactions/:transactionRef/edit?month=...` object links still
  resolve, canonicalize stale slugs, and preserve query state under each flag.
- **Loaders/requests:** data routes still load, redirect, and handle missing/inaccessible
  targets identically (anti-enumeration, ADR 0016) after `v8_passThroughRequests` and
  `v8_trailingSlashAwareDataRequests`.
- **Build/SSR:** dev server, production build, and the node entry boot with no new warnings or
  resolution failures (Vite 8 + tsconfig paths).
- **E2E:** `pnpm test:e2e:local` stays green after each flag (covers the real auth + routing
  flows end to end).

## Done when

- All five v8 future flags are enabled in `react-router.config.ts`, each landed in its own PR
  with green gates; no future-flag warnings remain in `pnpm typecheck`; TXN-5 URL/routing
  behavior is re-verified; the codebase is ready for a mechanical `react-router@8` bump.

## Out of scope

The actual `react-router@8` major bump (separate follow-up once flags are clean); any new
routing features; non-React-Router dependency upgrades.
