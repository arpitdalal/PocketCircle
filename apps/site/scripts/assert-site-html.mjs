import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APEX_ORIGIN } from "@pocketcircle/domain/origins";

/**
 * Build-time check on the published artifact. The Site ships no client runtime,
 * so the built document *is* the product: if the canonical origin placeholder,
 * the stylesheet, or the security headers are missing from `dist/`, nothing
 * downstream can tell — the Worker serves whatever was uploaded.
 */
const distDir = join(dirname(fileURLToPath(import.meta.url)), "../dist");
const html = readFileSync(join(distDir, "index.html"), "utf8");

const checks = [
  ["a title", /<title>[^<]+<\/title>/],
  ["a description", /<meta\s+name="description"\s+content="[^"]+"/],
  ["a canonical link", new RegExp(`<link rel="canonical" href="${APEX_ORIGIN}/"`)],
  ["an og:url", new RegExp(`<meta property="og:url" content="${APEX_ORIGIN}/"`)],
  ["the product description", /PocketCircle helps you track spending together in shared Circles/],
];

const missing = checks.filter(([, pattern]) => !pattern.test(html)).map(([what]) => what);

if (missing.length > 0) {
  throw new Error(`dist/index.html is missing ${missing.join(", ")}`);
}

if (html.includes("%APEX_ORIGIN%")) {
  throw new Error("dist/index.html still contains the apex origin placeholder");
}

const stylesheet = /<link rel="stylesheet"[^>]*href="([^"]+)"/.exec(html)?.[1];
if (stylesheet === undefined) {
  throw new Error("dist/index.html links no stylesheet");
}
if (statSync(join(distDir, stylesheet)).size === 0) {
  throw new Error(`${stylesheet} is empty — the shared brand tokens did not compile`);
}

const published = readdirSync(distDir, { recursive: true });
if (published.some((file) => file.endsWith(".js"))) {
  throw new Error(
    "dist/ contains JavaScript. The Site is a static document (ADR 0035) and must not ship a client runtime.",
  );
}

readFileSync(join(distDir, "_headers"), "utf8");

console.log("Site HTML ok (title + description + canonical apex origin + stylesheet + _headers).");
