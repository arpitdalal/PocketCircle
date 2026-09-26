import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { APEX_ORIGIN, APP_ORIGIN } from "@pocketcircle/domain/origins";
import sharp from "sharp";
import { attributeOf, headingsOf, metaContentOf, tagsOf } from "../src/document.ts";
import { siteSecurityHeaders } from "../src/security-headers.ts";
import { SHARE_IMAGE } from "../src/share-image.ts";
import { SITE_PLACEHOLDERS } from "../src/site-html.ts";

/**
 * Build-time check on the published artifact. The Site ships no client runtime,
 * so the built document *is* the product: a section the build dropped, a
 * canonical origin left as a placeholder, a Tailwind class that never compiled,
 * a share image that came out empty, or a `_headers` rule Workers cannot parse
 * are all invisible once the artifact is uploaded — the Worker serves whatever it
 * was given.
 *
 * Every check below reads attributes by name, not by position, and reads text
 * through `src/document.ts`, the same helper the unit tests use. A gate that
 * demands `<link rel="canonical" href="…">` in that exact order, or that reports a
 * line break as part of a heading's copy, fails a document that means the same
 * thing.
 */
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(packageRoot, "dist");
const html = readFileSync(join(distDir, "index.html"), "utf8");

/** Every tag named `name` in the built document, as the raw text written. */
const openingTags = (name) => tagsOf(html, name);

/** Whether any tag named `name` carries every one of `attributes`. */
function hasTag(name, attributes) {
  return openingTags(name).some((tag) =>
    attributes.every(([attributeName, value]) => attributeOf(tag, attributeName) === value),
  );
}

/** The `content` of the first `meta` tag carrying `name` (or `property`) `key`. */
const meta = (key) => metaContentOf(html, key);

/**
 * The description is written once, in the `description` tag, and both card
 * formats have to repeat it. Comparing the three against each other rather than
 * against a constant here is the point: a second copy of the string in this
 * script would be a third place to update and would not catch either of the two
 * drifting from the document.
 */
const description = meta("description");

const missing = [
  ["a title", /<title>[^<]+<\/title>/.test(html)],
  ["a description", (description ?? "").length > 0 && (description?.length ?? 0) <= 160],
  [
    "an og:description that repeats it",
    meta("og:description") === description && description !== undefined,
  ],
  [
    "a twitter:description that repeats it",
    meta("twitter:description") === description && description !== undefined,
  ],
  ["an og:title", (meta("og:title") ?? "").length > 0],
  ["a twitter:title", (meta("twitter:title") ?? "").length > 0],
  ["a card large enough to be worth rendering", meta("twitter:card") === "summary_large_image"],
  [
    "a canonical link",
    hasTag("link", [
      ["rel", "canonical"],
      ["href", `${APEX_ORIGIN}/`],
    ]),
  ],
  [
    "an og:url",
    hasTag("meta", [
      ["property", "og:url"],
      ["content", `${APEX_ORIGIN}/`],
    ]),
  ],
  [
    "an absolute share image on the apex",
    meta("og:image") === `${APEX_ORIGIN}/${SHARE_IMAGE.published}` &&
      meta("twitter:image") === meta("og:image") &&
      meta("og:image:type") === "image/png" &&
      meta("og:image:width") === String(SHARE_IMAGE.width) &&
      meta("og:image:height") === String(SHARE_IMAGE.height) &&
      (meta("og:image:alt") ?? "").length > 0,
  ],
  [
    "a branded favicon",
    hasTag("link", [
      ["rel", "icon"],
      ["href", "/favicon.svg"],
    ]),
  ],
  // Which origin owns a destination — ADR 0035 puts the marketing surfaces on
  // the apex and sign-in on the app — is asserted in `src/marketing-home.test.ts`,
  // because the two are one string until the cutover gives the app its
  // subdomain. What is asserted here is that each destination is still written
  // down at all, and absolutely rather than relative to the staging host.
  ["a sign-in link to the app origin", hasTag("a", [["href", `${APP_ORIGIN}/signin`]])],
  ["a Terms link on the apex", hasTag("a", [["href", `${APEX_ORIGIN}/terms`]])],
  ["a Privacy link on the apex", hasTag("a", [["href", `${APEX_ORIGIN}/privacy`]])],
]
  .filter(([, present]) => !present)
  .map(([what]) => what);

if (missing.length > 0) {
  throw new Error(`dist/index.html is missing ${missing.join(", ")}`);
}

/** The stylesheet the page's styling depends on, as a path relative to `dist/`. */
const stylesheet = openingTags("link")
  .filter((tag) => attributeOf(tag, "rel") === "stylesheet")
  .map((tag) => attributeOf(tag, "href"))
  .find((href) => href !== undefined);

if (stylesheet === undefined) {
  throw new Error("dist/index.html links no stylesheet");
}

/**
 * The share image is the one asset a crawler fetches from outside the page, so
 * nothing else in the build would notice it missing, truncated, or the wrong
 * size: the document above would be perfect and the card would still be a blank
 * rectangle in a timeline. It is read from `dist/`, which is what the Worker
 * uploads, not from the source it was rendered from.
 *
 * `metadata()` only reads the header, so it is followed by a real decode: a PNG
 * that was cut short part way through its image data still has a perfectly valid
 * IHDR and would sail through the header checks on its own.
 */
