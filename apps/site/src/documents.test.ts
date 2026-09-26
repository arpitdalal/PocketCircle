// @vitest-environment node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APEX_ORIGIN, MCP_RESOURCE_URI } from "@pocketcircle/domain/origins";
import { describe, expect, it } from "vitest";
import { anchorsOf, headingsOf, metaContentOf, tagsOf } from "./document.js";
import { packageRoot, pagePath, sitePageFiles } from "./pages.js";
import {
  APEX_HOSTNAME_TOKEN,
  APEX_ORIGIN_TOKEN,
  APP_ORIGIN_TOKEN,
  resolveSiteHtml,
} from "./site-html.js";
import { RELEASES_TOKEN } from "./whats-new.js";

/**
 * Every document the Site publishes, and the shape they all have to hold
 * (#408).
 *
 * What the *built* artifact must contain is asserted by
 * `scripts/assert-site-html.mjs`, once per page. What is asserted here is the
 * contract the documents themselves have to honour, and it is applied to all of
 * them rather than to the homepage alone — the four pages this issue added are
 * the same kind of document as the homepage, so the rules that make one of them
 * work apply to the others, and a rule written once and run over the set cannot
 * be satisfied by the page it was written for and quietly missed by the next.
 *
 * The pages are read as authored, placeholders unresolved, because which origin a
 * link names is a decision (ADR 0035) that is only visible before the two origins
 * are substituted into one string.
 */

/** Every authored page, by the path it is served on, read as it is written. */
const documents = sitePageFiles().map((file) => {
  const source = readFileSync(join(packageRoot, file), "utf8");
  return { file, path: pagePath(file), source, links: anchorsOf(source) };
});

/** The page published at a path. Throws rather than answering about a page that is not there. */
function documentAt(path: string) {
  const found = documents.find((page) => page.path === path);
  if (found === undefined) {
    throw new Error(`no page is published at ${path}`);
  }
  return found;
}

/** The documents this issue moved onto the apex, by the path they already had. */
const APEX_DOCUMENTS = ["/privacy", "/terms", "/support", "/whats-new"];

/**
 * Everything a page on this origin is allowed to link to, as the documents write
 * it: placeholders unresolved, because the two origins are one string until the
 * build substitutes them and matching on the substituted form would classify the
 * apex's own links as the app's.
 */
const DESTINATIONS = [
  // The homepage, in the canonical form its own `canonical` and `og:url` use.
  `${APEX_ORIGIN_TOKEN}/`,
  ...APEX_DOCUMENTS.map((path) => `${APEX_ORIGIN_TOKEN}${path}`),
  `${APP_ORIGIN_TOKEN}/signin`,
  `mailto:legal@${APEX_HOSTNAME_TOKEN}`,
  `mailto:support@${APEX_HOSTNAME_TOKEN}`,
  // The homepage advertises the sitemap, which the product Worker publishes today
  // and the marketing Worker takes over at the cutover (#411). It is listed here
  // rather than in the four documents' own footers because it is a machine link
  // for a crawler, not a page a reader is sent to.
  `${APEX_ORIGIN_TOKEN}/sitemap.xml`,
];

/** The links that leave the page, which is every link that is not an in-page jump. */
const offPage = (links: { href: string }[]) => links.filter((link) => !link.href.startsWith("#"));

