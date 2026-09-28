import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MCP_RESOURCE_URI } from "@pocketcircle/domain/origins";

/**
 * Build-time check on the app origin's own static documents.
 *
 * This used to assert that the SPA shell carried PocketCircle's purpose copy and its
 * legal links, because a signed-out visitor at `/` was served a marketing page and
 * Google read the shell without running JavaScript. The public surfaces are the
 * marketing Site's own origin now (#411) and the app's root is a sign-in redirect
 * (#412), so there is no branding to assert here: `apps/site/scripts/assert-site-html.mjs`
 * holds the apex documents, and the deploy's "Verify marketing Site" step holds the
 * origin they are served from.
 *
 * What is left is the app origin's own integrity, which is a different question and
 * still fails the build when broken: the crawl directives that keep the authenticated
 * app out of search results, the four legal documents the app's chrome links to for a
 * signed-in User, the existence of the SPA shell every request here falls back to, and
 * the `__spa-fallback.html` guard. `legal-documents.test.tsx` is what holds the app's
 * copy identical to the apex's, which is the copy Google reads.
 */
const clientDir = join(dirname(fileURLToPath(import.meta.url)), "../build/client");

function requireHtml(relativePath, needles) {
  const path = join(clientDir, relativePath);
  if (!existsSync(path)) {
    throw new Error(`Missing app-origin HTML: ${relativePath}`);
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

/**
 * The SPA shell exists — and that is the whole assertion.
 *
 * It used to also be the marketing copy, which #412 deleted along with the page it came
 * from. Removing those needles took this file's only pre-deploy read of the shell with it,
 * and nothing replaced it: the deploy's "Verify product app origins" step reads
 * `index.html`, but it runs *after* "Deploy product app Worker", so a build that produced
 * the legal pages and robots.txt and no shell would ship and only then fail the job.
 *
 * A build that cannot produce the file every request to this origin falls back to is
 * broken in a way no other check here would notice, so the check that catches it belongs
 * at build time where it costs a release nothing.
 */
requireHtml("index.html", []);

/**
 * The app origin's own crawl directives. Checked for *content*, not just presence,
 * because the failure that matters here is a robots.txt that exists but is too
 * permissive: the marketing Site's directives are generated from the page list, and
 * this one is checked in, so nothing else would notice it being loosened.
 *
 * Also the check that the SPA fallback has not started answering `/robots.txt` with
 * the app shell, which is what an absent file produces.
 */
const robots = readFileSync(join(clientDir, "robots.txt"), "utf8");
if (!/^User-agent: \*$/m.test(robots) || !/^Disallow: \/$/m.test(robots)) {
  throw new Error(
    "robots.txt does not disallow everything on the app origin: the public surfaces are the marketing Site's, and an authenticated app has nothing here for a crawler to index",
  );
}

requireHtml("privacy/index.html", ["Privacy Policy", "Information we collect"]);
requireHtml("terms/index.html", ["Terms &amp; Conditions"]);
requireHtml("support/index.html", ["Support", MCP_RESOURCE_URI]);
requireHtml("whats-new/index.html", ["What&#x27;s new"]);

console.log("App-origin HTML ok (privacy + terms + support + whats-new + app-origin robots).");
