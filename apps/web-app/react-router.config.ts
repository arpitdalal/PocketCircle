import type { Config } from "@react-router/dev/config";

// SPA mode: no server runtime. The build emits a static client bundle with a
// prerendered index.html that Cloudflare Workers serves as the SPA fallback for
// unmatched paths so deep links resolve client-side (ADR 0007, ADR 0017).
//
// Prerender legal pages so Google branding bots get real HTML without JS. Do NOT
// prerender `/`: Workers `not_found_handling: single-page-application` always
// falls back to `/index.html`, and prerendering `/` would move the SPA shell to
// `__spa-fallback.html` (which CF does not use). Branding for `/` comes from
// root `HydrateFallback` (MarketingHome) baked into that same index.html.
// Assets-only Worker (no `main`) stays free-tier friendly — static files only.
// v8 future flags are now defaults (MNT-1); splitRouteModules is on by default.
export default {
  appDirectory: "app",
  ssr: false,
  prerender: ["/privacy", "/terms", "/whats-new"],
} satisfies Config;
