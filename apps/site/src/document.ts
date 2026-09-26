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

/**
 * The text of a fragment of markup, with every tag removed and every run of
 * whitespace collapsed to one space.
 *
 * A `<br>` becomes a space rather than nothing, which is what makes an assertion
 * about a heading's copy survive a line break being introduced into it — the copy
 * of "Track the money you share, together" is the same copy whether or not the
 * author wrote the break.
 */
export function textOf(markup: string) {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Every opening tag in a document, whatever it is called, as the raw text written. */
export function elementsOf(html: string) {
  return [...html.matchAll(/<[a-z][^>]*>/g)].map(([tag]) => tag);
}

/** Every opening tag named `name` in a document, as the raw text written. */
export function tagsOf(html: string, name: string) {
  return elementsOf(html).filter((tag) => new RegExp(`^<${name}\\b`).test(tag));
}

/**
 * An attribute's value on a raw tag, in whatever order and quote style it was
 * written in.
 *
 * By name, never by position: a check that demanded `rel` before `href` would
 * fail a document that means the same thing, and nothing else in this repo is
 * allowed to depend on the order a serializer happened to emit.
 */
export function attributeOf(tag: string, name: string) {
  return new RegExp(`\\s${name}=["']([^"']*)["']`).exec(tag)?.[1];
}

/**
 * Every anchor in a document, in document order, as its `href`, its `class`, and
 * the text a visitor would read inside it.
 *
 * Both quote styles are accepted: an `href` written with single quotes is still
 * an `href`, and a check that cannot see it would pass by not looking.
 */
export function anchorsOf(html: string) {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/g)].map((match) => ({
    href: attributeOf(match[1] ?? "", "href") ?? "",
    className: attributeOf(match[1] ?? "", "class") ?? "",
    text: textOf(match[2] ?? ""),
  }));
}

/**
 * Every heading in a document, in document order, as `[level, text]`.
 *
 * `as const` on the pair because `map` would otherwise infer `Array<string |
 * number>` and every caller would have to narrow before it could do arithmetic
 * on the level.
 */
export function headingsOf(html: string) {
  return [...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h[1-6]\s*>/g)].map(
    (match) => [Number(match[1]), textOf(match[2] ?? "")] as const,
  );
}

/**
 * The `content` of the first `meta` tag carrying `name` (or `property`) `key`, or
 * `undefined` when the document does not carry it at all.
 */
export function metaContentOf(html: string, key: string) {
  const tag = tagsOf(html, "meta").find(
    (candidate) =>
      attributeOf(candidate, "name") === key || attributeOf(candidate, "property") === key,
  );
  return attributeOf(tag ?? "", "content");
}
