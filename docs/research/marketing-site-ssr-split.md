# Marketing site vs SPA split (Google branding + ADR 0004)

Updated 2026-09-06. Scope: how to serve crawlable branding HTML at `https://pocketcircle.app/` without forcing the authenticated product into a runtime SSR server.

## Why this exists

Google Branding checks require a public homepage that describes app purpose, names the product consistently with the OAuth consent screen, and links Privacy (same policy URL as branding config), on a verified top private domain. Homepage must not be login-only. ([Homepage requirements](https://support.google.com/cloud/answer/10311615), [Brand verification](https://developers.google.com/identity/verification/authentication-verification))

Production today is SPA mode: React Router `ssr: false` prerenders only the root shell into `index.html`. Live curl of `https://pocketcircle.app/` returns splash text (“Starting PocketCircle…”) until JS hydrates. Browsers see MarketingHome; branding crawlers do not. ([SPA mode](https://reactrouter.com/how-to/spa), `apps/web-app/react-router.config.ts`, ADR 0017)

Privacy must live on the **same domain** as the homepage (subdomains of a verified top private domain `pocketcircle.app` are fine). ([Privacy on homepage domain](https://developers.google.com/identity/verification/authentication-verification))

## Repo facts

| Fact | Source |
| --- | --- |
| Marketing intentionally deferred to future `apps/site` (SSR/SSG), separate from `apps/web-app` | [ADR 0004](../adr/0004-vite-react-typescript-without-effect.md) |
| Web = Cloudflare Worker static assets + SPA fallback; Convex Cloud backend | [ADR 0007](../adr/0007-vercel-and-convex-cloud-deployment.md), root `wrangler.jsonc` (`assets.directory` → `apps/web-app/build/client`, `not_found_handling: single-page-application`) |
| Product SPA Framework Mode, no server loaders/actions | [ADR 0017](../adr/0017-react-router-framework-mode-spa.md) |
| Auth trusts app origin via Better Auth `crossDomain` + Convex `SITE_URL` (prod `https://pocketcircle.app`) | `packages/convex/convex/auth.ts`, README production env |
| Custom domains today | Web `pocketcircle.app`; MCP `mcp.pocketcircle.app` (README) |
| Planned public `/support` for OpenAI plugin materials | [issue-357-plugin-planning.md](issue-357-plugin-planning.md) |

### Routes (current `apps/web-app/app/routes.ts`)

**Natural marketing / legal / crawl targets**

- Signed-out `/` (MarketingHome via ProtectedLayout) and preview `/home`
- `/privacy`, `/terms` (public reading layout)
- Future `/support`

**Must stay on the authenticated SPA (or share its origin for auth)**

- `/signin`, `/invite/:token`, account-deletion verify/complete
- All protected product routes (`/`, when signed in → Home; `/circles/...`, settings, connections, MCP authorize, etc.)
- Dev-only `/dev/email-preview`

**Deploy note:** Tag deploy builds `pnpm build` then deploys root Worker assets + MCP Worker + Convex (`.github/workflows/deploy.yml`). No separate marketing package yet.

## Rendering options (framework)

React Router documents two paths that emit real HTML for specific URLs without abandoning SPA for the product:

1. **`ssr: false` + `prerender: ["/", "/privacy", …]`** — build-time HTML per path; other URLs use SPA fallback (`index.html` or `__spa-fallback.html` if `/` is prerendered). ([Pre-rendering](https://reactrouter.com/how-to/pre-rendering))
2. **Separate app with SSG or SSR** — e.g. `apps/site`, deployed as its own Worker assets (or SSR Worker). Matches ADR 0004.

Cloudflare Workers Assets can serve SSG HTML with `not_found_handling: "404-page"` (or SPA fallback for the product Worker). Path-based multi-asset routing is also possible via Worker script / `run_worker_first`. ([Workers SSG](https://developers.cloudflare.com/workers/static-assets/routing/static-site-generation/), [Workers + React Router](https://developers.cloudflare.com/workers/framework-guides/web-apps/react-router/))

**Prefer static prerender/SSG over runtime SSR** for `/`, `/privacy`, `/terms`, `/support`: content is mostly static, branding bots need first-byte HTML, and ADR 0007 already optimizes for static assets on Workers.

## Hosting topology options

### A. Stay on one origin: prerender public routes inside `web-app`

Keep `https://pocketcircle.app` as SITE_URL. Add `prerender` for `/`, `/privacy`, `/terms` (and later `/support`). Signed-in `/` remains client-routed after hydrate. Configure Worker SPA fallback to `__spa-fallback.html` when `/` is prerendered (React Router emits that when `/` is in `prerender`).

| Pros | Cons |
| --- | --- |
| Smallest change; no DNS/auth/MCP origin churn | Mixes marketing into product app (opposes ADR 0004 long-term split) |
| Google homepage + Privacy stay apex | Prerendered `/` must be marketing-only HTML; signed-in Home is client-only after auth — careful root/HydrateFallback design |
| One deploy artifact | Cloudflare SPA fallback + prerendered `/` needs explicit fallback wiring (easy to misconfigure → deep-link 404s) |
| Fixes branding crawler quickly | Future rich marketing still fights SPA constraints |

**Routes “migrated”:** none physically; same app, build emits HTML for public paths.

### B. Apex marketing Worker + product on `app.pocketcircle.app` (`apps/site`)

ADR 0004 shape. New `apps/site` (Astro / RR prerender / plain HTML) owns apex. Move SPA Worker to `app.pocketcircle.app`. Set Convex `SITE_URL` + Google JS origins + MCP `APP_ORIGIN` to app subdomain. Apex CTAs link to `https://app.pocketcircle.app/signin` (or start OAuth with trusted app origin).

| Pros | Cons |
| --- | --- |
| Clean separation; marketing can grow (blog, SEO) without touching SPA | Touches auth, emails (`SITE_URL` links), MCP consent origin, OAuth clients, E2E, PWA start URL, bookmarks |
| Apex HTML is trivially crawlable | Two Workers / two deploy steps |
| Matches documented monorepo intent | Cookie/session stay on app origin (correct); marketing cannot silently share SPA session without redirects |
| Privacy/terms can live on apex (Google-happy) | Redirect matrix: signed-in users hitting apex → app |

**Routes to move to `apps/site`:** `/`, `/privacy`, `/terms`, `/support`.  
**Stay on app:** `/signin`, invite, deletion, all product routes. Optionally redirect apex `/signin` → app.

### C. Same apex, path carve-out (no `/app` prefix)

One hostname. Worker serves marketing assets for exact paths (`/`, `/privacy`, `/terms`, `/support`); all other paths SPA fallback to current `web-app` build. Marketing can be a tiny second build or checked-in HTML.

| Pros | Cons |
| --- | --- |
| No SITE_URL / cookie / OAuth origin change | Worker routing complexity; two builds on one domain |
| Fast branding fix; Privacy same host | Collision risk if SPA later needs `/support` etc. |
| Product URLs unchanged | Weaker long-term split than B; still not full `apps/site` freedom unless marketing build is separate |

**Variant C2 — SPA under `/app`:** move product to `https://pocketcircle.app/app/...`. Huge URL migration; worse than B for bookmarks and deep links. **Not recommended.**

### D. Marketing on `www` / `www` SSG, SPA stays on apex

| Pros | Cons |
| --- | --- |
| SPA URLs unchanged | Google homepage URL would need to become www (or fail if apex stays splash SPA) |
| | Split-brain brand; users type apex |
| | Still need Privacy colocated with chosen homepage host |

**Not recommended** while branding homepage is apex.

## Google + auth constraints (any option)

- Homepage + Privacy + Terms URLs on OAuth branding must stay on verified `pocketcircle.app` (top private domain). Subdomains OK after Search Console verification of `pocketcircle.app`.
- Changing product origin (option B) requires updating: Convex `SITE_URL`, Google OAuth authorized JavaScript origins, MCP Worker `APP_ORIGIN` / consent origin checks, invitation and deletion email links, README/prod secrets, Playwright base URL.
- Continue with Google on a pure static marketing page should **link or redirect** into the SPA origin that `SITE_URL` trusts; do not invent a second auth origin.
- Branding re-check after deploy: curl without JS must show `PocketCircle` + purpose body text + Privacy `<a href=...>`.

## Chosen short path (2026-09-06)

**Option A, free-tier shaped:**

- Keep assets-only Worker (`wrangler.jsonc` has no `main`) so serving stays static on the Workers free tier — no billable script invocations for HTML.
- Do **not** prerender `/`. Cloudflare SPA fallback always serves `/index.html`; prerendering `/` would emit `__spa-fallback.html`, which CF does not use for deep links.
- Bake MarketingHome into root `HydrateFallback` so SPA `index.html` has PocketCircle + purpose + Privacy/Terms links for no-JS crawlers.
- Prerender only `/privacy` and `/terms` to real HTML files under `build/client`.
- `apps/web-app/scripts/assert-branding-html.mjs` runs after `react-router build` to lock this contract.

Still open for later: full **B** (`apps/site`) when marketing grows.

## Open choices for the maintainer

- Ship branding unblock as A/C first, defer `apps/site`?
- Or invest in B now (origin move + dual Worker)?
- Framework for `apps/site` if B: Astro SSG vs React Router prerender-only vs hand-written HTML?

## Sources

- [Google Manage OAuth App Branding](https://support.google.com/cloud/answer/10311615)
- [Google brand verification / homepage + privacy](https://developers.google.com/identity/verification/authentication-verification)
- [React Router SPA mode](https://reactrouter.com/how-to/spa)
- [React Router pre-rendering](https://reactrouter.com/how-to/pre-rendering)
- [Cloudflare Workers static assets / SSG](https://developers.cloudflare.com/workers/static-assets/routing/static-site-generation/)
- Repo: ADR 0004, 0007, 0017; `wrangler.jsonc`; `routes.ts`; `auth.ts`; README production section
