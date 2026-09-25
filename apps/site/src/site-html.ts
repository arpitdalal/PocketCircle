import { APEX_ORIGIN, APP_ORIGIN } from "@pocketcircle/domain/origins";
import type { Plugin } from "vite";

/**
 * The build-time values the checked-in HTML writes placeholders for.
 *
 * `apps/site/index.html` is a real document, not a template for one, so it stays
 * readable in the repository — which means it cannot spell out a value only the
 * build knows. `scripts/assert-site-html.mjs` then asserts the built document
 * carries every one of them and no surviving placeholder.
 *
 * There are two origins here because the document has two jobs (ADR 0035). The
 * apex owns the marketing surfaces — the canonical link, and legal, support,
 * What's New, and the sitemap, which must keep the URLs already published in
 * external submission material and share the branding homepage's domain. The app
 * origin owns sign-in, and only sign-in: the session lives in origin-scoped
 * `localStorage` there, so every other link staying on the apex is what keeps a
 * signed-out visitor from being bounced across origins for a document. A
 * relative href would silently resolve against whichever origin served the page.
 *
 * The Site is served from `workers.dev` until the cutover, so a hardcoded URL
 * would either advertise the staging host or need editing at cutover. The year
 * is the build's, as the React homepage it replaces read the render's.
 */
export const APEX_ORIGIN_TOKEN = "%APEX_ORIGIN%";
export const APP_ORIGIN_TOKEN = "%APP_ORIGIN%";
export const YEAR_TOKEN = "%YEAR%";

export const SITE_PLACEHOLDERS = {
  [APEX_ORIGIN_TOKEN]: APEX_ORIGIN,
  [APP_ORIGIN_TOKEN]: APP_ORIGIN,
  [YEAR_TOKEN]: String(new Date().getFullYear()),
};

/** Replaces every placeholder in {@link SITE_PLACEHOLDERS} in the HTML entry. */
export function resolveSiteHtml(html: string) {
  return Object.entries(SITE_PLACEHOLDERS).reduce(
    (resolved, [token, value]) => resolved.replaceAll(token, value),
    html,
  );
}

export function siteHtmlPlugin(): Plugin {
  return {
    name: "pocketcircle:site-html",
    transformIndexHtml: resolveSiteHtml,
  };
}
