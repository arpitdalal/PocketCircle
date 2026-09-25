import { APEX_ORIGIN } from "@pocketcircle/domain/origins";
import type { Plugin } from "vite";

/**
 * Placeholder the checked-in HTML writes wherever the canonical apex origin
 * belongs. The Site is served from `workers.dev` until the ADR 0035 cutover
 * moves it to the apex, so a hardcoded URL here would either advertise the
 * staging host or need editing at cutover. Substituting the canonical origin
 * (#404) at build time keeps `index.html` a readable document that no file has
 * to spell an origin out in.
 */
export const APEX_ORIGIN_TOKEN = "%APEX_ORIGIN%";

/**
 * Replaces {@link APEX_ORIGIN_TOKEN} in the HTML entry, in dev and in the
 * build. Every other origin the Site grows — an app link, a sitemap,
 * robots.txt — reaches for the same module the same way.
 */
export function resolveApexOrigin(html: string) {
  return html.replaceAll(APEX_ORIGIN_TOKEN, APEX_ORIGIN);
}

export function apexOriginHtmlPlugin(): Plugin {
  return {
    name: "pocketcircle:apex-origin",
    transformIndexHtml: resolveApexOrigin,
  };
}
