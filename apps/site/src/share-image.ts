import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import type { Plugin } from "vite";

/**
 * The share image the Site publishes for Open Graph and Twitter (#407).
 *
 * A link to the Marketing Site is shared as a link, and both networks render the
 * card from `og:image` — a raster. Nothing on the apex could generate one per
 * request, because ADR 0035 gave this origin static assets and no `main`; so the
 * image is authored (`public/og.svg`) and rasterised once, here, at build time.
 *
 * Authoring in SVG and publishing a PNG is the whole point: the card is
 * reviewable in a diff as markup, and the binary that crawlers fetch is derived
 * from it rather than committed beside it. `assert-site-html.mjs` then asserts
 * the published raster really is the size and format declared here, because a
 * raster that silently came out 600x315 still builds green and still fails on
 * every platform that renders cards strictly.
 *
 * `apply: "build"` keeps `sharp` out of the dev server: a design change to the
 * card is picked up by rebuilding, and `pnpm dev` never pays for a rasteriser.
 */
export const SHARE_IMAGE = {
  /** The authored source, relative to the package's `public/`. */
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
 * The output is forced to the declared size rather than trusted from the SVG,
 * so the size a card is rendered at is one value, written down once. Throws if
 * the source is missing or unreadable as an image, which fails the build here
 * instead of shipping a homepage whose `og:image` 404s.
 */
export async function renderShareImage(publicDir: string, outDir: string) {
  const svg = await readFile(join(publicDir, SHARE_IMAGE.source));
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
      await renderShareImage(join(siteRoot, "public"), join(siteRoot, outDir));
    },
  };
}
