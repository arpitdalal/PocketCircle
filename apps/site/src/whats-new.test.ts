// @vitest-environment node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseChangelog } from "@pocketcircle/domain/changelog";
import { describe, expect, it } from "vitest";
import { anchorsOf, headingsOf, textOf } from "./document.js";
import { packageRoot } from "./pages.js";
import { fillReleases, RELEASES_TOKEN, renderReleases, whatsNewPlugin } from "./whats-new.js";

/**
 * The generated half of the What's New page (#408).
 *
 * The releases are not authored: they are rendered from the repository's
 * `CHANGELOG.md` at build time, so the page cannot disagree with the changelog and
 * cannot need editing on a release. What is asserted here is the rendering — one
 * disclosure per released version, newest first and open, the emphasis the file
 * uses rendered rather than printed, and Markdown treated as text — and that the
 * build's transform is what fills the placeholder.
 */

const changelog = readFileSync(join(packageRoot, "..", "..", "CHANGELOG.md"), "utf8");

const transform = fillReleases;

/** The page these fixtures are the markup of. */
const PAGE = { filename: "whats-new.html" };

function render(markdown: string) {
  const html = renderReleases(markdown);
  return { html, page: `<div>${html}</div>` };
}

describe("the release list", () => {
  it("is one disclosure per released version, newest first, with the newest open", () => {
    const { page } = render(`## [v1.1.0] - 2026-02-01

### Added

- Newer

## [v1.0.0] - 2026-01-02

### Fixed

- Older
`);

    expect([...page.matchAll(/<details[^>]*>/g)].map((tag) => tag[0])).toEqual([
      '<details class="faq-item" open>',
      '<details class="faq-item">',
    ]);
    expect(headingsOf(page).map(([, text]) => text)).toEqual([
      "v1.1.0 · 2026-02-01",
      "Added",
      "v1.0.0 · 2026-01-02",
      "Fixed",
    ]);
  });

  it("reads as text, so a heading outline reaches the version and the category", () => {
    // The page's own `h1` is above this, so the versions are its `h2`s and the
    // categories their `h3`s — the in-app archive jumps straight from `h1` to
    // `h3` because its disclosure is a widget, not markup in the outline.
    const { page } = render(`## [v1.0.0] - 2026-01-02

An introduction.

### Added

- A thing
`);

    expect(headingsOf(page).map(([level]) => level)).toEqual([2, 3]);
    expect(textOf(page)).toContain("An introduction.");
    expect(textOf(page)).toContain("A thing");
  });

  it("renders the one inline emphasis the changelog uses, and escapes the rest", () => {
    // The changelog writes `**My Transactions** — find Transactions…`; a published
    // page that printed the asterisks would look broken. Everything else stays
    // text, so a release note can never become markup.
    const { page } = render(`## [v1.0.0] - 2026-01-02

### Added

- **My Transactions** — 5 < 6 & 7 > 2, a *star* and a 2*3=6 asterisk
`);

    expect(page).toContain(
      '<strong class="text-foreground">My Transactions</strong> — 5 &lt; 6 &amp; 7 &gt; 2',
    );
    expect(textOf(page)).toContain("a *star* and a 2*3=6 asterisk");
    expect(page).not.toContain("<script");
  });

  it("says so when nothing has shipped, rather than rendering an empty list", () => {
    const { page } = render(`# Changelog

## [Unreleased]

### Added

- Not shipped
`);

    expect(page).not.toContain("<details");
    expect(textOf(page)).toBe("No released updates yet.");
  });
});

describe("the build's transform", () => {
  it("fills the page's placeholder from the repository's changelog", () => {
    const newest = parseChangelog(changelog)[0];
    expect(newest).toBeDefined();

    const filled = transform(`<h1>What's new</h1><div>${RELEASES_TOKEN}</div>`, {
      filename: "whats-new.html",
    });

    expect(filled).not.toContain(RELEASES_TOKEN);
    expect(filled).toContain(newest?.version ?? "");
    // The same releases the in-app archive renders, which is what makes the two
    // surfaces one history rather than two catalogs that happen to agree.
    expect(parseChangelog(changelog).map((section) => section.version)).toEqual(
      expect.arrayContaining(["v0.7.0", "v0.6.0"]),
    );
  });

  it("is the transform the build runs on every page, and names the page it refused", () => {
    // The hook is `fillReleases` itself, so the wiring is asserted rather than
    // assumed — the same shape as `siteHtmlPlugin`, whose transform is asserted the
    // same way. Every entry goes through it, including the four that ask for
    // nothing, and the one that asks twice is told which file to open.
    expect(whatsNewPlugin().transformIndexHtml).toBe(fillReleases);
    expect(transform("<p>no placeholder here</p>", { filename: "privacy.html" })).toBe(
      "<p>no placeholder here</p>",
    );
    expect(() =>
      transform(`${RELEASES_TOKEN}${RELEASES_TOKEN}`, { filename: "whats-new.html" }),
    ).toThrow(/^whats-new\.html writes %RELEASES% 2 times/);
  });

  it("leaves a page with no placeholder exactly as it found it", () => {
    // Every other page goes through the same transform, and a page that does not
    // ask for the release list must come out byte-identical.
    const page = '<a href="%APEX_ORIGIN%/privacy">Privacy Policy</a>';
    expect(transform(page, { filename: "privacy.html" })).toBe(page);
  });

  it("refuses a page that writes the placeholder twice", () => {
    // The first occurrence is the one that would be filled, so a second one — a
    // second region, or the placeholder named in a comment above the real one —
    // would have that comment filled and leave the hole in the document, which
    // builds green and ships a page with no releases on it.
    expect(() => transform(`${RELEASES_TOKEN}<p>and again</p>${RELEASES_TOKEN}`, PAGE)).toThrow(
      /writes %RELEASES% 2 times/,
    );
  });

  it("prints a release note that contains a substitution pattern verbatim", () => {
    // `$&` and `$1` are patterns to `String.replace` when the replacement is a
    // string, so a note containing one would be spliced into the document instead
    // of printed — and the page would carry a stray fragment of itself.
    const { page } = render(`## [v1.0.0] - 2026-01-02

### Added

- Costs $& and $1 and a backtick \` per month
`);

    expect(textOf(page)).toContain("Costs $& and $1 and a backtick ` per month");
  });
});

describe("the generated region's markup", () => {
  it("adds no link the page's own destination rules would not allow", () => {
    // The document contract (`documents.test.ts`) holds every page's links to a
    // fixed set, and this is the half of that a generated region could break
    // without any authored file changing.
    expect(anchorsOf(renderReleases(changelog))).toEqual([]);
  });
});
