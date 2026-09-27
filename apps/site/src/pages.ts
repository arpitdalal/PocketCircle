import { join } from "node:path";
import { collectFiles } from "@pocketcircle/dev-tools/repo-walk";

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
 * The one directory this walk needs beyond the shared skip list: `public` is copied
 * verbatim into the output, so an HTML file in it is a served asset rather than a
 * page of the Site. `dist`, `node_modules`, and `coverage` are already in
 * `@pocketcircle/dev-tools/repo-walk`'s list, which is the point of using it — a
 * second skip list here is a second thing to forget when a generated directory
 * appears.
 */
const PAGE_WALK = { skipDirectories: ["public"], skipDotDirectories: true } as const;

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

/**
 * Every authored page, as a path relative to the package root, sorted.
 *
 * The shared walk descends only into directories that can hold a page rather than
 * reading the whole tree and filtering afterwards. That is not a micro-optimisation:
 * `readdirSync` with `recursive: true` walks `node_modules` and `dist` in full
 * before a filter sees them, and this list is read by the build, by
 * `assert-site-html.mjs`, and by three test files.
 */
export function sitePageFiles() {
  return collectFiles(packageRoot, (fileName) => fileName.endsWith(".html"), PAGE_WALK);
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
