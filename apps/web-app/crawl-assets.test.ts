import { APEX_ORIGIN } from "@pocketcircle/domain";
import { describe, expect, it } from "vitest";
import { crawlAssets } from "./crawl-assets.js";

const MARKETING_PATHS = ["/", "/privacy", "/terms", "/support", "/whats-new"];

describe("crawlAssets", () => {
  it("points robots.txt at the sitemap on the apex origin", () => {
    expect(crawlAssets()["robots.txt"]).toContain(`Sitemap: ${APEX_ORIGIN}/sitemap.xml`);
  });

  it("lists every marketing path in the sitemap on the apex origin", () => {
    const sitemap = crawlAssets()["sitemap.xml"];
    for (const path of MARKETING_PATHS) {
      expect(sitemap).toContain(`<loc>${APEX_ORIGIN}${path}</loc>`);
    }
    // Every location is apex-relative, so no path can smuggle in another host.
    for (const line of sitemap.split("\n").filter((line) => line.includes("<loc>"))) {
      expect(line).toContain(APEX_ORIGIN);
    }
  });

  it("keeps the product SPA's own routes out of the sitemap", () => {
    const sitemap = crawlAssets()["sitemap.xml"];
    for (const path of MARKETING_PATHS) {
      expect(sitemap).not.toContain(`${APEX_ORIGIN}${path}/`);
    }
    expect(sitemap).not.toContain("/signin");
  });

  it("gates the auth-gated app surfaces in robots.txt", () => {
    const robots = crawlAssets()["robots.txt"];
    expect(robots).toContain("Disallow: /signin");
    expect(robots).toContain("Disallow: /mcp");
  });
});
