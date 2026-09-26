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
 * request `/privacy` and redirects `/privacy.html` to `/privacy`. So the two
 * directions below are one rule, written both ways, and the four documents this
 * Site publishes keep the exact URLs they already had on the app origin —
 * `/privacy`, `/terms`, `/support`, `/whats-new` are cited in external
 * submission material (`docs/submission/pocketcircle/README.md`) and Google
 * requires Privacy and Terms to share the branding homepage's domain (ADR 0035).
 */

/** This package's root, which is where its pages are authored. */
export const packageRoot = join(import.meta.dirname, "..");

/**
 * Directories that hold no authored page: the build's own output, the installed
 * dependencies, and a coverage report — which is HTML too, and is written into
 * this package by `vitest --coverage`. Excluded by name rather than by depth, so a
 * page nested in a subdirectory is still found.
 */
const NOT_SOURCES = new Set(["coverage", "dist", "node_modules"]);

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

/** The published page that answers an apex path — {@link pagePath} the other way. */
export function pageFile(path: string) {
  const withoutExtension = path.replace(/^\/+/, "").replace(/\.html$/, "");
  return `${withoutExtension === "" ? "index" : withoutExtension}.html`;
}
