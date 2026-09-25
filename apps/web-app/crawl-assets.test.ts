import { APEX_ORIGIN } from "@pocketcircle/domain";
import { describe, expect, it } from "vitest";
import { crawlAssets } from "./crawl-assets.js";

describe("crawlAssets", () => {
  it("serves the sitemap and every robots directive from the apex origin", () => {
    const { "robots.txt": robots, "sitemap.xml": sitemap } = crawlAssets();
    expect(robots).toContain(`Sitemap: ${APEX_ORIGIN}/sitemap.xml`);
    for (const path of ["/", "/privacy", "/terms", "/support", "/whats-new"]) {
      expect(sitemap).toContain(`<loc>${APEX_ORIGIN}${path}</loc>`);
    }
  });

  it("lists the marketing paths in the sitemap and gates the app surfaces in robots", () => {
    const { "robots.txt": robots, "sitemap.xml": sitemap } = crawlAssets();
    // The sitemap is the marketing surface; the product SPA's own routes are not
    // indexable content and are gated by robots directives instead.
    expect(sitemap).not.toContain("/signin");
    expect(robots).toContain("Disallow: /signin");
    expect(robots).toContain("Disallow: /mcp");
    // Every location and directive is apex-relative, never a hardcoded host.
    for (const line of sitemap.split("\n").filter((line) => line.includes("<loc>"))) {
      expect(line).toContain(APEX_ORIGIN);
    }
  });
});
