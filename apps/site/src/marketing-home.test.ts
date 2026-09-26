import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COLOR_PALETTE, PERSONAL_CIRCLE_COLOR_HEX } from "@pocketcircle/domain";
import { APEX_ORIGIN, APP_ORIGIN } from "@pocketcircle/domain/origins";
import { describe, expect, it } from "vitest";
import { anchorsOf, headingsOf, metaContentOf } from "./document.js";
import { APEX_ORIGIN_TOKEN, APP_ORIGIN_TOKEN, resolveSiteHtml } from "./site-html.js";

/**
 * The marketing homepage (#407). What the *built* artifact must contain is
 * asserted by `scripts/assert-site-html.mjs`; what is asserted here is the
 * contract the document itself has to honour — which origin owns which
 * destination (ADR 0035), a link for every jump, a name on every link, one action
 * rather than two competing ones, a heading outline a screen reader can follow,
 * and no runtime. Both read the markup through `document.ts`, so what a heading
 * says cannot come to mean one thing here and another there.
 */
const authored = readFileSync(join(import.meta.dirname, "../index.html"), "utf8");
const page = resolveSiteHtml(authored);

/**
 * The same anchors as authored, placeholders unresolved. The two origins are one
 * string until the ADR 0035 cutover moves the app to its subdomain, so which
 * destination belongs to which is only visible here: after substitution the
 * distinction is gone, and a link silently on the wrong origin would pass every
 * check written against the built document.
 */
const authoredLinks = anchorsOf(authored);
const links = anchorsOf(page);

/** The `id` of every element the document declares. */
const ids = new Set([...page.matchAll(/\sid="([^"]*)"/g)].map((match) => match[1]));

const headings = headingsOf(page);

/** Every inline swatch the document paints, as `[tint, colour]`. */
const swatches = [
  ...page.matchAll(/style="background-color: (#[0-9a-f]{6})26; color: (#[0-9a-f]{6})"/g),
].map((match) => [match[1], match[2]]);

/** The colours a Circle or Category can be given in the app. */
const CIRCLE_COLOURS = [...COLOR_PALETTE.map((color) => color.hex), PERSONAL_CIRCLE_COLOR_HEX];

/**
 * The marketing surfaces the apex keeps canonical ownership of (ADR 0035): the
 * URLs already published in external submission material, which must keep
 * resolving to the same place, and which Google requires to share the branding
 * homepage's domain. None of them belongs on the app origin.
 */
const APEX_SURFACES: Readonly<Record<string, string>> = {
  Terms: "/terms",
  "Privacy Policy": "/privacy",
  "What's new": "/whats-new",
  Support: "/support",
  Sitemap: "/sitemap.xml",
};

/** The one place the page asks for anything, which is an account. */
const SIGN_IN = `${APP_ORIGIN_TOKEN}/signin`;

describe("the marketing homepage is a complete static document", () => {
  it("labels every one of its link groups", () => {
    expect([...page.matchAll(/<nav\s+aria-label="([^"]+)"/g)].map((match) => match[1])).toEqual([
      "On this page",
      "PocketCircle",
      "Legal",
    ]);
  });

  it("names every link, so it is announced and hit-testable", () => {
    expect(links.filter((link) => link.text.length === 0)).toEqual([]);
  });

  it("ships no runtime to reveal any of it", () => {
    expect(page).not.toMatch(/<script/i);
  });

  it("loads no image, so there is nothing to arrive late and shift the page", () => {
    // The page is CSS and text. A first-party image would need intrinsic
    // dimensions to avoid a layout shift and a fallback to stay useful with
    // images blocked, and there is nothing here that needs one: the product is
    // drawn, not photographed.
    expect(page).not.toMatch(/<img\b/i);
  });

  it("paints its Circle marks in the app's Circle colours, over the same tint", () => {
    expect(swatches.length).toBeGreaterThan(0);
    for (const [tint, colour] of swatches) {
      expect(tint).toBe(colour);
      expect(CIRCLE_COLOURS).toContain(colour);
    }
  });

  it("puts a way past the header first, for a keyboard visitor", () => {
    const first = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/.exec(page);
    expect(first?.[1] ?? "").toMatch(/\shref="#main"/);
    expect(first?.[2] ?? "").toContain("Skip to content");
    expect(ids).toContain("main");
  });
});

