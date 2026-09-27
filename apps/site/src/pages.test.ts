// @vitest-environment node

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { APEX_ORIGIN } from "@pocketcircle/domain/origins";
import { describe, expect, it } from "vitest";
import viteConfig from "../vite.config.js";
import { indexablePagePaths, pagePath, sitePageFiles } from "./pages.js";

/**
 * Which URLs the Site answers, and that they are the ones external material has
 * already published (ADR 0035, #408).
 *
 * The apex is a moving target: it is the product app today, it becomes the
 * marketing Site at the cutover, and after that it is a front door that 302s a
 * product path to the app subdomain. The only fixed point through all three is
 * the *path*, because `/privacy` and `/terms` are on a Google branding
 * application, in a ChatGPT plugin submission, and in a shipped plugin manifest —
 * none of which can be edited quietly, and all of which are why the apex keeps
 * them (issue #408). So this reads those materials and asserts, from them rather
 * than from a list written here, that every apex URL we have published is a path
 * the new apex still answers.
 */

const repoRoot = join(import.meta.dirname, "..", "..", "..");

/**
 * Every text file of the material an external party reads: the submission package
 * a reviewer imports, and the plugin package hosts install. Both are published
 * artifacts, so a URL written in either is a promise to a third party.
 *
 * The two directories rather than a list of files, because a file added to one of
 * them is published without anybody editing a list here, and text files only —
 * the packages carry artwork too, and a URL cannot be hiding in a PNG.
 *
 * Walked here rather than through `@pocketcircle/dev-tools/repo-walk`, whose skip
 * list deliberately excludes `docs` and `plugins` from the repo-wide guards: those
 * guards are about source we own, and this is about text a third party is handed.
 */
function publishedMaterial() {
  return ["docs/submission", "plugins/pocketcircle"].flatMap((directory) =>
    readdirSync(join(repoRoot, directory), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(?:json|md|mdx)$/.test(entry.name))
      .map((entry) => {
        // A recursive `readdir` reports each entry's parent as the path it walked,
        // so the repo-relative one is derived rather than assumed.
        const file = relative(repoRoot, join(entry.parentPath, entry.name)).split(sep).join("/");
        return { file, source: readFileSync(join(repoRoot, file), "utf8") };
      }),
  );
}

const material = publishedMaterial();

/**
 * Every apex path the published material cites, deduplicated and sorted.
 *
 * The bare origin counts as the homepage, and the MCP origin is a different host
 * so it does not match. Everything else — the manifest's four interface URLs, the
 * submission's four, the plugin README's `/connections` — comes along, which is
 * the point: a path cited anywhere in public material is one somebody will type.
 */
const citedApexPaths = [
  ...new Set(
    material.flatMap(({ source }) =>
      // The path is optional, because a manifest's bare `homepage` is the
      // homepage. A closing backtick ends a URL written in Markdown code, and a
      // quote ends one written in prose or in JSON, so both stop the path.
      [...source.matchAll(new RegExp(`${APEX_ORIGIN}(/[^\\s)"'\`]*)?`, "g"))].map(
        (match) => match[1] || "/",
      ),
    ),
  ),
].sort();

/**
 * Every path the product app serves, from its route table.
 *
 * Read rather than listed because the point is the *shape* of the answer: a cited
 * URL is either a page of the marketing Site or a product path that the cutover
 * redirects to the app origin (#411). A list here would be a fourth place to
 * remember to update, and the one that matters is the material, not this file.
 *
 * Only the route table's own segment names are read. A Circle-scoped path is
 * composed from a prefix this does not follow, which is acceptable here because a
 * cited URL that needed composing would fail the assertion below and be added
 * deliberately rather than quietly accepted.
 */
const appRoutePaths = [
  ...new Set(
    [
      ...readFileSync(join(repoRoot, "apps", "web-app", "app", "routes.ts"), "utf8").matchAll(
        /\broute\("([^"]*)"/g,
      ),
    ].map((match) => `/${match[1] ?? ""}`),
  ),
];

describe("the Site publishes the pages the apex is meant to answer", () => {
  it("takes every authored page as a build input, so a document cannot be authored and left unpublished", () => {
    // Vite builds `index.html` and nothing else by default, so a second page in
    // this package is a file the Worker never publishes and a path that 404s —
    // visible only to whoever followed the link.
    expect(viteConfig.input).toEqual(sitePageFiles());
    expect(sitePageFiles()).toContain("index.html");
  });

  it("serves the four documents at the paths they already had, plus the not-found page", () => {
    // The file name is the path because the Worker publishes
    // `assets.html_handling: "auto-trailing-slash"`, which is what serves
    // `privacy.html` for `/privacy`; `wrangler.test.ts` holds that setting. These
    // are the URLs in external submission material, which is the whole reason the
    // apex keeps them (ADR 0035).
    //
    // `404.html` is published like any other page — it is the origin's answer to a
    // path nothing matches, and `not_found_handling: "404-page"` is what serves it
    // there — so `/404` answers it directly as well. Enumerated rather than matched
    // loosely because this list is also the sitemap's, minus that one page
    // (`src/crawl-assets.ts`), and a page that appeared here without appearing there
    // would be a document Google is told about and a crawler cannot place.
    expect(sitePageFiles().map(pagePath)).toEqual([
      // File-name order, so `404.html` leads: the list is the directory read, and the
      // sitemap's is derived from it, so pinning the order here pins both.
      "/404",
      "/",
      "/privacy",
      "/support",
      "/terms",
      "/whats-new",
    ]);
    expect(indexablePagePaths()).not.toContain("/404");
  });

  it("answers every apex URL the published material cites", () => {
    // Both reads have to be finding something, or a filter that stopped matching
    // would pass this by asserting nothing.
    expect(material.map((file) => file.file)).toEqual(
      expect.arrayContaining([
        "docs/submission/pocketcircle/README.md",
        "plugins/pocketcircle/.codex-plugin/plugin.json",
      ]),
    );
    expect(citedApexPaths).toEqual(expect.arrayContaining(["/", "/privacy", "/terms", "/support"]));

    const sitePaths = sitePageFiles().map(pagePath);
    expect(
      citedApexPaths.filter((path) => !sitePaths.includes(path) && !appRoutePaths.includes(path)),
    ).toEqual([]);
  });
});
