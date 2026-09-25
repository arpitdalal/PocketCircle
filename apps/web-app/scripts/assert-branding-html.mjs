import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MCP_RESOURCE_URI } from "@pocketcircle/domain/origins";
import { crawlAssets } from "../crawl-assets.ts";

/**
 * Build-time check: Google branding crawlers read static HTML (no JS). Fail the
 * build if the SPA shell or prerendered legal pages lose required copy, or if
 * the generated crawl directives (#404) were not emitted as generated.
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

// The crawl directives are generated, not checked in, so the build is the only
// place they can go missing or drift. Compare them to the generator rather than
// to a second, hand-written copy of the path list.
for (const [fileName, expected] of Object.entries(crawlAssets())) {
  requireHtml(fileName, []);
  if (readFileSync(join(clientDir, fileName), "utf8") !== expected) {
    throw new Error(`${fileName} does not match crawl-assets.ts`);
  }
}

console.log("Branding HTML ok (index + privacy + terms + support + whats-new + crawl assets).");
