import { APEX_ORIGIN } from "@pocketcircle/domain/origins";
import { describe, expect, it } from "vitest";
import { crawlAssets } from "./crawl-assets.js";
import { indexablePagePaths, NOT_FOUND_PAGE, sitePageFiles } from "./pages.js";

describe("the apex crawl assets", () => {
  it("point robots.txt at the sitemap on the apex origin", () => {
    expect(crawlAssets()["robots.txt"]).toContain(`Sitemap: ${APEX_ORIGIN}/sitemap.xml`);
  });

  it("list every page this Site publishes, and only those", () => {
    // Derived from the pages rather than from a list, so a page that is published
    // but unserved — or served but unpublished — is a failure here instead of a
    // silent omission from a sitemap a crawler trusts.
    const sitemap = crawlAssets()["sitemap.xml"];
    const expected = indexablePagePaths();
    expect(expected.length).toBeGreaterThan(0);

    for (const path of expected) {
      expect(sitemap).toContain(`<loc>${APEX_ORIGIN}${path}</loc>`);
    }
    // Every location is apex-relative, so no path can smuggle in another host.
    for (const line of sitemap.split("\n").filter((line) => line.includes("<loc>"))) {
      expect(line).toContain(APEX_ORIGIN);
    }
    expect(sitemap.match(/<loc>/g)).toHaveLength(expected.length);
  });

  it("keep the not-found document and the product out of the sitemap", () => {
    // The 404 answers at no address in particular, and the product lives on the app
    // origin now — a sitemap entry for either is a URL a crawler follows to nothing.
    const sitemap = crawlAssets()["sitemap.xml"];
    expect(sitemap).not.toContain(`${APEX_ORIGIN}/404`);
    expect(sitemap).not.toContain("/signin");
    expect(indexablePagePaths()).not.toContain("/404");
  });

  it("keep the product's own routes out of robots.txt, because they are redirects now", () => {
    // The product used to Disallow its auth-gated surfaces here. Every one of them is
    // a legacy redirect to the app origin, and a Disallow on a redirect is a crawler
    // instruction about a document that does not exist — so the list is gone, not moved.
    const robots = crawlAssets()["robots.txt"];
    expect(robots).toContain("Allow: /");
    expect(robots).not.toMatch(/^Disallow:/m);
    expect(robots).not.toContain("/signin");
    expect(robots).not.toContain("/mcp");
  });

  it("name the not-found document the Worker is configured to serve", () => {
    // `assets.not_found_handling: "404-page"` is a string in a wrangler config and
    // this is the file name it means; nothing else ties the two together.
    expect(sitePageFiles()).toContain(NOT_FOUND_PAGE);
  });
});
