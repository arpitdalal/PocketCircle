import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";

/**
 * The security-header policy is written down once, in the product's checked-in
 * `public/_headers`, and this build derives the Site's `_headers` from it. Two
 * Workers, one policy: a header added to the product reaches the marketing
 * origin on the next build instead of drifting, and the Site cannot ship
 * something the product does not.
 *
 * Only the global `/*` rule travels. The product's other rules are for files the
 * Site does not have — `/push-sw.js` is a product asset — and Workers static
 * assets apply a rule per matched path, so a rule for a file that does not exist
 * here is dead weight the Site has no reason to carry.
 *
 * The staging rule below is the Site's own, and the inverse case: a header the
 * product must not have while the two origins are separate.
 */

/** The product's policy file, relative to this package root. */
const PRODUCT_HEADERS = join("..", "web-app", "public", "_headers");

const GLOBAL_RULE = "/*";

/**
 * Headers for the staging hostname. The Site is served from `workers.dev` until
 * the ADR 0035 cutover moves it to the apex, and Cloudflare's documented recipe
 * for a `workers.dev` URL is to keep it out of search results: a `noindex` here
 * beats relying on the canonical link alone, which other crawlers treat as a
 * hint. The apex must not inherit it, so it is added here rather than to the
 * shared policy, and the cutover deletes it with the staging hostname.
 */
const STAGING_HEADERS = ["X-Robots-Tag: noindex"];

/**
 * The product's `/*` rule, plus the Site's own headers, as one `_headers` rule.
 * Throws when the product file has no global rule, because a Site that silently
 * published without one would serve the marketing document with no security
 * headers at all.
 */
export function siteSecurityHeaders(productHeaders: string) {
  const globalRule = productHeaders
    .split(/\n\s*\n/)
    .map((rule) => rule.trim())
    .find((rule) => rule.startsWith(GLOBAL_RULE));
  if (globalRule === undefined) {
    throw new Error(`The product _headers file has no ${GLOBAL_RULE} rule`);
  }
  const siteOnly = STAGING_HEADERS.map((header) => `  ${header}`).join("\n");
  return `${globalRule}\n${siteOnly}\n`;
}

/** Emits the derived `_headers` next to the built document the Workers serve. */
export function securityHeadersPlugin(): Plugin {
  let siteRoot = "";
  return {
    name: "pocketcircle:security-headers",
    configResolved(config) {
      siteRoot = config.root;
    },
    generateBundle() {
      const productHeaders = readFileSync(join(siteRoot, PRODUCT_HEADERS), "utf8");
      this.emitFile({
        type: "asset",
        fileName: "_headers",
        source: siteSecurityHeaders(productHeaders),
      });
    },
  };
}
