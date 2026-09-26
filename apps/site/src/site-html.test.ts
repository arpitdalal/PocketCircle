import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APEX_ORIGIN, APP_ORIGIN } from "@pocketcircle/domain/origins";
import { describe, expect, it } from "vitest";
import {
  APEX_ORIGIN_TOKEN,
  APP_ORIGIN_TOKEN,
  resolveSiteHtml,
  SITE_PLACEHOLDERS,
  siteHtmlPlugin,
  YEAR_TOKEN,
} from "./site-html.js";

const indexHtml = readFileSync(join(import.meta.dirname, "../index.html"), "utf8");

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

  it("resolve every placeholder the checked-in page writes", () => {
    const html = resolveSiteHtml(indexHtml);
    for (const token of Object.keys(SITE_PLACEHOLDERS)) {
      expect(indexHtml).toContain(token);
      expect(html).not.toContain(token);
    }
  });

  it("are the transform the build runs on the HTML entry", () => {
    expect(siteHtmlPlugin().transformIndexHtml).toBe(resolveSiteHtml);
  });
});
