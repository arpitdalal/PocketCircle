import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APEX_ORIGIN, APP_ORIGIN } from "@pocketcircle/domain";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { renderWithRouter } from "~/test/convex-react.js";
import { resolveSiteHtml } from "../../../site/src/site-html.js";
import Privacy from "./privacy.js";
import Support from "./support.js";
import Terms from "./terms.js";

/**
 * The two copies of each public document, and the contract that keeps them one
 * document (#408).
 *
 * Privacy, Terms, and Support are published twice on purpose, and only for as long
 * as the cutover takes. The marketing Site owns them at `/privacy`, `/terms`, and
 * `/support` — those are the URLs in external submission material, and Google
 * requires the Privacy and Terms pages to share the branding homepage's domain
 * (ADR 0035) — but the apex is still the product app until #410 hands it over, so
 * removing the app's copies now would 404 a cited URL the day this merged. Both
 * therefore render the same copy, and this is what holds them to it: the Site's
 * pages are transcribed documents, and a transcription with nothing comparing it to
 * the source is a copy that quietly stops being the policy.
 *
 * The comparison is deliberately narrow. It asserts the *copy* — every heading,
 * paragraph, and list item, in order, word for word, with the same links — because
 * that is the part that is a promise to a reader and the part a transcription gets
 * wrong. It asserts nothing about the markup or the styling around it: the two
 * surfaces are different origins with different chrome by design, and a difference
 * there is not drift.
 *
 * What it deliberately does not do is hold the two structures equal forever. When
 * the app's copies go (#411), this file goes with them and the Site's documents
 * become the only ones. What must not happen in the meantime is the copy diverging
 * quietly, which is what the first assertion is for.
 */

const documents: readonly {
  name: string;
  /** The path both origins serve the document on, as the app's route names it. */
  route: string;
  /** The Site's page for the document, at the package root. */
  file: string;
  /** The route the product renders at the same path. */
  Route: () => ReactElement;
}[] = [
  { name: "Privacy Policy", route: "privacy", file: "privacy.html", Route: Privacy },
  { name: "Terms", route: "terms", file: "terms.html", Route: Terms },
  { name: "Support", route: "support", file: "support.html", Route: Support },
];

/**
 * Which origin owns a destination (ADR 0035). The app origin owns sign-in and
 * nothing else, because that is where the session lives; the apex owns every
 * public document. Written as the rule once so both copies are held to it, rather
 * than as each copy's own idea of where its own links go.
 */
const OWNED_BY: Readonly<Record<string, string>> = { "/signin": APP_ORIGIN };

/**
 * The Site's page for a document, as a parsed document rather than a string.
 *
 * Run through the Site's own build transform, so this compares against the copy
 * that origin publishes rather than the placeholders its source writes — those are
 * the build's business, and resolving them here would be a second place to keep
 * them in step. Imported from the sibling package rather than restated, and it is a
 * test-only reach: nothing in the product depends on the marketing Site.
 *
 * A DOM rather than a reader over the source, so the one reader below reads the
 * app's rendered output and the Site's authored markup the same way. Parsing is
 * also what decodes the entities its pages write (`Terms &amp; Conditions`), which
 * is the copy a visitor reads.
 */
function sitePage(file: string) {
  const authored = readFileSync(join(import.meta.dirname, "..", "..", "..", "site", file), "utf8");
  return new DOMParser().parseFromString(resolveSiteHtml(authored), "text/html");
}

/**
 * Both copies of a document, as the article each one renders it in.
 *
 * The absence of an `<article>` throws rather than falling back to a body. A
 * fallback here would be the test's own `document.body`, which after
 * `renderWithRouter` holds the *product's* render — so a Site page that lost its
 * `<article>` would compare the product against itself, and every assertion below
 * would pass while checking nothing.
 */
function bothCopies({ file, Route }: (typeof documents)[number]) {
  const { container } = renderWithRouter(<Route />);
  const product = container.querySelector("article");
  const site = sitePage(file).querySelector("article");
  if (product === null || site === null) {
    throw new Error(
      `a copy of ${file} is not in an <article>: the product's is ${product === null ? "missing" : "there"}, the Site's is ${site === null ? "missing" : "there"}`,
    );
  }
  return { product, site };
}

/**
 * A reader's text, with the runs of whitespace a line break introduces collapsed.
 *
 * `textContent` is the concatenation of text nodes, and a `<br>` is an element, so
 * it contributes nothing: `textContent` reads `a<br>b` as `ab`. The Site's own
 * reader maps a `<br>` to a space for exactly this reason, and the guarantee is
 * this test's to keep — a line break introduced into a sentence must not read as
 * a word joined to the next one, in either direction.
 */
function textOf(element: Element) {
  // A copy rather than the element itself, because a `<br>` is an element and
  // `textContent` is the concatenation of text nodes. Built with `append` so the
  // clone is adopted by a real element and the type is inferred from that, not
  // asserted.
  const copy = element.ownerDocument.createElement("div");
  copy.append(element.cloneNode(true));
  for (const lineBreak of copy.querySelectorAll("br")) {
    lineBreak.replaceWith(" ");
  }
  return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
}

