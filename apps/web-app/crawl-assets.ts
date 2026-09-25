import { APEX_ORIGIN } from "@pocketcircle/domain/origins";

/**
 * Crawl directives for the deployed site. Generated from the canonical apex
 * origin (#404) rather than checked in as static files, so an origin move
 * cannot leave a sitemap or robots.txt advertising the old host.
 *
 * These paths are served by the app today. The ADR 0035 cutover hands the apex
 * to the marketing Site, and this file moves with those routes into `apps/site`
 * — the product Worker stops publishing them.
 */

/** Marketing paths the apex owns (ADR 0035). */
const SITEMAP_PATHS = ["/", "/privacy", "/terms", "/support", "/whats-new"];

/** Auth-gated / account surfaces — no useful public HTML; keep out of crawl budget. */
const ROBOTS_DISALLOWED_PATHS = [
  "/signin",
  "/invite",
  "/delete-account",
  "/home",
  "/onboarding",
  "/settings",
  "/connections",
  "/feedback",
  "/mcp",
  "/transactions",
  "/circles",
  "/dev",
];

/** File name → body, emitted into the build and served by the dev server. */
export function crawlAssets() {
  return {
    "robots.txt": `${[
      "User-agent: *",
      "Allow: /",
      "",
      "# Auth-gated / account surfaces — no useful public HTML; keep out of crawl budget.",
      ...ROBOTS_DISALLOWED_PATHS.map((path) => `Disallow: ${path}`),
      "",
      `Sitemap: ${APEX_ORIGIN}/sitemap.xml`,
    ].join("\n")}\n`,
    "sitemap.xml": `${[
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      ...SITEMAP_PATHS.map((path) => `  <url>\n    <loc>${APEX_ORIGIN}${path}</loc>\n  </url>`),
      "</urlset>",
    ].join("\n")}\n`,
  };
}
