// @vitest-environment node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COLOR_PALETTE, PERSONAL_CIRCLE_COLOR_HEX } from "@pocketcircle/domain";
import { describe, expect, it } from "vitest";

/**
 * Every colour pairing the marketing page puts text on, measured against the
 * shared brand tokens it is built from.
 *
 * This exists because of a bug it would have caught. The call to action's label
 * was changed from the product's near-white to ink, and its hover state was left
 * fading the surface toward the page — which, with an ink label, means fading it
 * toward its own text. The pair went from 5.16:1 to 4.01:1, and every other gate
 * stayed green because nothing in the build was measuring anything. A comment
 * claiming a number is not a gate; this is.
 *
 * So the numbers below are *not* written down. They are computed here from the
 * token definitions, every time a token or a pairing changes — which turns the
 * class of bug, "a text colour on a background the page actually uses fell below
 * its floor", into a build failure rather than something found by reading a diff.
 * Each row names the floor that applies to it and why.
 *
 * The colour maths lives in this file rather than in a shared module because this
 * is its only consumer. If the product ever wants the same gate it should move
 * there with a reason to exist, rather than be published ahead of one.
 *
 * What this catches, demonstrated rather than asserted: fading the call to
 * action's hover back toward the page fails it, and so does composing a colour
 * the table has no row for. What it does not catch: a body-sized use of a token
 * whose row claims the large-text floor, because the stylesheet does not record
 * which text is body-sized and a parser that did would be more machinery than the
 * problem is worth. The two rows at the large floor say why they are there —
 * 24px and up, and a decorative graphic — so that is a question a reviewer asks,
 * not one the build can answer.
 */

const tokensCss = readFileSync(
  join(import.meta.dirname, "../../../packages/brand/src/tokens.css"),
  "utf8",
);

/** The stylesheet, with its comments out — prose about a colour is not a colour. */
const siteCss = readFileSync(join(import.meta.dirname, "site.css"), "utf8").replace(
  /\*[\s\S]*?\*\//g,
  " ",
);

/** The document, with its comments out, for the same reason. */
const pageCss = readFileSync(join(import.meta.dirname, "../index.html"), "utf8").replace(
  /<!--[\s\S]*?-->/g,
  " ",
);

/**
 * The share card's source artwork, which is rasterised to `og.png` and shipped to
 * every platform that renders a link preview.
 *
 * Read here because it is typography the product publishes and nothing else was
 * measuring it: `share-image.test.ts` asserted the card's size and format, never
 * the contrast of the words on it. Its colours are literals in an SVG rather than
 * tokens, so neither the token coverage test nor the mix test could see them
 * either — which is why a colour on this card could be wrong with the whole file
 * green.
 */
const shareArtwork = readFileSync(join(import.meta.dirname, "../assets/og.svg"), "utf8").replace(
  /<!--[\s\S]*?-->/g,
  " ",
);

/**
 * Every `color-mix(in oklab, A w%, B)` the stylesheet composes — where `B` is a
 * token or `transparent`.
 *
 * The mixes have to come from here rather than from a number written next to a
 * table row, because a restated number is a second source of truth: the row can
 * pass while the stylesheet it claims to describe says something else. That is
 * not hypothetical — the first version of this test had the call to action's
 * hover weight written down twice and did not notice when the two disagreed.
 *
 * `transparent` counts because the tagline's reveal mixes a token with it, and
 * that mix is the only place on the page where a colour exists solely inside a
 * `@keyframes` block. Reading only token-to-token mixes would miss it, and a
 * colour that appears only at runtime is exactly the kind nothing else measures.
 */
const COMPOSED_MIXES = [
  ...siteCss.matchAll(
    /color-mix\(in oklab,\s*var\(--([\w-]+)\)\s+(\d+)%,\s*(?:var\(--([\w-]+)\)|transparent)\)/g,
  ),
].map((match) => ({
  a: match[1] ?? "",
  weight: Number(match[2]),
  /** `null` for `transparent`, which is how a mix becomes an alpha. */
  b: match[3] === undefined ? null : match[3],
}));

/** An OKLCh colour, in the three axes the maths below actually needs. */
type Oklch = { readonly l: number; readonly a: number; readonly b: number; readonly alpha: number };