describe("the page has one shape to read", () => {
  it("has exactly one first-level heading", () => {
    expect(headings.filter(([level]) => level === 1).length).toBe(1);
  });

  it("never skips a heading level, so the outline reads top to bottom", () => {
    // A jump from h2 to h4 tells a screen reader it has missed a whole section.
    // The first heading is the h1, and every level after it is its predecessor or
    // one deeper.
    const levels = headings.map(([level]) => level);
    expect(levels[0]).toBe(1);
    for (const [index, level] of levels.entries()) {
      expect(level - (levels[index - 1] ?? level)).toBeLessThanOrEqual(1);
    }
  });

  it("states each question as a heading, so the FAQ has an outline of its own", () => {
    const questions = [...page.matchAll(/<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/g)].map(
      (match) => match[1] ?? "",
    );
    expect(questions.length).toBeGreaterThan(0);
    for (const question of questions) {
      expect(question).toMatch(/<h3\b/);
    }
  });
});

describe("the page asks for one thing", () => {
  it("offers no control other than a link, so there is no second path in", () => {
    // A form, a button, or an input would be a second way to act, and each would
    // need its own validation, loading, empty, and error behaviour — none of
    // which a document with no runtime can have. If a future slice adds one, the
    // contract it has to meet starts here.
    expect(page).not.toMatch(/<(form|button|input|select|textarea)\b/i);
  });

  it("sends every link that leaves for the app to the same sign-in", () => {
    const offPage = authoredLinks.filter((link) => !link.href.startsWith("#"));
    const toApp = offPage.filter((link) => link.href.includes(APP_ORIGIN_TOKEN));
    expect(toApp.length).toBeGreaterThan(0);
    for (const link of toApp) {
      expect(link.href).toBe(SIGN_IN);
    }
  });

  it("makes one call to action the dominant one, and repeats it rather than adding to it", () => {
    // The hero and the close are the same control pointed at the same place. A
    // second, different call to action is what "no competing path" rules out, so
    // the count of primary treatments is pinned rather than left to a reviewer.
    const primary = authoredLinks.filter((link) => link.className.split(/\s+/).includes("cta"));
    expect(primary.map((link) => link.text)).toEqual([
      "Continue with Google",
      "Continue with Google",
    ]);
    for (const link of primary) {
      expect(link.href).toBe(SIGN_IN);
    }
  });

  it("keeps every marketing surface on the apex, and crosses to the app for nothing else", () => {
    for (const [text, path] of Object.entries(APEX_SURFACES)) {
      const hrefs = authoredLinks.filter((link) => link.text === text).map((link) => link.href);
      expect(hrefs.length).toBeGreaterThan(0);
      for (const href of hrefs) {
        expect(href).toBe(`${APEX_ORIGIN_TOKEN}${path}`);
      }
    }
  });

  it("addresses an origin in full for everything off this page", () => {
    const offPage = links.filter((link) => !link.href.startsWith("#")).map((link) => link.href);
    expect(offPage.length).toBeGreaterThan(0);
    for (const href of offPage) {
      expect([APEX_ORIGIN, APP_ORIGIN].some((origin) => href.startsWith(`${origin}/`))).toBe(true);
    }
  });

  it("jumps to a section that is actually in the document", () => {
    const jumps = links.filter((link) => link.href.startsWith("#"));
    expect(jumps.map((link) => link.href)).toEqual([
      "#main",
      "#top",
      "#circles",
      "#features",
      "#ai",
      "#how-it-works",
      "#faq",
    ]);
    for (const jump of jumps) {
      expect(ids).toContain(jump.href.slice(1));
    }
  });
});

describe("the page describes itself to a crawler and to a share preview", () => {
  /** The content of the first `meta` tag carrying `name` (or `property`) `key`. */
  const meta = (key: string) => metaContentOf(page, key);

  it("carries a title and a description, which are the only two things a result shows", () => {
    expect(/<title>[^<]+<\/title>/.test(page)).toBe(true);
    expect(meta("description")).toBeDefined();
  });

  it("says the same thing in both card formats, so the two cannot drift", () => {
    const description = meta("description");
    expect(meta("og:description")).toBe(description);
    expect(meta("twitter:description")).toBe(description);
    const title = /<title>([^<]+)<\/title>/.exec(page)?.[1];
    expect(meta("og:title")).toBe(title);
    expect(meta("twitter:title")).toBe(title);
  });

  it("asks for a large card, which is the only size worth rendering", () => {
    // `summary` renders a thumbnail beside the text on a phone timeline; a
    // summary_large_image is the layout that actually shows the card.
    expect(meta("twitter:card")).toBe("summary_large_image");
  });

  it("describes its own share image, so it is not an unlabelled rectangle", () => {
    for (const key of ["og:image:alt", "twitter:image:alt"]) {
      expect(meta(key), key).toBeTruthy();
    }
    expect(meta("og:image")).toBe(meta("twitter:image"));
  });

  it("points both the canonical link and the card at the apex, absolutely", () => {
    expect(page).toContain(`<link rel="canonical" href="${APEX_ORIGIN}/"`);
    expect(meta("og:url")).toBe(`${APEX_ORIGIN}/`);
  });
});
