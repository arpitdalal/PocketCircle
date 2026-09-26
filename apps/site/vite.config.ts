import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { sitePageFiles } from "./src/pages.js";
import { securityHeadersPlugin } from "./src/security-headers.js";
import { shareImagePlugin } from "./src/share-image.js";
import { siteHtmlPlugin } from "./src/site-html.js";
import { whatsNewPlugin } from "./src/whats-new.js";

export default defineConfig({
  /**
   * Every authored page is an input, taken from the directory rather than listed
   * here. Vite builds `index.html` and nothing else by default, so a second page
   * added to the package would be a file the Worker never published and a path that
   * 404s — visible only to whoever followed the link. `src/pages.ts` owns the list,
   * and `scripts/assert-site-html.mjs` then asserts each of these files is in the
   * output.
   *
   * The top-level `input` rather than `build.rolldownOptions.input`, which is where
   * Vite's own documentation puts a multi-page entry list, and which the dev server
   * reads too — so a page is reachable in `pnpm dev` and in the build for the same
   * reason rather than because Vite happens to find a second `.html` on disk.
   */
  input: sitePageFiles(),
  plugins: [
    tailwindcss(),
    siteHtmlPlugin(),
    whatsNewPlugin(),
    securityHeadersPlugin(),
    shareImagePlugin(),
  ],
});