/**
 * The `:root` block, by brace matching.
 *
 * The file defines the palette twice — once in `:root` and once in `.light`, a
 * future theme that nothing applies. Taking every match in the file silently
 * measured the *light* values, because they are written last, which is a gate
 * that looks like it is measuring the page and is not. Only the dark palette is
 * live: `color-scheme: dark` comes from these tokens and nothing sets `.light`.
 */
function rootBlock(css: string) {
  const start = css.indexOf(":root");
  if (start === -1) {
    throw new Error("tokens.css has no :root palette to measure against");
  }
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === "{") {
      depth += 1;
      continue;
    }
    if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return css.slice(open + 1, index);
      }
    }
  }
  throw new Error("tokens.css has an unterminated :root block");
}

/** Every `--token: oklch(L C H / A)` in the live palette, with H on the a/b axes. */
const TOKENS = new Map(
  [
    ...rootBlock(tokensCss).matchAll(
      /--([\w-]+):\s*oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+)%)?\s*\)/g,
    ),
  ].map((match) => {
    const hue = (Number(match[4]) * Math.PI) / 180;
    const chroma = Number(match[3]);
    return [
      match[1] ?? "",
      {
        l: Number(match[2]),
        a: chroma * Math.cos(hue),
        b: chroma * Math.sin(hue),
        alpha: match[5] === undefined ? 1 : Number(match[5]) / 100,
      },
    ] as const;
  }),
);

/** A token, or a plain OKLCh colour the caller composed. */
type Colour = string | Oklch;

/** The OKLCh a token names. Throws on a typo, rather than measuring black. */
function token(name: string) {
  const found = TOKENS.get(name);
  if (found === undefined) {
    throw new Error(`tokens.css defines no --${name}, so nothing can be measured against it`);
  }
  return found;
}

/**
 * `color-mix(in oklab, A w%, B)` — the shape the hero heading's fade, the call to
 * action's hover, and the tagline's reveal are all written in, so it has to be the
 * shape measured. Mixing with `transparent` keeps A's hue and gives A's weight as
 * alpha, which is then composited by `paint` the way a browser would.
 */
function mix(weightOfA: number, a: Colour, b: Colour | null) {
  const from = (colour: Colour) => (typeof colour === "string" ? token(colour) : colour);
  const first = from(a);
  if (b === null) {
    return { ...first, alpha: first.alpha * weightOfA };
  }
  const second = from(b);
  return {
    l: first.l * weightOfA + second.l * (1 - weightOfA),
    a: first.a * weightOfA + second.a * (1 - weightOfA),
    b: first.b * weightOfA + second.b * (1 - weightOfA),
    alpha: 1,
  };
}

/** sRGB in 0..1, from OKLab. */
function toSrgb({ l, a, b }: Oklch) {
  const cube = (x: number) => x ** 3;
  const [lr, lg, lb] = [
    cube(l + 0.3963377774 * a + 0.2158037573 * b),
    cube(l - 0.1055613458 * a - 0.0638541728 * b),
    cube(l - 0.0894841775 * a - 1.291485548 * b),
  ];
  const channel = (x: number) => {
    const encoded = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.max(x, 0) ** (1 / 2.4) - 0.055;
    return Math.min(1, Math.max(0, encoded));
  };
  // `as const` rather than an explicit return type: inference gives a tuple here
  // and `number[]` without it, and the tuple is what every caller destructures.
  return [
    channel(4.0767416621 * lr - 3.3077115913 * lg + 0.2309699292 * lb),
    channel(-1.2684380046 * lr + 2.6097574011 * lg - 0.3413193965 * lb),
    channel(-0.0041960863 * lr - 0.7034186147 * lg + 1.707614701 * lb),
  ] as const;
}

/**
 * The mix the stylesheet declares, by its own numbers, or a throw.
 *
 * Called as `composed("primary", "foreground")` — the weight comes from the
 * stylesheet, so a pair in the table below can never quietly measure a different
 * blend from the one the page paints. A `null` second colour is `transparent`,
 * which is how the tagline's reveal is written.
 */
