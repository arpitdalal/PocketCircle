import { APEX_ORIGIN } from "@pocketcircle/domain";
import { describe, expect, it } from "vitest";
import { crawlAssets } from "./crawl-assets.js";

describe("crawlAssets", () => {
  it("serves the sitemap and every robots directive from the apex origin", () => {
    const { "robots.txt": robots, "sitemap.xml": sitemap } = crawlAssets();
    expect(robots).toContain(`Sitemap: ${APEX_ORIGIN}/sitemap.xml`);
    expect(sitemap).toContain(`<loc>${APEX_ORIGIN}/</loc>`);
    for (const path of ["/privacy", "/terms", "/support", "/whats-new"]) {
      expect(sitemap).toContain(`<loc>${APEX_ORIGIN}${path}</loc>`);
    }
  });

  it("keeps auth-gated surfaces out of the crawl budget", () => {
    const { "robots.txt": robots, "sitemap.xml": sitemap } = crawlAssets();
    expect(robots).toContain("Disallow: /signin");
    expect(robots).toContain("Disallow: /mcp");
    // The product SPA is not indexable content; only marketing paths are listed.
    expect(sitemap).not.toContain("/signin");
  });
});
