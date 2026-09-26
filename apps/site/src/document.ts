/**
 * Reading the marketing document as data.
 *
 * The homepage is checked in as real markup, so something has to read it. Two
 * places do: the unit tests, which assert the contract the document itself has to
 * honour, and `scripts/assert-site-html.mjs`, which asserts the same shape on the
 * built artifact a visitor is actually served. Both are assertions about *text*,
 * not about markup — a heading is "Track the money you share, together" whether
 * or not a line break is written inside it — so the way markup becomes text is
 * written down once here, rather than as two regular expressions that drift until
 * one of them starts matching a `<br>` and reports it as copy.
 *
 * Deliberately small and deliberately not a parser: this reads the shapes the
 * document is written in, and the build fails loudly on a shape it does not
 * recognise, which is the moment a real parser would start being worth its cost.
 */

/** An anchor in a document, with the two things an assertion about it needs. */
export interface DocumentAnchor {
  /** The `href` exactly as written, placeholders and all. */
  readonly href: string;
  /** The `class` exactly as written, or `""`. */
  readonly className: string;
  /** Everything a visitor would read inside it, tags removed, whitespace collapsed. */
  readonly text: string;
}

/**
 * The text of a fragment of markup, with every tag removed and every run of
 * whitespace collapsed to one space.
 *
 * A `<br>` becomes a space rather than nothing, which is what makes an assertion
 * about a heading's copy survive a line break being introduced into it — the copy
 * of "Track the money you share, together" is the same copy whether or not the
 * author wrote the break.
 */
export function textOf(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Every anchor in a document, in document order.
 *
 * Both quote styles are accepted: an `href` written with single quotes is still
 * an `href`, and a check that cannot see it would pass by not looking.
 */
export function anchorsOf(html: string): DocumentAnchor[] {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/g)].map((match) => ({
    href: /\shref=["']([^"']*)["']/.exec(match[1] ?? "")?.[1] ?? "",
    className: /\sclass=["']([^"']*)["']/.exec(match[1] ?? "")?.[1] ?? "",
    text: textOf(match[2] ?? ""),
  }));
}

/** Every heading in a document, in document order, as `[level, text]`. */
export function headingsOf(html: string): [number, string][] {
  return [...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h[1-6]\s*>/g)].map((match) => [
    Number(match[1]),
    textOf(match[2] ?? ""),
  ]);
}

/**
 * The `content` of the first `meta` tag carrying `name` (or `property`) `key`, or
 * `undefined` when the document does not carry it at all.
 *
 * The `meta` tag's own attributes are read by name rather than by position: a gate
 * that demanded `property` before `content` would fail a document that means the
 * same thing, and nothing else in this repo is allowed to depend on the order a
 * serializer happened to emit.
 */
export function metaContentOf(html: string, key: string): string | undefined {
  const tag = [...html.matchAll(/<meta\b[^>]*>/g)]
    .map(([tag]) => tag)
    .find((tag) => new RegExp(`\\s(?:name|property)=["']${key}["']`).test(tag));
  return /\scontent=["']([^"']*)["']/.exec(tag ?? "")?.[1];
}