describe.each(documents)("the page published at $path", ({ path, source, links }) => {
  /** The document as the build publishes it, for the assertions about the built shape. */
  const page = resolveSiteHtml(source);
  const headings = headingsOf(page);

  it("says what it is, once, in the two places a result is read from", () => {
    const title = /<title>([^<]+)<\/title>/.exec(page)?.[1];
    const description = metaContentOf(page, "description");
    expect(title).toBeDefined();
    expect(description).toBeDefined();
    // Repeated rather than restated: a card that says something different from the
    // search result is a second promise to keep straight.
    expect(metaContentOf(page, "og:title")).toBe(title);
    expect(metaContentOf(page, "twitter:title")).toBe(title);
    expect(metaContentOf(page, "og:description")).toBe(description);
    expect(metaContentOf(page, "twitter:description")).toBe(description);
    // Truncated in a result past this, and 160 is the ceiling both networks use.
    expect((description ?? "").length, description).toBeLessThanOrEqual(160);
  });

  it("canonicalizes to itself on the apex, which is the origin that owns it", () => {
    const canonical = `${APEX_ORIGIN}${path}`;
    expect(tagsOf(page, "link")).toContainEqual(expect.stringContaining(`href="${canonical}"`));
    expect(metaContentOf(page, "og:url")).toBe(canonical);
  });

  it("has one first-level heading and an outline that reads top to bottom", () => {
    // A skipped level tells a screen reader it has missed a section, and these
    // documents are the ones a reader arrives at from a search result to find one
    // clause.
    expect(headings.filter(([level]) => level === 1).length).toBe(1);
    expect(headings[0]?.[0]).toBe(1);
    for (const [index, [level]] of headings.entries()) {
      expect(level - (headings[index - 1]?.[0] ?? level)).toBeLessThanOrEqual(1);
    }
  });

  it("ships no runtime and asks for nothing", () => {
    // A `<script>` is the first step back to a client runtime, which ADR 0035
    // rules out because it would cost a Worker invocation per request. A control
    // is a second way to act, and a document with no runtime cannot have the
    // loading, empty, and error states one needs.
    expect(page).not.toMatch(/<script/i);
    expect(page).not.toMatch(/<(form|button|input|select|textarea)\b/i);
  });

  it("names every link and sends every one of them to a known destination", () => {
    expect(links.filter((link) => link.text.length === 0)).toEqual([]);
    // Enumerated rather than filtered for the one allowed app path, so a new
    // destination has to be added here deliberately. A relative href is excluded
    // by construction: it would resolve against whichever origin served the page,
    // which is the decision ADR 0035 makes explicitly.
    for (const link of offPage(links)) {
      expect(DESTINATIONS, link.href).toContain(link.href);
    }
  });

  it("offers a way past the header and a way into the app", () => {
    expect(links[0]?.href).toBe("#main");
    expect(page).toContain('id="main"');
    expect(
      links.filter((link) => link.href === `${APP_ORIGIN_TOKEN}/signin`).length,
    ).toBeGreaterThan(0);
  });
});

describe("the documents the apex owns", () => {
  it("are published at the four paths external material already cites", () => {
    expect(documents.map((page) => page.path)).toEqual(expect.arrayContaining(APEX_DOCUMENTS));
  });

  it("reach each other, so no document is a dead end", () => {
    // Every document links to the other three and back to the homepage, which is
    // also what keeps the set honest: one that stopped being linked to would fail
    // here rather than surfacing as a 404 somebody finds by searching. The
    // homepage is not asked to link to itself — its wordmark is an in-page jump.
    for (const path of APEX_DOCUMENTS) {
      const hrefs = new Set(documentAt(path).links.map((link) => link.href));
      for (const target of [...APEX_DOCUMENTS, "/"]) {
        expect(
          hrefs.has(`${APEX_ORIGIN_TOKEN}${target === "/" ? "/" : target}`),
          `${path} does not link to ${target}`,
        ).toBe(true);
      }
    }
  });

  it("jump nowhere but the content, because a document has no sections to jump between", () => {
    for (const path of APEX_DOCUMENTS) {
      const jumps = documentAt(path)
        .links.filter((link) => link.href.startsWith("#"))
        .map((link) => link.href);
      expect(jumps, path).toEqual(["#main"]);
    }
  });

  it("carry the one address a reader has to type, and the MCP URL an assistant is given", () => {
    // The Support page is the only one that names them, and it is the only place
    // in the Site a reader is asked to copy a URL rather than click one, so the
    // values are the build's rather than text written into the document.
    const support = resolveSiteHtml(documentAt("/support").source);
    expect(support).toContain(MCP_RESOURCE_URI);
    expect(support).toContain("mailto:support@pocketcircle.app");
    expect(support).toContain("mailto:legal@pocketcircle.app");
  });

  it("generate What's New from the changelog rather than carrying a copy of it", () => {
    // Asserted here, unresolved, and the other half of the contract is in
    // `whats-new.test.ts` (the placeholder is filled from `CHANGELOG.md`) and in
    // `assert-site-html.mjs` (the published page has no placeholder left). All
    // three are needed: this one alone is satisfied by a hand-authored release
    // list, and that one alone by a page with a hole in it.
    const { source } = documentAt("/whats-new");
    expect(source).toContain(RELEASES_TOKEN);
  });
});