const publishedCard = join(distDir, SHARE_IMAGE.published);
const shareImage = await sharp(publishedCard).metadata();

if (
  shareImage.format !== "png" ||
  shareImage.width !== SHARE_IMAGE.width ||
  shareImage.height !== SHARE_IMAGE.height
) {
  throw new Error(
    `dist/${SHARE_IMAGE.published} is ${shareImage.format} at ${shareImage.width}x${shareImage.height}, want a ${SHARE_IMAGE.width}x${SHARE_IMAGE.height} png`,
  );
}

// Throws on a truncated or otherwise undecodable raster, which is the failure the
// header check above cannot see.
await sharp(publishedCard).raw().toBuffer();

/**
 * The homepage's headings, in order, as `[level, text]` — the one place the copy
 * order is written down. It lives here rather than beside the source because
 * this is the artifact a visitor is served: an assertion about the checked-in
 * file would only ever prove the build did what it did last time.
 */
const sections = headingsOf(html);

const expectedSections = [
  [1, "Track the money you share, together"],
  [2, "What a Circle is"],
  [2, "One ledger instead of the group chat"],
  [3, "Everyone writes to the same list"],
  [3, "Totals that answer the question"],
  [3, "Attribution on every row"],
  [3, "A record of every change"],
  [2, "Let an assistant read the ledger"],
  [2, "Up and running in minutes"],
  [3, "Sign in with Google"],
  [3, "Open a Circle"],
  [3, "Invite, then record"],
  [2, "Straight answers"],
  [3, "Does PocketCircle work out who owes whom?"],
  [3, "Is there a free plan, or a trial that expires?"],
  [3, "Can I use it on my own?"],
  [3, "Who can see a Circle I am in?"],
  [3, "What happens when someone leaves a Circle?"],
  [3, "Can it import transactions from my bank?"],
  [3, "Can I set a budget or a spending limit?"],
  [3, "Does it work on a phone?"],
  [3, "Can I delete my account?"],
  [2, "Start your first Circle"],
];

if (JSON.stringify(sections) !== JSON.stringify(expectedSections)) {
  throw new Error(
    `dist/index.html does not carry the homepage's sections in order.\n  found:    ${JSON.stringify(sections)}\n  expected: ${JSON.stringify(expectedSections)}`,
  );
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

/**
 * The safe-area compensation has to survive the build, which is checked here
 * rather than in the source because the source is not what ships.
 *
 * `env(safe-area-inset-*)` written directly inside a nested block of an
 * `@utility` is dropped by the build: the `+ env(...)` clause disappears from the
 * emitted rule and the offset silently becomes a flat `16px`, which is correct
 * on every device without a cutout and wrong on exactly the devices the code was
 * written for. Nothing else in the build can see that, and the page still looks
 * right in a browser with no insets — so the artifact is what gets asserted, the
 * way the rest of this script does.
 */
const INSETS = ["top", "right", "bottom", "left"];
const lostInsets = INSETS.filter(
  (side) => !css.includes(`--safe-area-${side}:env(safe-area-inset-${side},0px)`),
);
if (lostInsets.length > 0) {
  throw new Error(
    `the built stylesheet does not declare ${lostInsets.map((side) => `--safe-area-${side}`).join(", ")} from the device insets, so the page is not padded for a cutout`,
  );
}

// Every consumer has to read those four rather than re-derive them, because
// re-deriving is the shape that gets dropped.
//
// The horizontal pair is looped, not written out twice: a rule that names one
// side of a symmetric thing is a rule that will be satisfied by a stylesheet
// missing the other side, which is exactly the device this was written for.
for (const side of ["left", "right"]) {
  for (const [what, pattern] of [
    [
      `the page wrapper's ${side} padding`,
      new RegExp(`\\.safe-x\\{[^}]*padding-${side}:var\\(--safe-area-${side}\\)`),
    ],
    ["the header's top padding", /\.safe-top\{[^}]*var\(--safe-area-top\)/],
    ["the footer's bottom padding", /\.safe-bottom\{[^}]*var\(--safe-area-bottom\)/],
    [
      "the focused skip link's offsets",
      /\.skip-link:focus-visible\{[^}]*top:calc\(var\(--spacing\) \* 4 \+ var\(--safe-area-top\)\)[^}]*left:calc\(var\(--spacing\) \* 4 \+ var\(--safe-area-left\)\)/,
    ],
  ]) {
    if (!pattern.test(css)) {
      throw new Error(`the built stylesheet lost the device inset for ${what}`);
    }
  }
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

// The placeholders reach HTML through the transform, and nothing else — a token
// in any other published file would ship to production as a literal.
const unsubstituted = published.filter((file) =>
  Object.keys(SITE_PLACEHOLDERS).some((token) =>
    readFileSync(join(distDir, file), "utf8").includes(token),
  ),
);

if (unsubstituted.length > 0) {
  throw new Error(`Still contains an unsubstituted placeholder: ${unsubstituted.join(", ")}`);
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
  `Site HTML ok (${authoredPages.length} page + ${expectedSections.length} headings in order + title + description repeated into both cards + ${SHARE_IMAGE.published} at ${SHARE_IMAGE.width}x${SHARE_IMAGE.height} + canonical apex origin + split-origin links + compiled classes + _headers).`,
);
