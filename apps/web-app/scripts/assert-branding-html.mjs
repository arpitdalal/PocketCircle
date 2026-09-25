import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APEX_ORIGIN, MCP_RESOURCE_URI } from "../../../packages/domain/src/origins.ts";

/**
 * Build-time check: Google branding crawlers read static HTML (no JS). Fail the
 * build if the SPA shell or prerendered legal pages lose required copy, or if
 * the generated crawl directives (crawl-assets.ts, #404) go missing or drift
 * onto an origin that is not the canonical apex.
 */
const clientDir = join(dirname(fileURLToPath(import.meta.url)), "../build/client");

function requireHtml(relativePath, needles) {
  const path = join(clientDir, relativePath);
  if (!existsSync(path)) {
    throw new Error(`Missing branding HTML: ${relativePath}`);
  }
  const html = readFileSync(path, "utf8");
  for (const needle of needles) {
    if (!html.includes(needle)) {
      throw new Error(`${relativePath} missing ${JSON.stringify(needle)}`);
    }
  }
}

if (existsSync(join(clientDir, "__spa-fallback.html"))) {
  throw new Error(
    "Unexpected __spa-fallback.html — prerendering `/` breaks Cloudflare SPA fallback (always uses /index.html). Keep `/` off the prerender list.",
  );
}

requireHtml("index.html", [
  "PocketCircle",
  "PocketCircle helps you track spending together in shared Circles",
  "Privacy Policy",
  'href="/privacy"',
  "Continue with Google",
]);

requireHtml("privacy/index.html", ["Privacy Policy", "Information we collect"]);
requireHtml("terms/index.html", ["Terms &amp; Conditions"]);
requireHtml("support/index.html", ["Support", MCP_RESOURCE_URI]);
requireHtml("whats-new/index.html", ["What&#x27;s new"]);

// Generated, not checked in: assert the plugin emitted them on the apex origin.
requireHtml("robots.txt", [`Sitemap: ${APEX_ORIGIN}/sitemap.xml`]);
requireHtml("sitemap.xml", [`<loc>${APEX_ORIGIN}/</loc>`]);

console.log("Branding HTML ok (index + privacy + terms + support + whats-new + crawl assets).");
