import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";
import type { Plugin } from "vite";

/**
 * The share image the Site publishes for Open Graph and Twitter (#407).
 *
 * A link to the Marketing Site is shared as a link, and both networks render the
 * card from `og:image` — a raster. Nothing on the apex could generate one per
 * request, because ADR 0035 gave this origin static assets and no `main`; so the
 * image is authored and rasterised once, here, at build time.
 *
 * Authoring in SVG and publishing a PNG is the whole point: the card is
 * reviewable in a diff as markup, and the binary that crawlers fetch is derived
 * from it rather than committed beside it. `assert-site-html.mjs` then asserts
 * the published raster really is the size and format declared here, because a
 * raster that silently came out 600x315 still builds green and still fails on
 * every platform that renders cards strictly.
 *
 * The source lives in `assets/`, not in `public/`, because `public/` is copied
 * verbatim into `dist/` and nothing on the page references the SVG. Publishing
 * it would ship a second, unreferenced, unasserted copy of the artwork next to
 * the one every crawler actually reads, and a link-preview service that does try
 * SVG would find it. `favicon.svg` is the opposite case and does live in
 * `public/`, because that one is served on purpose.
 *
 * One honest limitation, because it would be easy to believe otherwise: the card's
 * typeface is resolved by the font stack in the SVG through the build machine's
 * fontconfig, not by the repository. The brand ships woff2 and a rasteriser
 * cannot read a web font from a data URI, and the repo ships no TTF to embed
 * instead, so the same source produces slightly different pixels on a macOS
 * machine and on a CI runner. Everything the gates check — the format, the
 * dimensions, the bytes — is font independent, so none of them can catch a
 * substitution. The layout is therefore authored with slack in it rather than
 * tuned to a particular face: the panel's text column and its right-aligned
 * amounts do not share a line, so a wider fallback face widens the gap instead of
 * colliding.
 *
 * `apply: "build"` keeps `sharp` out of the dev server: a design change to the
 * card is picked up by rebuilding, and `pnpm dev` never pays for a rasteriser.
 */
export const SHARE_IMAGE = {
  /** The authored source, relative to the package's `assets/`. */
  source: "og.svg",
  /** The published raster, relative to the Site root, which is what `og:image` names. */
  published: "og.png",
  /** The size both networks expect a large card to be. */
  width: 1200,
  height: 630,
} as const;

/**
 * Rasterises {@link SHARE_IMAGE} into the build's output directory.
 *
 * The output is forced to the declared size rather than trusted from the SVG, so
 * the size a card is rendered at is one value, written down once. It is a no-op
 * for a correctly authored source and a safety net otherwise — and note that a
 * source authored at a *different aspect ratio* would be cropped rather than
 * letterboxed, which is why `share-image.test.ts` asserts the source and the
 * constant agree instead of relying on this to notice.
 *
 * Throws if the source is missing or unreadable as an image, which fails the
 * build here instead of shipping a homepage whose `og:image` 404s.
 */
export async function renderShareImage(sourceDir: string, outDir: string) {
  const svg = await readFile(join(sourceDir, SHARE_IMAGE.source));
  const png = await sharp(svg)
    .resize(SHARE_IMAGE.width, SHARE_IMAGE.height)
    .png({ compressionLevel: 9 })
    .toBuffer();
  const written = join(outDir, SHARE_IMAGE.published);
  await writeFile(written, png);
  return written;
}

export function shareImagePlugin(): Plugin {
  let siteRoot = "";
  let outDir = "";
  return {
    name: "pocketcircle:share-image",
    apply: "build",
    configResolved(config) {
      siteRoot = config.root;
      outDir = config.build.outDir;
    },
    async closeBundle() {
      // `resolve`, not `join`: Vite hands back `outDir` already resolved against
      // the root, and joining a package root onto an absolute path would put the
      // card somewhere no one serves from.
      await renderShareImage(resolve(siteRoot, "assets"), resolve(siteRoot, outDir));
    },
  };
}
