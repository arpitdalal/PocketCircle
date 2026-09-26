import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * The Site's pages, and the apex path each one answers on.
 *
 * A page is a checked-in `.html` document in this package, and that is the whole
 * list: the build takes every one of them as an input, publishes them, and the
 * Worker answers the matching path. Deriving the list from the directory rather
 * than writing it down is what keeps a page from existing in one place and not the
 * others — a hand-written list is a page that looks deployed and 404s, or an
 * input the rest of the build never checks.
 *
 * Why a file name is the path: the Worker publishes `assets.html_handling:
 * "auto-trailing-slash"` (`wrangler.jsonc`), which serves `privacy.html` for the
 * request `/privacy` and redirects `/privacy.html` to `/privacy`. So the four
 * documents this Site publishes keep the exact URLs they already had on the app
 * origin —
 * `/privacy`, `/terms`, `/support`, `/whats-new` are cited in external
 * submission material (`docs/submission/pocketcircle/README.md`) and Google
 * requires Privacy and Terms to share the branding homepage's domain (ADR 0035).
 */

/** This package's root, which is where its pages are authored. */
export const packageRoot = join(import.meta.dirname, "..");

/**
 * Directories that hold no authored page, excluded by name rather than by depth so
 * a page nested in a subdirectory is still found:
 *
 * - `dist` and `node_modules`: the build's own output and the installed packages.
 * - `coverage`: a coverage report is HTML too, and `vitest --coverage` writes one
 *   into this package.
 * - `public`: copied verbatim into the output, so an HTML file in it is a served
 *   asset rather than a page of the Site — and the cutover adds a `404.html` there
 *   (#411), which is not a document this Site answers at `/404`.
 */
const NOT_SOURCES = new Set(["coverage", "dist", "node_modules", "public"]);

/** Every authored page, as a path relative to the package root, sorted. */
export function sitePageFiles() {
  return readdirSync(packageRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => {
      if (!entry.isFile() || !entry.name.endsWith(".html")) {
        return false;
      }
      // A dotfile directory is the toolchain's or the editor's rather than a
      // source of pages — `.git`, `.vite`, `.wrangler` — and nothing authored is
      // hidden in one.
      return !entry.parentPath
        .split(sep)
        .some((directory) => NOT_SOURCES.has(directory) || directory.startsWith("."));
    })
    .map((entry) => relative(packageRoot, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
}

/** The apex path a published page is served on. */
export function pagePath(file: string) {
  const withoutExtension = file.replace(/\.html$/, "");
  return withoutExtension === "index" ? "/" : `/${withoutExtension}`;
}
