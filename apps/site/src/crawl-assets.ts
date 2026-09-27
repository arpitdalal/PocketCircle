import { APEX_ORIGIN } from "@pocketcircle/domain/origins";
import type { Plugin } from "vite";
import { indexablePagePaths } from "./pages.js";

/**
 * Crawl directives for the apex, generated rather than checked in as static files
 * so an origin move cannot leave a sitemap or robots.txt advertising the old host.
 *
 * These belong here and not in `apps/web-app` because of who serves them: since the
 * ADR 0035 cutover the apex is the marketing Site, and the product Worker is on the
 * app subdomain where there is nothing public to crawl. A robots.txt on the app
 * origin would be a file nobody fetches, and a sitemap there would list documents
 * that are not there.
 *
 * The disallowed list the product carried is deliberately gone rather than moved.
 * Every one of those paths is a legacy redirect to the app origin now, and a
 * `Disallow` on a redirect is a crawler instruction about a document that does not
 * exist. What remains is the whole of the policy: this origin has nothing private on
 * it, and here is where the sitemap is.
 */

/** File name → body, emitted into the build and served by the dev server. */
export function crawlAssets() {
  const paths = indexablePagePaths();
  return {
    "robots.txt": `${["User-agent: *", "Allow: /", "", `Sitemap: ${APEX_ORIGIN}/sitemap.xml`].join(
      "\n",
    )}\n`,
    "sitemap.xml": `${[
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      ...paths.map((path) => `  <url>\n    <loc>${APEX_ORIGIN}${path}</loc>\n  </url>`),
      "</urlset>",
    ].join("\n")}\n`,
  };
}

export function crawlAssetsPlugin(): Plugin {
  const assets = Object.entries(crawlAssets());
  return {
    name: "pocketcircle:crawl-assets",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const match = assets.find(([fileName]) => request.url === `/${fileName}`);
        if (!match) {
          next();
          return;
        }
        const [fileName, source] = match;
        response.setHeader(
          "Content-Type",
          fileName.endsWith(".xml") ? "application/xml" : "text/plain",
        );
        response.end(source);
      });
    },
    generateBundle() {
      for (const [fileName, source] of assets) {
        this.emitFile({ type: "asset", fileName, source });
      }
    },
  };
}
