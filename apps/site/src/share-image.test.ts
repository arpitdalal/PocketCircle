// @vitest-environment node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { metaContentOf } from "./document.js";
import { renderShareImage, SHARE_IMAGE, shareImagePlugin } from "./share-image.js";

/**
 * The share image (#407). Open Graph and Twitter both fetch `og:image` and both
 * need a raster, so the card is authored as SVG and rasterised here — and the
 * one thing that can go wrong silently is the raster coming out at the wrong size
 * or the wrong format, which still builds green and still fails on every network
 * that renders cards strictly. The published copy in `dist/` is asserted again by
 * `scripts/assert-site-html.mjs`; this asserts the thing that produced it.
 */
const packageRoot = join(import.meta.dirname, "..");

/** Renders the card once for the whole file: it is a raster, and it is not free. */
const rendered = await mkdtemp(join(tmpdir(), "pocketcircle-share-image-"));

afterAll(() => rm(rendered, { recursive: true, force: true }));

describe("the share image", () => {
  it("is rasterised at the size both networks expect, and as a PNG", async () => {
    const written = await renderShareImage(join(packageRoot, "assets"), rendered);
    expect(written).toBe(join(rendered, SHARE_IMAGE.published));
    const metadata = await sharp(written).metadata();
    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(SHARE_IMAGE.width);
    expect(metadata.height).toBe(SHARE_IMAGE.height);
    // `metadata()` reads the header only, so a raster cut short part way through
    // its image data would pass everything above. Decoding it is the check that
    // the whole file is a picture.
    await expect(sharp(written).raw().toBuffer()).resolves.toHaveLength(
      SHARE_IMAGE.width * SHARE_IMAGE.height * 4,
    );
  });

  it("is authored at the size it is published at, so the source cannot drift from it", async () => {
    // The raster is resized to the declared size whatever the source says, which
    // would quietly crop a card authored at a different aspect ratio. The source
    // therefore has to agree with the constant, and this is what says so.
    const svg = await readFile(join(packageRoot, "assets", SHARE_IMAGE.source), "utf8");
    expect(svg).toMatch(new RegExp(`width="${SHARE_IMAGE.width}"`));
    expect(svg).toMatch(new RegExp(`height="${SHARE_IMAGE.height}"`));
  });

  it("is not published as a file of its own, only as the raster it produces", async () => {
    // `public/` is copied verbatim into `dist/`. The source lives in `assets/`
    // precisely so the Site does not serve a second, unreferenced copy of the
    // artwork next to the one every crawler reads.
    await expect(
      readFile(join(packageRoot, "public", SHARE_IMAGE.source), "utf8"),
    ).rejects.toThrow();
  });

  it("is the file the page's cards name, at the size it says it is", async () => {
    const html = await readFile(join(packageRoot, "index.html"), "utf8");
    const meta = (property: string) => metaContentOf(html, property);
    expect(meta("og:image")).toBe(`%APEX_ORIGIN%/${SHARE_IMAGE.published}`);
    expect(meta("og:image:type")).toBe("image/png");
    expect(meta("og:image:width")).toBe(String(SHARE_IMAGE.width));
    expect(meta("og:image:height")).toBe(String(SHARE_IMAGE.height));
  });

  it("is rendered by the build, and only by the build", () => {
    // `apply: "build"` is what keeps the rasteriser out of the dev server: a
    // change to the card is picked up by rebuilding, and `pnpm dev` never pays
    // for a PNG it is not serving.
    const plugin = shareImagePlugin();
    expect(plugin.apply).toBe("build");
    expect(plugin.closeBundle).toBeTypeOf("function");
    expect(plugin.enforce).toBeUndefined();
  });
});
