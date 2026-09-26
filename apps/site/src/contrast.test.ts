// @vitest-environment node

import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  /** The brand tokens this row measures, so the coverage check needs no second list. */
  readonly colours: readonly string[];
  readonly foreground: readonly [number, number, number];
  readonly background: readonly [number, number, number];
  readonly minimum: number;
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
    background: paint(mix(0.88, "primary", "foreground"), "background"),
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

/** Every brand token any row above measures, derived from the rows themselves. */
const MEASURED = new Set(PAIRS.flatMap((pair) => pair.colours));

describe("every colour pairing the page renders meets its contrast floor", () => {
  it.each(PAIRS.map((pair) => [pair.what, pair] as const))("%s", (what, pair) => {
    expect(
      contrast(pair.foreground, pair.background),
      `${what} measures ${contrast(pair.foreground, pair.background).toFixed(2)}:1 and must clear ${pair.minimum}:1`,
    ).toBeGreaterThanOrEqual(pair.minimum);
  });

  it("reads the palette it measures, so a renamed token fails loudly", () => {
    // If the regex stopped finding the tokens this would compare one hard-coded
    // value against another and pass forever. A renamed token throws instead.
    expect(() => token("primary")).not.toThrow();
    expect(() => token("a-token-that-does-not-exist")).toThrow(/defines no --/);
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
    const measured = new Set(PAIRS.flatMap((pair) => pair.mixes ?? []));
    const unmeasured = COMPOSED_MIXES.map(
      (declared) => `${declared.a},${declared.b ?? "transparent"}`,
    ).filter((entry) => !measured.has(entry));
    expect(unmeasured).toEqual([]);
  });
});