function composed(a: string, b: string | null) {
  const found = COMPOSED_MIXES.find((mix) => mix.a === a && mix.b === b);
  if (found === undefined) {
    throw new Error(
      `site.css composes no color-mix of --${a} over ${b === null ? "transparent" : `--${b}`}, so no pair can measure it`,
    );
  }
  return mix(found.weight / 100, a, b);
}

/**
 * `#rgb`, `#rrggbb`, `#rrggbbaa` as the OKLab colour the maths above already
 * understands — the inverse of `toSrgb`, for the colours this page and the share
 * card write as literals rather than as tokens.
 *
 * A literal is a legitimate way to paint the share card: it is artwork, not a
 * theme. The problem was never the literal, it was that a literal was invisible
 * to this file, so a colour could be added to either artefact, painted on text,
 * and be measured by nothing at all. Alpha is preserved because `#rrggbbaa` is how
 * the Circle marks' washes are written.
 */
function fromHex(hex: string) {
  const digits = hex.replace("#", "");
  const wide =
    digits.length === 3 || digits.length === 4
      ? [...digits].map((digit) => digit + digit).join("")
      : digits;
  const channel = (index: number) => Number.parseInt(wide.slice(index, index + 2), 16) / 255;
  const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [lr, lg, lb] = [linear(channel(0)), linear(channel(2)), linear(channel(4))];
  // Linear sRGB to LMS, cube root, then LMS to OKLab. Both matrix steps are the
  // transform; dropping the first returns plausible nonsense rather than an
  // error, which is what the round-trip below is here to catch.
  const [l, m, s] = [
    Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb),
    Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb),
    Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb),
  ];
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    alpha: wide.length === 8 ? channel(6) : 1,
  } satisfies Oklch;
}

/** A colour's sRGB, with its alpha composited over `over` the way a browser would. */
function paint(colour: Colour, over: Colour) {
  const [r, g, b] = toSrgb(typeof colour === "string" ? token(colour) : colour);
  const behind = toSrgb(typeof over === "string" ? token(over) : over);
  const alpha = typeof colour === "string" ? (token(colour).alpha ?? 1) : colour.alpha;
  return [
    r * alpha + behind[0] * (1 - alpha),
    g * alpha + behind[1] * (1 - alpha),
    b * alpha + behind[2] * (1 - alpha),
  ] as const;
}

/** The WCAG 2.x contrast ratio between two painted colours. */
function contrast(a: readonly [number, number, number], b: readonly [number, number, number]) {
  const luminance = ([r, g, bl]: readonly [number, number, number]) => {
    const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(bl);
  };
  const ratio = (
    one: readonly [number, number, number],
    other: readonly [number, number, number],
  ) => {
    const high = Math.max(luminance(one), luminance(other));
    const low = Math.min(luminance(one), luminance(other));
    return (high + 0.05) / (low + 0.05);
  };
  return ratio(a, b);
}

const page = paint("background", "background");
const card = paint("card", "background");

/** WCAG 1.4.3: 4.5:1 for body text, 3:1 for large text (24px, or 18.66px bold). */
const BODY = 4.5;
const LARGE = 3;

type Pair = {
  readonly what: string;
  /** The composed mixes this row measures, as `a,b`, for the coverage check. */
  readonly mixes?: readonly string[];
  /** Literal colours this row measures as text, for the coverage check. */
  readonly ink?: readonly string[];
  /** Literal colours this row measures as the background behind that text. */
  readonly wash?: readonly string[];
  /** The brand tokens this row measures, so the coverage check needs no second list. */
  readonly colours: readonly string[];
  readonly foreground: readonly [number, number, number];
  readonly background: readonly [number, number, number];
  readonly minimum: number;
  /**
   * Set only where the product's own colour palette is what stops this row
   * clearing `minimum`. Such a row measures and prints the truth and is held at
   * the value it reaches today, because asserting it against a floor it cannot
   * reach would mean either failing the build forever or quietly deleting the
   * check. A ratchet may be exceeded; it exists to make a regression impossible,
   * and it is deleted the moment the underlying colour is fixed.
   */
  readonly ratchet?: number;
};

/**
 * Every pairing the page renders. A colour that reaches a surface and is not
 * named here is a gap in this table rather than a silent pass — which is what
 * the coverage test below exists to catch.
 */
