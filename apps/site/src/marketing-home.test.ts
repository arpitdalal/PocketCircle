import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COLOR_PALETTE, PERSONAL_CIRCLE_COLOR_HEX } from "@pocketcircle/domain";
import { APEX_ORIGIN, APP_ORIGIN } from "@pocketcircle/domain/origins";
import { describe, expect, it } from "vitest";
import { APEX_ORIGIN_TOKEN, APP_ORIGIN_TOKEN, resolveSiteHtml } from "./site-html.js";

/**
 * The marketing homepage (#406). What the *built* artifact must contain is
 * asserted by `scripts/assert-site-html.mjs`; what is asserted here is the
 * contract the document itself has to honour — which origin owns which
 * destination (ADR 0035), a link for every jump, a name on every link, no
 * runtime.
 */
const authored = readFileSync(join(import.meta.dirname, "../index.html"), "utf8");
const page = resolveSiteHtml(authored);

/** Every anchor in a document, as `{ href, text }`, in document order. */
function anchorsOf(html: string) {
  // Either quote style: an href written with single quotes is still an href, and
  // a check that cannot see it would pass by not looking.
  return [...html.matchAll(/<a\b[^>]*\shref=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a\s*>/g)].map(
    (match) => ({
      href: match[1] ?? "",
      text: (match[2] ?? "").replace(/<[^>]*>/g, "").trim(),
    }),
  );
}

const links = anchorsOf(page);

/**
 * The same anchors as authored, placeholders unresolved. The two origins are one
 * string until the ADR 0035 cutover moves the app to its subdomain, so which
 * destination belongs to which is only visible here: after substitution the
 * distinction is gone, and a link silently on the wrong origin would pass every
 * check written against the built document.
 */
const authoredLinks = anchorsOf(authored);

/** The `id` of every element the document declares. */
const ids = new Set([...page.matchAll(/\sid="([^"]*)"/g)].map((match) => match[1]));

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

describe("the marketing homepage is a complete static document", () => {
  it("labels every one of its link groups", () => {
    expect([...page.matchAll(/<nav\s+aria-label="([^"]+)"/g)].map((match) => match[1])).toEqual([
      "Product",
      "Account",
      "Legal",
    ]);
  });

  it("names every link, so it is announced and hit-testable", () => {
    expect(links.filter((link) => link.text.length === 0)).toEqual([]);
  });

  it("ships no runtime to reveal any of it", () => {
    expect(page).not.toMatch(/<script/i);
  });

  it("paints its Circle marks in the app's Circle colours, over the same tint", () => {
    expect(swatches.length).toBeGreaterThan(0);
    for (const [tint, colour] of swatches) {
      expect(tint).toBe(colour);
      expect(CIRCLE_COLOURS).toContain(colour);
    }
  });
});

describe("every link leaves the page the way a visitor expects", () => {
  it("sends both calls to action to the app origin, which is where the session lives", () => {
    const callsToAction = authoredLinks.filter((link) => link.text === "Continue with Google");
    expect(callsToAction.map((link) => link.href)).toEqual([
      `${APP_ORIGIN_TOKEN}/signin`,
      `${APP_ORIGIN_TOKEN}/signin`,
    ]);
  });

  it("keeps every marketing surface on the apex, and crosses to the app for nothing else", () => {
    for (const [text, path] of Object.entries(APEX_SURFACES)) {
      const hrefs = authoredLinks.filter((link) => link.text === text).map((link) => link.href);
      expect(hrefs.length).toBeGreaterThan(0);
      for (const href of hrefs) {
        expect(href).toBe(`${APEX_ORIGIN_TOKEN}${path}`);
      }
    }
    const appOriginLinks = authoredLinks.filter((link) => link.href.includes(APP_ORIGIN_TOKEN));
    expect(appOriginLinks.every((link) => link.href === `${APP_ORIGIN_TOKEN}/signin`)).toBe(true);
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
      "#top",
      "#circles",
      "#features",
      "#ai",
      "#how-it-works",
    ]);
    for (const jump of jumps) {
      expect(ids).toContain(jump.href.slice(1));
    }
  });
});
