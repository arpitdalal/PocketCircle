import { readdirSync } from "node:fs";
import { join } from "node:path";

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
 *   asset rather than a page of the Site.
 */
const NOT_SOURCES = new Set(["coverage", "dist", "node_modules", "public"]);

/**
 * The document the Worker serves for a path that matches no page and no legacy
 * redirect, named for `assets.not_found_handling: "404-page"` (#411).
 *
 * It is an ordinary authored page rather than a file in `public/`, which is what
 * gives it the two things a dead end needs and a copied file cannot have: the
 * origin placeholders resolved, so its way onward names the app origin rather than
 * resolving against whichever host served it, and the same per-page contract the
 * other documents are held to.
 */
export const NOT_FOUND_PAGE = "404.html";

/** Every authored page, as a path relative to the package root, sorted. */
export function sitePageFiles() {
  const found: string[] = [];
  /**
   * Descends only into directories that can hold an authored page, rather than
   * reading the whole tree and filtering afterwards. `readdirSync` with
   * `recursive: true` walks `node_modules` and `dist` in full before the filter
   * sees them, so every call paid for the installed tree — which is why this reads
   * like `dev-tools/repo-walk.ts`, which walks the repo for the origin and token
   * guards the same way and for the same reason.
   */
  const walk = (directory: string) => {
    for (const entry of readdirSync(join(packageRoot, directory), { withFileTypes: true })) {
      const path = directory === "" ? entry.name : `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        // A dotfile directory is the toolchain's or the editor's rather than a
        // source of pages — `.git`, `.vite`, `.wrangler` — and nothing authored is
        // hidden in one.
        if (!NOT_SOURCES.has(entry.name) && !entry.name.startsWith(".")) {
          walk(path);
        }
      } else if (entry.name.endsWith(".html")) {
        found.push(path);
      }
    }
  };
  walk("");
  return found.sort();
}

/**
 * The pages a crawler should be told about: everything published except the
 * not-found document, which answers at no address in particular and exists only for
 * the paths that match nothing.
 */
export function indexablePagePaths() {
  return sitePageFiles()
    .filter((file) => file !== NOT_FOUND_PAGE)
    .map(pagePath);
}

/** The apex path a published page is served on. */
export function pagePath(file: string) {
  const withoutExtension = file.replace(/\.html$/, "");
  return withoutExtension === "index" ? "/" : `/${withoutExtension}`;
}