const PAIRS: readonly Pair[] = [
  {
    what: "body text on the page",
    colours: ["foreground", "background"],
    foreground: paint("foreground", "background"),
    background: page,
    minimum: BODY,
  },
  {
    what: "body text on a card",
    colours: ["foreground", "card"],
    foreground: paint("foreground", "background"),
    background: card,
    minimum: BODY,
  },
  {
    what: "muted prose on the page",
    colours: ["muted-foreground", "background"],
    foreground: paint("muted-foreground", "background"),
    background: page,
    minimum: BODY,
  },
  {
    what: "muted prose on a card",
    colours: ["muted-foreground", "card"],
    foreground: paint("muted-foreground", "background"),
    background: card,
    minimum: BODY,
  },
  {
    what: "the Step labels",
    colours: ["primary", "background"],
    foreground: paint("primary", "background"),
    background: page,
    minimum: BODY,
  },
  {
    what: "the call to action's label at rest",
    colours: ["primary", "background"],
    foreground: page,
    background: paint("primary", "background"),
    minimum: BODY,
  },
  {
    what: "the call to action's label on hover, where the accent lifts toward the foreground",
    mixes: ["primary,foreground"],
    colours: ["primary", "foreground", "background"],
    foreground: page,
    background: paint(composed("primary", "foreground"), "background"),
    minimum: BODY,
  },
  {
    what: "the skip link, which inverts the page",
    colours: ["foreground", "background"],
    foreground: page,
    background: paint("foreground", "background"),
    minimum: BODY,
  },
  {
    what: "the Connected chip's label on its iris wash",
    colours: ["foreground", "primary-soft", "card"],
    foreground: paint("foreground", "background"),
    background: paint("primary-soft", "card"),
    minimum: BODY,
  },
  {
    what: "the Pending chip's label on its muted pill",
    colours: ["muted-foreground", "muted"],
    foreground: paint("muted-foreground", "background"),
    background: paint("muted", "background"),
    minimum: BODY,
  },
  {
    what: "an Income amount on a ledger card, set at 14px semibold",
    colours: ["positive", "card"],
    foreground: paint("positive", "background"),
    background: card,
    minimum: BODY,
  },
  {
    what: "the hero heading at the dimmest end of its fade",
    mixes: ["foreground,background"],
    colours: ["foreground", "background"],
    foreground: paint(composed("foreground", "background"), "background"),
    background: page,
    minimum: BODY,
  },
  {
    // The dimmest state the tagline is ever in, which is a colour that exists
    // only inside a `@keyframes` block: a token mixed with `transparent`, read
    // out of the stylesheet like any other mix. Measuring the finished colour
    // instead would pass no matter how far the reveal was dimmed, and a
    // visitor who stops scrolling mid-reveal is looking at *this*.
    what: "the tagline while its reveal is still dimmed, set at 24px and up",
    mixes: ["foreground,transparent"],
    colours: ["foreground", "background"],
    foreground: paint(composed("foreground", null), "background"),
    background: page,
    minimum: LARGE,
  },
  {
    what: "the tagline once its reveal has finished, at the same size",
    colours: ["foreground", "background"],
    foreground: paint("foreground", "background"),
    background: page,
    minimum: LARGE,
  },
  {
    what: "decorative icons and the FAQ chevron, which need only the non-text floor",
    colours: ["faint-foreground", "background"],
    foreground: paint("faint-foreground", "background"),
    background: page,
    minimum: LARGE,
  },
];

/**
 * The Circle marks, discovered from the two artefacts rather than listed here.
 *
 * A mark is a glyph in a Circle's own colour on a wash of that same colour — the
 * treatment `apps/web-app/app/components/circle-mark.tsx` renders, which the
 * marketing page reproduces deliberately so the page depicts the product rather
 * than a flattering version of it. So the colours are read out of the document
 * and the artwork: a table written here would be a second source of truth that
 * goes stale the moment someone paints a sixth Circle, and a stale table is
 * precisely how a colour ends up measured by nothing.
 *
 * On the page a mark is the `background-color`/`color` pair written inline. On
 * the share card a mark is a colour that is both a `<text>` fill and a `<rect>`
 * fill, the rect being the plate the glyph sits on. `<rect>` and not "any shape":
 * the artwork's other shapes are the page's decorative circles and glow, and
 * keying on those swept in the card's iris eyebrow, which shares a colour with
 * them and is not a mark.
 */
