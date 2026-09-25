import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { APEX_ORIGIN } from "@pocketcircle/domain/origins";
import { APEX_ORIGIN_TOKEN } from "../src/apex-origin-html.ts";
import { siteSecurityHeaders } from "../src/security-headers.ts";

/**
 * Build-time check on the published artifact. The Site ships no client runtime,
 * so the built document *is* the product: a canonical origin left as a
 * placeholder, a page the build dropped, a Tailwind class that never compiled,
 * or a `_headers` rule Workers cannot parse are all invisible once the artifact
 * is uploaded — the Worker serves whatever it was given.
 */
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(packageRoot, "dist");
const html = readFileSync(join(distDir, "index.html"), "utf8");

const checks = [
  ["a title", /<title>[^<]+<\/title>/],
  ["a description", /<meta\s+name="description"\s+content="[^"]+"/],
  ["the product description", /PocketCircle helps you track spending together in shared Circles/],
];

const missing = checks.filter(([, pattern]) => !pattern.test(html)).map(([what]) => what);

if (missing.length > 0) {
  throw new Error(`dist/index.html is missing ${missing.join(", ")}`);
}

// Substring checks, not patterns: the origin is data, and a regex built from it
// would treat its dots as wildcards.
for (const [what, tag] of [
  ["a canonical link", `<link rel="canonical" href="${APEX_ORIGIN}/"`],
  ["an og:url", `<meta property="og:url" content="${APEX_ORIGIN}/"`],
]) {
  if (!html.includes(tag)) {
    throw new Error(`dist/index.html is missing ${what} on the canonical apex origin`);
  }
}

const stylesheet = /<link rel="stylesheet"[^>]*href="([^"]+)"/.exec(html)?.[1];
if (stylesheet === undefined) {
  throw new Error("dist/index.html links no stylesheet");
}
// Tailwind escapes a variant in the selector it generates (`.sm\:text-5xl`), so
// the backslashes come out before a class name is looked for in it.
const css = readFileSync(join(distDir, stylesheet), "utf8").replaceAll("\\", "");

// A class Tailwind never recognised is emitted as nothing, so the page ships
// unstyled with a green build. Every class the document uses must be in the CSS.
const uncompiled = [
  ...new Set(
    [...html.matchAll(/class="([^"]*)"/g)].flatMap((match) => (match[1] ?? "").split(/\s+/)),
  ),
].filter((className) => className.length > 0 && !css.includes(className));

if (uncompiled.length > 0) {
  throw new Error(`Tailwind emitted no rule for ${uncompiled.join(", ")}`);
}

/** Every file the build published, as a path relative to `dist/`. */
function publishedFiles(directory) {
  return readdirSync(directory, { recursive: true })
    .map((file) => relative(directory, join(directory, file)).split(sep).join("/"))
    .filter((file) => statSync(join(directory, file)).isFile());
}

// A second page is not a build input unless it is wired as one, and a dropped
// page is a 404 nobody notices — so every authored page must be published.
const authoredPages = readdirSync(packageRoot, { recursive: true })
  .filter((file) => file.endsWith(".html") && !file.split(sep).includes("dist"))
  .map((file) => relative(packageRoot, join(packageRoot, file)).split(sep).join("/"));

const published = publishedFiles(distDir);
const unpublished = authoredPages.filter((page) => !published.includes(page));

if (unpublished.length > 0) {
  throw new Error(`Not published, so the Worker would 404 them: ${unpublished.join(", ")}`);
}

// The placeholder reaches HTML through the transform, and nothing else — a token
// in any other published file would ship to production as a literal.
const unsubstituted = published.filter((file) =>
  readFileSync(join(distDir, file), "utf8").includes(APEX_ORIGIN_TOKEN),
);

if (unsubstituted.length > 0) {
  throw new Error(`Still contains ${APEX_ORIGIN_TOKEN}: ${unsubstituted.join(", ")}`);
}

// ADR 0035: a static document, generated once at build time. A script tag is the
// first step back to a client runtime, and it would cost Worker invocations.
if (/<script/i.test(html)) {
  throw new Error("dist/index.html loads a script. The Site must stay a static document");
}

if (statSync(join(distDir, stylesheet)).size === 0) {
  throw new Error(`${stylesheet} is empty — the shared brand tokens did not compile`);
}

const productHeaders = readFileSync(join(packageRoot, "../web-app/public/_headers"), "utf8");
const publishedHeaders = readFileSync(join(distDir, "_headers"), "utf8");

if (publishedHeaders !== siteSecurityHeaders(productHeaders)) {
  throw new Error("dist/_headers is not the product's global security-header rule");
}

console.log(
  `Site HTML ok (${authoredPages.length} page + title + description + canonical apex origin + compiled classes + _headers).`,
);
