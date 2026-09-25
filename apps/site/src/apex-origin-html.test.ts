import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APEX_ORIGIN } from "@pocketcircle/domain/origins";
import { describe, expect, it } from "vitest";
import { APEX_ORIGIN_TOKEN, apexOriginHtmlPlugin, resolveApexOrigin } from "./apex-origin-html.js";

const indexHtml = readFileSync(join(import.meta.dirname, "../index.html"), "utf8");

describe("apex origin in the Site's HTML", () => {
  it("substitutes the canonical origin for the placeholder, in every position", () => {
    const html = resolveApexOrigin(`<a href="${APEX_ORIGIN_TOKEN}/">Home</a> ${APEX_ORIGIN_TOKEN}`);
    expect(html).toBe(`<a href="${APEX_ORIGIN}/">Home</a> ${APEX_ORIGIN}`);
  });

  it("leaves HTML without the placeholder untouched", () => {
    expect(resolveApexOrigin("<title>PocketCircle</title>")).toBe("<title>PocketCircle</title>");
  });

  it("resolves every placeholder the checked-in page writes", () => {
    expect(indexHtml).toContain(APEX_ORIGIN_TOKEN);
    expect(resolveApexOrigin(indexHtml)).not.toContain(APEX_ORIGIN_TOKEN);
  });

  it("is the transform the build runs on the HTML entry", () => {
    expect(apexOriginHtmlPlugin().transformIndexHtml).toBe(resolveApexOrigin);
  });
});
