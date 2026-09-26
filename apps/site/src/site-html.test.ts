import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APEX_ORIGIN, APP_ORIGIN } from "@pocketcircle/domain/origins";
import { describe, expect, it } from "vitest";
import { packageRoot, sitePageFiles } from "./pages.js";
import {
  APEX_ORIGIN_TOKEN,
  APP_ORIGIN_TOKEN,
  resolveSiteHtml,
  SITE_PLACEHOLDERS,
  siteHtmlPlugin,
  YEAR_TOKEN,
} from "./site-html.js";

/**
 * Every authored page, as `[file, source]`. A tuple rather than an object so each
 * assertion below can name the page it is about.
 */
const pages: [string, string][] = sitePageFiles().map((file) => [
  file,
  readFileSync(join(packageRoot, file), "utf8"),
]);

describe("the Site's build-time values", () => {
  it("substitute their placeholder, in every position", () => {
    const html = resolveSiteHtml(
      `<a href="${APEX_ORIGIN_TOKEN}/">Home</a> ${APP_ORIGIN_TOKEN} ${YEAR_TOKEN} ${APEX_ORIGIN_TOKEN}`,
    );
    expect(html).toBe(
      `<a href="${APEX_ORIGIN}/">Home</a> ${APP_ORIGIN} ${new Date().getFullYear()} ${APEX_ORIGIN}`,
    );
  });

  it("leave HTML without a placeholder untouched", () => {
    expect(resolveSiteHtml("<title>PocketCircle</title>")).toBe("<title>PocketCircle</title>");
  });

  it("resolve in every page, and each one is written down at least once", () => {
    // Every page: a token that survived a substitution would ship to a visitor as
    // the literal string `%APEX_ORIGIN%`, in a link or a card, and nothing in the
    // document would look broken. At least once across the set: a token nothing
    // uses is a value this build is carrying for a document that does not exist.
    expect(pages.length).toBeGreaterThan(0);
    for (const [file, source] of pages) {
      const resolved = resolveSiteHtml(source);
      for (const token of Object.keys(SITE_PLACEHOLDERS)) {
        expect(resolved, `${file} still has ${token}`).not.toContain(token);
      }
    }
    const everyPage = pages.map(([, source]) => source).join("\n");
    for (const token of Object.keys(SITE_PLACEHOLDERS)) {
      expect(everyPage, `${token} is defined but no page writes it`).toContain(token);
    }
  });

  it("are the transform the build runs on the HTML entry", () => {
    expect(siteHtmlPlugin().transformIndexHtml).toBe(resolveSiteHtml);
  });
});
