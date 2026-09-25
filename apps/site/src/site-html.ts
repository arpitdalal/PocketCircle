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
 * The apex and the app origin are separate placeholders because they are separate
 * jobs (#404): the apex canonicalises this page, while anything a visitor reaches
 * *after* leaving it — sign-in, legal, support — is the app. A relative href would
 * silently resolve against the marketing origin instead. The Site is served from
 * `workers.dev` until the ADR 0035 cutover, so a hardcoded URL would either
 * advertise the staging host or need editing at cutover.
 *
 * The year is the build's, as the React homepage it replaces read the render's.
 */
export const APEX_ORIGIN_TOKEN = "%APEX_ORIGIN%";
export const APP_ORIGIN_TOKEN = "%APP_ORIGIN%";
export const YEAR_TOKEN = "%YEAR%";

const SITE_PLACEHOLDERS: Readonly<Record<string, string>> = {
  [APEX_ORIGIN_TOKEN]: APEX_ORIGIN,
  [APP_ORIGIN_TOKEN]: APP_ORIGIN,
  [YEAR_TOKEN]: String(new Date().getFullYear()),
};

/** Every placeholder the checked-in document may write. */
export const SITE_PLACEHOLDER_TOKENS: readonly string[] = Object.keys(SITE_PLACEHOLDERS);

/** Replaces every {@link SITE_PLACEHOLDER_TOKENS} in the HTML entry. */
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