const SITE_MARKS = [
  ...new Set(
    [...pageCss.matchAll(/background-color:\s*(#[\da-f]{6})26;\s*color:\s*(#[\da-f]{6})/gi)].map(
      (match) => (match[2] ?? "").toLowerCase(),
    ),
  ),
];

const CARD_GLYPHS = new Set(
  [...shareArtwork.matchAll(/<text\b[^>]*\bfill="(#[^"]+)"/gi)].map((match) =>
    (match[1] ?? "").toLowerCase(),
  ),
);
const CARD_PLATES = new Set(
  [...shareArtwork.matchAll(/<rect\b[^>]*\bfill="(#[^"]+)"/gi)].map((match) =>
    (match[1] ?? "").toLowerCase(),
  ),
);
const CARD_MARKS = [...CARD_GLYPHS].filter((hex) => CARD_PLATES.has(hex));

/**
 * A mark's name, so a row reads as "the blue Circle mark" instead of as a hex.
 *
 * The hex is still what gets measured, and `marketing-home.test.ts` is where these
 * are asserted to *be* palette colours in the first place — naming them here
 * rather than re-deciding membership keeps one owner per fact.
 */
const MARK_NAMES = new Map([
  ...COLOR_PALETTE.map((color) => [color.hex.toLowerCase(), color.name] as const),
  [PERSONAL_CIRCLE_COLOR_HEX.toLowerCase(), "Personal"] as const,
]);
const markName = (glyph: string) => MARK_NAMES.get(glyph) ?? glyph;

/** The share card's own two surfaces, literals in artwork by design. */
const CARD_SURFACE = "#16131e";
const CARD_PAGE = "#0d0b13";

/**
 * A Circle mark row: the glyph on a wash of its own colour, over the surface that
 * artefact actually paints.
 *
 * `ratchet`, not `minimum`, and this is the one place in the file where a
 * knowingly-short row is deliberate. Seven of the twelve colours in
 * `COLOR_PALETTE` fall under 4.5:1 as a 12px glyph on a 15% wash of themselves
 * over `--card`, and three of them — slate, indigo and violet — fall under it with
 * no wash at all, so no amount of tint tuning in this repository reaches them.
 * The marketing page cannot fix that without diverging from the app it is
 * describing, and it must not: a homepage painting Circle marks in colours the
 * product does not offer is lying about the exact thing a visitor is being asked
 * to trust. The colours are the product's, stored on Circles that already exist,
 * and changing them is a product decision this issue does not make.
 *
 * So these rows measure, print, and refuse to get worse. Four of the nine marks
 * these two artefacts ship are under the floor today — the numbers are in the
 * failure messages below, and that count is the thing to argue with. When the
 * palette is fixed, each ratchet below becomes a real `minimum` again.
 */
function mark(what: string, glyph: string, over: Colour, surfaceName: string) {
  return {
    what,
    ink: [glyph],
    wash: [`${glyph}26`],
    colours: [surfaceName],
    foreground: paint(fromHex(glyph), over),
    background: paint(fromHex(`${glyph}26`), over),
    minimum: BODY,
    ratchet: 3.7,
  } satisfies Pair;
}

const MARKS: readonly Pair[] = [
  ...SITE_MARKS.map((glyph) =>
    mark(`the ${markName(glyph)} Circle mark in the ledger`, glyph, "card", "card"),
  ),
  ...CARD_MARKS.map((glyph) =>
    mark(
      `the ${markName(glyph)} Circle mark on the share card`,
      glyph,
      fromHex(CARD_SURFACE),
      "artwork card",
    ),
  ),
  {
    what: "the share card's labels and amounts, set at 12px and up",
    ink: ["#ebeaf2"],
    wash: [CARD_SURFACE],
    colours: ["artwork card"],
    foreground: paint(fromHex("#ebeaf2"), fromHex(CARD_SURFACE)),
    background: paint(fromHex(CARD_SURFACE), fromHex(CARD_PAGE)),
    minimum: BODY,
  },
  {
    what: "the share card's secondary lines, set at 12px",
    ink: ["#9593a4"],
    colours: ["artwork card"],
    foreground: paint(fromHex("#9593a4"), fromHex(CARD_SURFACE)),
    background: paint(fromHex(CARD_SURFACE), fromHex(CARD_PAGE)),
    minimum: BODY,
  },
  {
    what: "the share card's income amount, set at 14px",
    ink: ["#43d59a"],
    colours: ["artwork card"],
    foreground: paint(fromHex("#43d59a"), fromHex(CARD_SURFACE)),
    background: paint(fromHex(CARD_SURFACE), fromHex(CARD_PAGE)),
    minimum: BODY,
  },
  {
    what: "the share card's iris eyebrow, set at 22px",
    ink: ["#9568f3"],
    colours: ["artwork page"],
    foreground: paint(fromHex("#9568f3"), fromHex(CARD_PAGE)),
    background: paint(fromHex(CARD_PAGE), fromHex(CARD_PAGE)),
    minimum: BODY,
  },
];

