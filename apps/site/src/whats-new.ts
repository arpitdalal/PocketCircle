import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseChangelog } from "@pocketcircle/domain/changelog";
import type { Plugin } from "vite";

/**
 * The What's New page's release list, generated from the repository's changelog.
 *
 * `whats-new.html` is authored like every other page here, with one hole in it:
 * the releases themselves. They are written down once, in `CHANGELOG.md` at the
 * repository root, and copied into the document at build time. Authoring them as
 * markup instead would be a second copy of the release history that is wrong
 * the moment someone cuts a release and nothing in the build would say so — and
 * unlike the marketing copy, this one changes on every release.
 *
 * The parser is `@pocketcircle/domain/changelog`'s, the same one the in-app archive
 * reads,
 * because these are the same releases rendered twice: the app opens the latest
 * one and records that a User has seen it, and the apex publishes the history to
 * signed-out visitors. One parser is what makes that true rather than coincidental.
 *
 * `<details>` for each version, because it is the platform's own disclosure and
 * this document ships no script (ADR 0035): a script would cost a Worker
 * invocation on every request for a page that is a list. It is the same treatment
 * the homepage's FAQ uses, in the same `faq-item` style, so the release list is
 * not a second visual idea for a disclosure.
 *
 * The page is a reader of the changelog and nothing more: no analytics, no
 * "seen" state, and no Unreleased section — the changelog's own rules decide
 * what ships, and this only draws what they returned.
 */

/** The placeholder the authored page writes where the release list belongs. */
export const RELEASES_TOKEN = "%RELEASES%";

/**
 * The changelog at the repository root, from this module rather than from
 * `src/pages.ts`: `scripts/assert-site-html.mjs` imports this module to read the
 * token below, and plain Node loads it, which resolves a directly-named `.ts`
 * file but not the `.js`-for-`.ts` specifier a sibling import would use.
 */
const CHANGELOG = join(import.meta.dirname, "..", "..", "..", "CHANGELOG.md");

/**
 * The chevron the FAQ draws, repeated per release because a generated region
 * cannot reference markup authored elsewhere. A CSS mask or a sprite would mean
 * a second request for one glyph, and the icon is 40 bytes of path data.
 */
const CHEVRON = `<svg
              class="faq-marker"
              xmlns="http://www.w3.org/2000/svg"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="m9 18 6-6-6-6"></path>
            </svg>`;

/** Escapes text for element content. The changelog is Markdown, not HTML. */
function escapeHtml(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * A changelog bullet, as HTML.
 *
 * The changelog writes `**My Transactions** — find Transactions paid by you…`, and
 * a published page that rendered the asterisks would look broken, so the one
 * inline emphasis the file uses becomes a `<strong>`. Nothing else is interpreted:
 * a `*` or a `_` that is not a pair is text, exactly as it is in the file, and
 * inventing a Markdown subset here would mean the page and the changelog could
 * disagree about what a line says.
 */
function renderItem(item: string) {
  return escapeHtml(item).replaceAll(
    /\*\*(.+?)\*\*/g,
    '<strong class="text-foreground">$1</strong>',
  );
}

function renderCategory(category: { heading: string; items: string[] }) {
  return `<div class="space-y-2">
                <h3 class="text-sm font-medium tracking-[0.14em] text-foreground uppercase">
                  ${escapeHtml(category.heading)}
                </h3>
                <ul class="list-disc space-y-2 pl-5 marker:text-muted-foreground">
                  ${category.items.map((item) => `<li>${renderItem(item)}</li>`).join("\n                  ")}
                </ul>
              </div>`;
}

/**
 * The whole release list, as the markup for one region's worth of the page.
 *
 * The newest version is open, which is what the in-app archive does: the point of
 * the page is the release someone has not read yet, and a list of twelve closed
 * rows answers nothing.
 */
export function renderReleases(markdown: string) {
  const sections = parseChangelog(markdown);

  if (sections.length === 0) {
    return `<p class="text-pretty text-base leading-7 text-muted-foreground">No released updates yet.</p>`;
  }

  return sections
    .map(
      (section, index) => `<details class="faq-item"${index === 0 ? " open" : ""}>
              <summary class="flex cursor-pointer items-start justify-between gap-4 py-5">
                <h2 class="font-display text-lg font-semibold tracking-tight">
                  ${escapeHtml(section.version)}
                  <span class="font-sans text-base font-normal text-muted-foreground">
                    · ${escapeHtml(section.date)}
                  </span>
                </h2>
                ${CHEVRON}
              </summary>
              <div class="space-y-5 pb-6 text-base leading-7 text-muted-foreground">
                ${section.intro
                  .map((paragraph) => `<p class="text-pretty">${escapeHtml(paragraph)}</p>`)
                  .join("\n                ")}
                ${section.categories.map(renderCategory).join("\n                ")}
              </div>
            </details>`,
    )
    .join("\n            ");
}

/** Puts {@link renderReleases} where the authored page leaves room for it. */
export function fillReleases(html: string) {
  const written = html.split(RELEASES_TOKEN).length - 1;
  if (written === 0) {
    return html;
  }
  // Exactly one, because the first occurrence is the one that gets filled: a page
  // that named the placeholder twice — a second region, or once in a comment
  // above it — would have the first replaced and the hole left in the document,
  // and the built page would look complete. Failing here says which page and why,
  // where the alternative is a release list printed inside an HTML comment.
  if (written > 1) {
    throw new Error(
      `a page writes ${RELEASES_TOKEN} ${written} times. Only one of them is the releases region, and it is the first one that would be filled, so exactly one is written — name the placeholder in prose as "the releases placeholder" instead.`,
    );
  }
  const releases = renderReleases(readFileSync(CHANGELOG, "utf8"));
  // A function replacement, because a release note containing `$&` or `$1` is a
  // substitution pattern to `String.replace` and would be spliced into the
  // document instead of printed.
  return html.replace(RELEASES_TOKEN, () => releases);
}

export function whatsNewPlugin(): Plugin {
  return {
    name: "pocketcircle:whats-new",
    transformIndexHtml: fillReleases,
  };
}