/**
 * A destination reduced to what the two copies can be compared on: a mailbox stays
 * whole, and an http(s) URL becomes its path, because the two deliberately
 * disagree about the origin — the app is about to move to its own subdomain, and
 * the Site is served from `workers.dev` until the cutover. Which origin each one
 * *should* name is asserted separately, below.
 */
function destination(href: string) {
  return href.startsWith("mailto:") ? href : new URL(href, APEX_ORIGIN).pathname;
}

/** The anchors in a document, including the one that is a block of its own. */
function anchorsIn(article: Element) {
  return [...article.querySelectorAll("a")];
}

/**
 * A document's copy, as its blocks in order.
 *
 * A block is a heading, a paragraph, or a list item — and an anchor that is in none
 * of those, because the product renders "Back to sign in" as a bare link in the
 * document's footer. Everything inside a block is that block's text, so an
 * emphasised label or a link inside a sentence is compared as part of the sentence
 * it is in rather than as a block of its own.
 */
function copyOf(article: Element) {
  const candidates = [...article.querySelectorAll("h1, h2, h3, p, li, a")];
  return candidates
    .filter((element) => !candidates.some((other) => other !== element && other.contains(element)))
    .map((element) => ({
      text: textOf(element),
      links: [...(element.tagName === "A" ? [element] : []), ...element.querySelectorAll("a")].map(
        (link) => ({
          text: textOf(link),
          href: destination(link.getAttribute("href") ?? ""),
        }),
      ),
    }));
}

/**
 * The product's own copies stay registered until the cutover (#411).
 *
 * They are the same URLs the marketing Site now serves, and the apex is still this
 * app until the apex handover — so a refactor that dropped one of these four
 * routes would turn a cited `/privacy` into the catch-all splat, which redirects to
 * the root, with every other gate green: the branding assertion only looks for a
 * link, and a link is there whether or not a route answers it. This goes with the
 * rest of the file when the app's copies go.
 */
const appRouteTable = readFileSync(join(import.meta.dirname, "..", "routes.ts"), "utf8");

describe.each(documents)("$name is the same document on both origins", (document_) => {
  it("is an article with one heading and real copy on both sides, so nothing below is vacuous", () => {
    // A reader that found nothing would compare two empty lists and pass, which is
    // the failure mode of every assertion built on a query.
    const { product, site } = bothCopies(document_);

    for (const [surface, article] of [
      ["the product", product],
      ["the marketing Site", site],
    ] as const) {
      expect(article.querySelectorAll("h1"), surface).toHaveLength(1);
      expect(textOf(article.querySelector("h1") ?? article), surface).not.toBe("");
      expect(copyOf(article).length, surface).toBeGreaterThan(10);
    }
  });

  it("parses into the page it was written as, not a repaired one", () => {
    // The comparison above is between a React tree, which is well formed by
    // construction, and a parsed page, which is not. An HTML parser repairs
    // mis-nested markup without reporting it: a stray `</div>`, or a `<div>` inside
    // a `<p>`, moves content out of the article it was written into, and the two
    // sides then hold different documents while every assertion below passes. The
    // skeleton is the shape a repair shows up in.
    const { documentElement, body } = sitePage(document_.file);
    // One page wrapper, whatever else the body holds — the keyboard-only skip link
    // is a sibling of it, not a child, which is what makes it a fixed overlay
    // rather than something the page's own padding moves.
    const wrappers = [...body.children].filter((child) => child.tagName === "DIV");

    expect([...documentElement.children].map((child) => child.tagName)).toEqual(["HEAD", "BODY"]);
    expect(wrappers, "the page has no single wrapper").toHaveLength(1);
    expect([...(wrappers[0]?.children ?? [])].map((child) => child.tagName)).toEqual([
      "HEADER",
      "MAIN",
      "FOOTER",
    ]);
    expect(
      wrappers[0]?.querySelector("main")?.querySelector("article"),
      "the document is not inside the page's main",
    ).not.toBeNull();
  });

  it("says the same thing, in the same order, with the same links", () => {
    const { product, site } = bothCopies(document_);

    expect(copyOf(site)).toEqual(copyOf(product));
  });

  it("is still served by the product, because the apex is still the app", () => {
    expect(appRouteTable).toContain(`route("${document_.route}"`);
  });

  it("names every destination's owning origin, in full, on both origins", () => {
    // The reason the comparison above reduces a link to its path: this is where the
    // origin each copy names is held. A relative href is the failure — it resolves
    // against whichever origin served the page, which is the one thing ADR 0035
    // makes a decision about.
    const { product, site } = bothCopies(document_);

    for (const [surface, article] of [
      ["the product", product],
      ["the marketing Site", site],
    ] as const) {
      for (const link of anchorsIn(article)) {
        const href = link.getAttribute("href") ?? "";
        if (href.startsWith("mailto:")) {
          expect(href, surface).toMatch(/^mailto:\S+@\S+$/);
          continue;
        }
        const path = destination(href);
        expect(href, `${surface} links to ${path}`).toBe(`${OWNED_BY[path] ?? APEX_ORIGIN}${path}`);
      }
    }
  });
});
