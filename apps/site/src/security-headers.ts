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
 */

/** The product's policy file, relative to this package root. */
const PRODUCT_HEADERS = join("..", "web-app", "public", "_headers");

const GLOBAL_RULE = "/*";

/**
 * The `/*` rule of a `_headers` file, verbatim, as a `_headers` file of its own.
 * Throws when the product file has no global rule, because a Site that silently
 * published without one would serve the marketing document with no security
 * headers at all.
 */
export function globalSecurityHeadersRule(productHeaders: string) {
  const globalRule = productHeaders
    .split(/\n\s*\n/)
    .map((rule) => rule.trim())
    .find((rule) => rule.startsWith(GLOBAL_RULE));
  if (globalRule === undefined) {
    throw new Error(`The product _headers file has no ${GLOBAL_RULE} rule`);
  }
  return `${globalRule}\n`;
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
        source: globalSecurityHeadersRule(productHeaders),
      });
    },
  };
}
