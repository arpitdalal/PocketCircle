# Marketing site vs SPA split (Google branding + ADR 0004)

Updated 2026-09-25. Scope: how to serve crawlable branding HTML at `https://pocketcircle.app/` without forcing the authenticated product into a runtime SSR server. The decision and cutover runbook are in [Decision (2026-09-25)](#decision-2026-09-25--option-b-adr-0035) below and recorded in [ADR 0035](../adr/0035-static-marketing-site-on-apex-and-product-spa-on-app-subdomain.md); the option analysis above it is kept as the record of what was considered.

## Why this exists

Google Branding checks require a public homepage that describes app purpose, names the product consistently with the OAuth consent screen, and links Privacy (same policy URL as branding config), on a verified top private domain. Homepage must not be login-only. ([Homepage requirements](https://support.google.com/cloud/answer/10311615), [Brand verification](https://developers.google.com/identity/verification/authentication-verification))

Production today is SPA mode: React Router `ssr: false` prerenders only the root shell into `index.html`. Live curl of `https://pocketcircle.app/` returns splash text (“Starting PocketCircle…”) until JS hydrates. Browsers see MarketingHome; branding crawlers do not. ([SPA mode](https://reactrouter.com/how-to/spa), `apps/web-app/react-router.config.ts`, ADR 0017)

Privacy must live on the **same domain** as the homepage (subdomains of a verified top private domain `pocketcircle.app` are fine). ([Privacy on homepage domain](https://developers.google.com/identity/verification/authentication-verification))

## Repo facts

Everything in this section describes production **before** the split. It is kept as the factual basis for the decision rather than updated in place.

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

## Interim unblock (2026-09-06, superseded)

**Option A, free-tier shaped.** Shipped to clear Google branding quickly, and explicitly temporary:

- Keep assets-only Worker (`wrangler.jsonc` has no `main`) so serving stays static on the Workers free tier — no billable script invocations for HTML.
- Do **not** prerender `/`. Cloudflare SPA fallback always serves `/index.html`; prerendering `/` would emit `__spa-fallback.html`, which CF does not use for deep links.
- Bake MarketingHome into root `HydrateFallback` so SPA `index.html` has PocketCircle + purpose + Privacy/Terms links for no-JS crawlers.
- Prerender only `/privacy` and `/terms` to real HTML files under `build/client`.
- `apps/web-app/scripts/assert-branding-html.mjs` runs after `react-router build` to lock this contract.

This is what produced the reported interim issue: the marketing page paints as the SPA shell, then an async auth check swaps it for the app home. ADR 0035 removes the arrangement instead of polishing it.

## Decision (2026-09-25) — Option B, [ADR 0035](../adr/0035-static-marketing-site-on-apex-and-product-spa-on-app-subdomain.md)

Apex is a static marketing Site; the product SPA moves to `app.pocketcircle.app`. The issue's request to "SSR the landing page" is resolved as **static generation**, deliberately.

### Why SSG, not SSR

| Question | Answer |
| --- | --- |
| Does Google branding need real HTML at `/`? | Yes — and SSG produces it at build time. ([branding](https://support.google.com/cloud/answer/10311615)) |
| Can an apex runtime render `/` per-User? | No. `crossDomainClient()` stores the session in origin-scoped `localStorage["better-auth_cookie"]` and replays it as a `Better-Auth-Cookie` header with `credentials: "omit"` (`apps/web-app/app/lib/auth-client.ts:13`, `@convex-dev/better-auth/dist/plugins/cross-domain/client.js`). No other origin's server can read it. |
| Does SSR fix the flash? | No. The flash is a *client-side swap inside one document*. Two origins means two documents; the marketing page is never replaced. |
| What does SSR cost? | A `main` on the product Worker (ADR 0017's no-runtime and ADR 0007's assets-only both break) and billable invocations on every app request, to render a page whose only dynamic input is unavailable. |

### Topology

| Origin | Package | Worker | Runtime |
| --- | --- | --- | --- |
| `pocketcircle.app` | `apps/site` (new, Astro static) | `pocketcircle-site`, assets only, `not_found_handling: "404-page"` | none — 0 invocations |
| `app.pocketcircle.app` | `apps/web-app` | root `wrangler.jsonc`, assets only, SPA fallback | none — 0 invocations |
| `mcp.pocketcircle.app` | `packages/mcp-worker` | unchanged | Worker |

### Path ownership

| Path | Owner | Why |
| --- | --- | --- |
| `/` | apex (marketing) | Google branding homepage; must not be login-only |
| `/privacy`, `/terms`, `/support`, `/whats-new` | apex (marketing) | already published in `docs/submission/pocketcircle/README.md:12-16`; Privacy/Terms must share the homepage domain for branding |
| `/signin`, `/invite/:token`, `/delete-account/*`, all protected routes, `/mcp/authorize`, `/dev/*` | `app.` + 302 from apex | need auth, Convex, or the app runtime |
| future `/blog/*`, `/changelog` | apex | marketing growth |

### Free-tier setup (verified against Cloudflare limits)

Static-asset requests are **free and unlimited**; Worker-script invocations are capped at **100,000/day per account** on the Free plan; 100 Workers per account; 100 custom domains per zone; 20,000 asset files per Worker version. `_headers` and `_redirects` are fully supported by Workers static assets (the widely-repeated claim that they are Pages-only is wrong for Workers). Adding a third Worker and a second custom domain is well inside every limit, and no new GitHub secret is required — the existing `CLOUDFLARE_API_TOKEN` already carries Zone → Workers Routes → Edit; just confirm it also permits the DNS record wrangler creates for `app.`.

`apps/site/wrangler.jsonc` — no `main`, therefore free-tier static:

```jsonc
{
  "name": "pocketcircle-site",
  "compatibility_date": "2026-08-11",
  "workers_dev": true,              // verify on *.workers.dev before the cutover
  "routes": [{ "pattern": "pocketcircle.app", "custom_domain": true }],
  "assets": {
    "directory": "./dist",
    "not_found_handling": "404-page" // never marketing-at-every-URL
  }
}
```

Root `wrangler.jsonc` — only the route changes:

```jsonc
"routes": [{ "pattern": "app.pocketcircle.app", "custom_domain": true }]
```

CI (`.github/workflows/deploy.yml`): add `pnpm --filter @pocketcircle/site build` to the build step and one more `cloudflare/wrangler-action@v4` with `workingDirectory: apps/site`. Keep the push-delivery gate wrapped around the **product** deploy only.

### Cutover runbook

Two Workers cannot both claim one hostname, so the apex handover is sequential. Deploy and verify everything *before* the swap so the swap is a formality.

1. Add the `app.` route to the product Worker; deploy. Both apex and `app.` now serve the app. Verify deep links and assets on `app.` (auth still redirects to apex — expected, `SITE_URL` not flipped yet).
2. Flip the product Worker config to `app.` only **and** deploy the marketing Worker claiming apex, back-to-back in one run. Sub-minute gap on the marketing homepage only; the app is unaffected.
3. `convex env set SITE_URL https://app.pocketcircle.app` + `convex deploy -y`.
4. Add `https://app.pocketcircle.app` to Google OAuth **Authorized JavaScript origins**. Branding homepage/privacy stay on apex, which is what Google requires; `app.` only needs to be an authorized JS origin and inside the authorized redirect domain.
5. `APP_ORIGIN` → `https://app.pocketcircle.app` in `packages/mcp-worker/wrangler.jsonc:69`.
6. Publish `apps/site/public/_redirects` (below) so legacy and emailed links resolve.
7. Update `robots.txt` / `sitemap.xml` to the apex marketing surface, and `site.webmanifest` `start_url`/`scope` to the app origin.
8. Re-check branding with a no-JS `curl https://pocketcircle.app/` for product name, purpose copy, and a Privacy link.

### URL and email compatibility

`apps/site/public/_redirects`:

```txt
# Legacy product paths and already-delivered emails -> app subdomain.
# Static redirects, no Worker script, no invocations.
/signin                        https://app.pocketcircle.app/signin 302
/invite/*                      https://app.pocketcircle.app/invite/:splat 302
/delete-account/verify         https://app.pocketcircle.app/delete-account/verify 302
/delete-account/complete       https://app.pocketcircle.app/delete-account/complete 302
/connections/*                 https://app.pocketcircle.app/connections/:splat 302
/circles/*                     https://app.pocketcircle.app/circles/:splat 302
/onboarding                    https://app.pocketcircle.app/onboarding 302
/settings/*                    https://app.pocketcircle.app/settings/:splat 302
/transactions/*                https://app.pocketcircle.app/transactions/:splat 302
/my-transactions                https://app.pocketcircle.app/my-transactions 302
/invitations/*                 https://app.pocketcircle.app/invitations/:splat 302
/feedback                      https://app.pocketcircle.app/feedback 302
/from-notification             https://app.pocketcircle.app/from-notification 302
/mcp/*                         https://app.pocketcircle.app/mcp/:splat 302
/home                          https://app.pocketcircle.app/home 302
/dev/*                         https://app.pocketcircle.app/dev/:splat 302
```

- Invitation tokens are **path** segments (`routes/invite/:token`), so the splat carries them verbatim.
- Account Deletion verification carries `?token=` in the **query** (`packages/convex/convex/accountDeletion.ts:229`). Cloudflare's `_redirects` reference lists query-parameter *matching* as unsupported; passthrough of an untouched query on a plain redirect must be confirmed with `curl -I` against the preview deploy. If it does not hold, add a minimal Worker on the marketing origin restricted to `/delete-account/*` that forwards `request.url` verbatim — negligible traffic.
- Expired deletion tokens were already unusable, so the exposure is bounded regardless.

### Accepted cost: one forced sign-out

| Item | Effect |
| --- | --- |
| Session | Signed out once, everywhere. `localStorage` has no domain attribute, so no cookie setting avoids it. Server-side better-auth sessions stay valid; re-auth is one Continue-with-Google tap. |
| Data | Nothing. Convex data, Circle history, MCP grants, and email delivery are untouched. |
| Installed PWA | Old installs launch the old `start_url`; the new manifest points at `app.`. |
| Device-local keys | `last-used-google-email`, PWA prompt dismissal, notification-announcement dismissal reset. |

Optional, deliberately deferred: a one-time resume shim. An inline script on apex reads its own `better-auth_cookie` and hands it to `https://app.pocketcircle.app/auth/resume#<blob>` (a fragment is never sent to a server or a `Referer`), which writes it into the new origin's `localStorage`, strips the hash, and revalidates via `getSession()`. Build it only if Users report the re-auth as a problem, and give it a removal date.

### Blast radius

| Concern | Location |
| --- | --- |
| Worker route | `wrangler.jsonc:7-16` |
| Convex trusted origin | `packages/convex/convex/auth.ts:33-36,106,123-126,161-164` (`SITE_URL` → `crossDomain`) |
| Email links | `packages/convex/convex/email.ts:161,287,359`; `accountDeletion.ts:224-226` |
| MCP consent origin | `packages/mcp-worker/wrangler.jsonc:69`; `src/mcp-api.ts:975-1000`; `src/browser-origin.ts:13-29` |
| Brand HTML contract (delete) | `react-router.config.ts` prerender list; `app/root.tsx:49-57`; `scripts/assert-branding-html.mjs` |
| SEO surface (move to apex) | `public/robots.txt`, `public/sitemap.xml` |
| PWA scope | `public/site.webmanifest`; `app/components/pwa-install.tsx` |
| Hardcoded public URLs | `routes/support.tsx:35`; `plugins/pocketcircle/README.md:83`; `plugins/pocketcircle/assert-package.mjs:67`; `docs/submission/pocketcircle/README.md:12-16,41`; `README.md:207,365`; `deploy.yml:25` |
| Unaffected | `playwright.config.ts` and `scripts/e2e-local.sh` (`127.0.0.1:5173`), all Convex functions, all app internals |

### Framework for `apps/site`

- **Astro, static output — chosen.** Zero JS by default (best LCP for a marketing page), Tailwind 4 already in the workspace, MDX + content collections, build-time sitemap/OG, and a ~15-line assets-only `wrangler.jsonc`. Grows into per-route edge behavior later by adding `main` without changing hosting.
- **React Router 7 prerender-only — viable alternative.** Maximum reuse: port `marketing-home.tsx` nearly verbatim and keep the app's component and token conventions. Costs a JS bundle plus hydration on a page that does not need it, and no MDX/content collections.
- **Next.js / OpenNext — rejected.** Vastly oversized for a homepage.
- **Cloudflare Pages — rejected.** Feature-frozen since April 2025; CF steers new projects to Workers static assets; assets, `_headers`, and `_redirects` stay in one version-controlled config.

Share brand tokens between `apps/site` and `apps/web-app` through a workspace CSS package so the two surfaces cannot drift. The [ai-design-skills `landing-page-design`](https://github.com/elayadesign/ai-design-skills) skill is a markdown rules file for the visual layer and is independent of this infrastructure decision.

## Sources

- [Google Manage OAuth App Branding](https://support.google.com/cloud/answer/10311615)
- [Google brand verification / homepage + privacy](https://developers.google.com/identity/verification/authentication-verification)
- [React Router SPA mode](https://reactrouter.com/how-to/spa)
- [React Router pre-rendering](https://reactrouter.com/how-to/pre-rendering)
- [Cloudflare Workers static assets / SSG](https://developers.cloudflare.com/workers/static-assets/routing/static-site-generation/)
- [Cloudflare Workers static assets billing and limits](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) — static assets free and unlimited; Worker invocations capped
- [Cloudflare Workers platform limits](https://developers.cloudflare.com/workers/platform/limits/) — 100k req/day Free, 100 Workers/account, 100 custom domains/zone, 20k asset files
- [Cloudflare Workers static assets redirects](https://developers.cloudflare.com/workers/static-assets/redirects/) — splats, external destinations, query-matching caveat
- [Cloudflare Workers static assets headers](https://developers.cloudflare.com/workers/static-assets/headers/)
- [Astro on Cloudflare Workers](https://developers.cloudflare.com/workers/framework-guides/web-apps/astro/) — static output needs no adapter, no `main`
- Repo: ADR 0004, 0007, 0017, 0035; `wrangler.jsonc`; `routes.ts`; `auth.ts`; `auth-client.ts`; `@convex-dev/better-auth` `crossDomain` plugin; README production section
