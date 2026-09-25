import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_ORIGIN } from "@pocketcircle/domain/origins";
import { describe, expect, it } from "vitest";
import { resolveSiteHtml } from "./site-html.js";

/**
 * The marketing homepage (#406), as a fetch that never runs JavaScript sees it:
 * the checked-in document with the build's values in it. Everything asserted here
 * has to survive to the first byte, so a section the build dropped, a call to
 * action left relative, or a heading that outran its level fails the build rather
 * than a visitor's screen.
 */
const page = resolveSiteHtml(readFileSync(join(import.meta.dirname, "../index.html"), "utf8"));

/** Every heading in document order, as `[level, text]`. */
const headings = [...page.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h[1-6]\s*>/g)].map((match) => [
  Number(match[1]),
  (match[2] ?? "").trim(),
]);

/** Every anchor in the document, as `{ href, text }`, in document order. */
const links = [...page.matchAll(/<a\b[^>]*\shref="([^"]*)"[^>]*>([\s\S]*?)<\/a\s*>/g)].map(
  (match) => ({ href: match[1] ?? "", text: (match[2] ?? "").replace(/<[^>]*>/g, "").trim() }),
);

/** The `id` of every element the document declares. */
const ids = new Set([...page.matchAll(/\sid="([^"]*)"/g)].map((match) => match[1]));

describe("the marketing homepage is a complete static document", () => {
  it("carries every section, in the order the SPA homepage had them", () => {
    expect(headings.map(([, text]) => text)).toEqual([
      "PocketCircle",
      "Circles for every shared life",
      "Stay aligned without the spreadsheet",
      "Record expenses and income",
      "Organize with Categories",
      "See who did what",
      "AI-native, with you in control",
      "Up and running in minutes",
      "Continue with Google",
      "Open a Circle",
      "Invite and record",
      "Start your first Circle",
    ]);
  });

  it("nests its headings without skipping a level", () => {
    expect(headings.map(([level]) => level)).toEqual([1, 2, 2, 3, 3, 3, 2, 2, 3, 3, 3, 2]);
  });

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
});

describe("every link leaves the page the way a visitor expects", () => {
  it("sends both calls to action to the app origin's sign-in, not a marketing-origin path", () => {
    expect(links.filter((link) => link.text === "Continue with Google").map((l) => l.href)).toEqual(
      [`${APP_ORIGIN}/signin`, `${APP_ORIGIN}/signin`],
    );
  });

  it("addresses the app origin in full for everything off this page", () => {
    const offPage = links.filter((link) => !link.href.startsWith("#")).map((link) => link.href);
    expect(offPage.length).toBeGreaterThan(0);
    for (const href of offPage) {
      expect(href.startsWith(`${APP_ORIGIN}/`)).toBe(true);
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