/**
 * Every literal colour that paints text, and every literal a wash is painted
 * with, across all three artefacts the build publishes.
 *
 * The two coverage tests above find colours by *token name* in a utility class and
 * by *mix* in the stylesheet. Neither can see a hex literal, and this page and
 * this share card are written almost entirely in hex literals — six Circle marks
 * and their washes in the document, the whole card in the artwork. A colour could
 * therefore be added to either, painted on text, and be measured by nothing here.
 *
 * Matched in colour positions rather than as bare hex, because the prose is full
 * of issue references and `(#407)` is not a colour; a bare scan would need a
 * blocklist of them. In the artwork the element decides the role, since a `fill`
 * is text on a `<text>` and a surface or a rule on anything else.
 */
const LITERALS = {
  ink: [
    ...[...`${pageCss} ${siteCss}`.matchAll(/(?:^|[;"'\s])color\s*:\s*#([\da-f]{3,8})\b/gi)].map(
      (match) => `#${(match[1] ?? "").toLowerCase()}`,
    ),
    ...[...shareArtwork.matchAll(/<text\b[^>]*\bfill="(#[\da-f]{3,8})"/gi)].map((match) =>
      (match[1] ?? "").toLowerCase(),
    ),
  ],
  wash: [
    ...[
      ...`${pageCss} ${siteCss}`.matchAll(
        /(?:^|[;"'\s])background(?:-color)?\s*:\s*#([\da-f]{3,8})\b/gi,
      ),
    ].map((match) => `#${(match[1] ?? "").toLowerCase()}`),
  ],
};

/** Every pairing, in one list, so the loops below and the tables above cannot drift. */
const ALL_PAIRS: readonly Pair[] = [...PAIRS, ...MARKS];

/** Every brand token any row measures, derived from the rows themselves. */
const MEASURED = new Set(ALL_PAIRS.flatMap((pair) => pair.colours));

describe("every colour pairing the page renders meets its contrast floor", () => {
  it.each(ALL_PAIRS.map((pair) => [pair.what, pair] as const))("%s", (what, pair) => {
    const ratio = contrast(pair.foreground, pair.background);
    // A ratcheted row prints both numbers on purpose. Reporting it as clearing a
    // floor it does not clear would be the dishonest version of this test, and
    // reporting it as merely advisory would let it rot.
    const floor = pair.ratchet ?? pair.minimum;
    expect(
      ratio,
      `${what} measures ${ratio.toFixed(2)}:1 against a floor of ${floor}:1${
        pair.ratchet === undefined
          ? ""
          : ` — short of the ${pair.minimum}:1 body floor, held at the product palette's own value`
      }`,
    ).toBeGreaterThanOrEqual(floor);
  });

  it("reads the palette it measures, so a renamed token fails loudly", () => {
    // If the regex stopped finding the tokens this would compare one hard-coded
    // value against another and pass forever. A renamed token throws instead.
    expect(() => token("primary")).not.toThrow();
    expect(() => token("a-token-that-does-not-exist")).toThrow(/defines no --/);
  });

  it("converts a literal colour into the same space the tokens are measured in", () => {
    // `fromHex` is a hand-written inverse of `toSrgb`, and every literal row is
    // measured through it. Had the two matrix steps disagreed, those rows would
    // have measured colours nobody ships while still reporting a plausible ratio
    // — a gate that is wrong in a way that looks right. Round-tripped here rather
    // than assumed, which is how the missing LMS step was caught.
    for (const hex of [...SITE_MARKS, ...CARD_MARKS]) {
      const [r, g, b] = toSrgb(fromHex(hex));
      const expected = [1, 3, 5].map((index) =>
        (Number.parseInt(hex.slice(index, index + 2), 16) / 255).toFixed(4),
      );
      expect(
        [r, g, b].map((channel) => channel.toFixed(4)),
        hex,
      ).toEqual(expected);
    }
    expect(fromHex("#00000080").alpha).toBeCloseTo(128 / 255, 5);
  });
});

describe("the pairing table is not quietly out of date", () => {
  it("measures every brand colour the page puts in front of a reader", () => {
    // The failure this guards is the one that already happened, twice: a colour
    // reaches a surface, no row names it, and the table still passes because it
    // is only ever asked about pairs it already knows.
    //
    // Both places a colour can be named, not just the stylesheet. Most of this
    // page's text colours are Tailwind utilities written straight into the
    // document — `text-positive` on an amount, `text-primary` on a step label —
    // so reading the stylesheet alone would have missed most of the page.
    //
    // Matched against the token names rather than a list of colour-ish words, so
    // `text-balance` and `text-pretty` are not mistaken for colours, and a token
    // the brand adds tomorrow is caught the moment something uses it. Comments
    // come out first, because prose about colours would supply false positives.
    const used = new Set(
      [...`${siteCss} ${pageCss}`.matchAll(/\b(?:text|bg)-([a-z][\w-]*)/g)].map((match) =>
        (match[1] ?? "").trim(),
      ),
    );
    // `text-faint` is the alias for `--faint-foreground`; every other utility
    // carries its token name unchanged.
    const aliases: Readonly<Record<string, string>> = { faint: "faint-foreground" };
    const brandColours = [...used]
      .map((name) => aliases[name] ?? name)
      .filter((name) => TOKENS.has(name))
      .sort();

    // The set has to be non-empty for the check below it to mean anything. An
    // empty one is what a key mismatch looks like, and an empty set made every
    // comparison below trivially true — this assertion is here because that is
    // exactly how the check was broken the first time.
    expect(
      brandColours.length,
      "no brand colour was recognised, so nothing is being checked",
    ).toBeGreaterThan(0);
    expect(
      brandColours.filter((name) => !MEASURED.has(name)),
      "a brand colour reaches a reader but is measured by no row above",
    ).toEqual([]);
  });
});

describe("no composed colour escapes the pairing table", () => {
  it("measures every color-mix the stylesheet composes", () => {
    // A mix is a colour the page paints, so it belongs in a row above like any
    // other. Without this a new one could be added, used on text, and never be
    // measured — which is the same gap the token coverage test closes for the
    // tokens themselves.
    const measured = new Set(ALL_PAIRS.flatMap((pair) => pair.mixes ?? []));
    const unmeasured = COMPOSED_MIXES.map(
      (declared) => `${declared.a},${declared.b ?? "transparent"}`,
    ).filter((entry) => !measured.has(entry));
    expect(unmeasured).toEqual([]);
  });
});

describe("no literal colour escapes the pairing table", () => {
  it("measures every hex the page and the share card paint text with", () => {
    const measured = new Set(ALL_PAIRS.flatMap((pair) => pair.ink ?? []));
    const unmeasured = [...new Set(LITERALS.ink)].filter((hex) => !measured.has(hex)).sort();
    expect(
      LITERALS.ink.length,
      "no literal colour was recognised, so nothing is being checked",
    ).toBeGreaterThan(0);
    expect(unmeasured, "a literal paints text but no row above measures it").toEqual([]);
  });

  it("measures every wash a literal glyph is set on", () => {
    const measured = new Set(ALL_PAIRS.flatMap((pair) => pair.wash ?? []));
    const unmeasured = [...new Set(LITERALS.wash)].filter((hex) => !measured.has(hex)).sort();
    expect(
      LITERALS.wash.length,
      "no literal background was recognised, so nothing is being checked",
    ).toBeGreaterThan(0);
    expect(unmeasured, "a literal paints a background no row above measures against").toEqual([]);
  });
});
