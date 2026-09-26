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
  /** The Site's page for the document, at the package root. */
  file: string;
  /** The route the product renders at the same path. */
  Route: () => ReactElement;
}[] = [
  { name: "Privacy Policy", file: "privacy.html", Route: Privacy },
  { name: "Terms", file: "terms.html", Route: Terms },
  { name: "Support", file: "support.html", Route: Support },
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

/** Both copies of a document, as the article each one renders it in. */
function bothCopies({ file, Route }: (typeof documents)[number]) {
  const { container } = renderWithRouter(<Route />);
  return {
    product: container.querySelector("article") ?? document.body,
    site: sitePage(file).querySelector("article") ?? document.body,
  };
}

/** A reader's text, with the runs of whitespace a line break introduces collapsed. */
function textOf(element: Element) {
  return (element.textContent ?? "").replace(/\s+/g, " ").trim();
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

describe.each(documents)("$name is the same document on both origins", (document_) => {
  it("is an article with a heading and real copy on both sides, so nothing below is vacuous", () => {
    // A reader that found nothing would compare two empty lists and pass, which is
    // the failure mode of every assertion built on a query.
    const { product, site } = bothCopies(document_);

    expect(product.querySelectorAll("h1")).toHaveLength(1);
    expect(textOf(product.querySelector("h1") ?? document.body)).toBe(
      textOf(site.querySelector("h1") ?? document.body),
    );
    expect(copyOf(site).length).toBeGreaterThan(10);
  });

  it("says the same thing, in the same order, with the same links", () => {
    const { product, site } = bothCopies(document_);

    expect(copyOf(site)).toEqual(copyOf(product));
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
