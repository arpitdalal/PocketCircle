// @vitest-environment node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APEX_ORIGIN } from "@pocketcircle/domain/origins";
import { describe, expect, it } from "vitest";
import viteConfig from "../vite.config.js";
import { pageFile, pagePath, sitePageFiles } from "./pages.js";

/**
 * Which URLs the Site answers, and that they are the ones external material has
 * already published (ADR 0035, #408).
 *
 * The apex is a moving target: it is the product app today, it becomes the
 * marketing Site at the cutover, and after that it is a front door that 302s a
 * product path to the app subdomain. The only fixed point through all three is
 * the *path*, because `/privacy` and `/terms` are on a Google branding
 * application, in a ChatGPT plugin submission, and in a plugin manifest — none of
 * which can be edited quietly, and all of which are why the apex keeps them
 * (issue #408). So this asserts, from the submission material itself rather than
 * from a list written here, that every apex URL we have published is a path the
 * new apex still answers.
 */

const repoRoot = join(import.meta.dirname, "..", "..", "..");

/** The submission material, which is where the published URLs are written down. */
const SUBMISSION = join(repoRoot, "docs", "submission", "pocketcircle", "README.md");

/** The product's route table, which is what the apex redirects a product path to. */
const APP_ROUTES = join(repoRoot, "apps", "web-app", "app", "routes.ts");

const submission = readFileSync(SUBMISSION, "utf8");

/** Every apex path the submission material cites, deduplicated and sorted. */
const citedApexPaths = [
  ...new Set(
    [...submission.matchAll(new RegExp(`${APEX_ORIGIN}(/[^\\s)]*)?`, "g"))].map(
      (match) => match[1] || "/",
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
const appRoutes = readFileSync(APP_ROUTES, "utf8");

const appRoutePaths = [
  ...new Set([
    ...[...appRoutes.matchAll(/\broute\("([^"]*)"/g)].map((match) => `/${match[1] ?? ""}`),
    // The index route of a layout is the layout's own path, and carries no name.
    ...[...appRoutes.matchAll(/\bindex\(\s*\)/g)].map(() => "/"),
  ]),
];

describe("the Site publishes the pages the apex is meant to answer", () => {
  it("takes every authored page as a build input, so a document cannot be authored and left unpublished", () => {
    // Vite builds `index.html` and nothing else by default, so a second page in
    // this package is a file the Worker never publishes and a path that 404s —
    // visible only to whoever followed the link.
    expect(viteConfig.build?.rollupOptions?.input).toEqual(sitePageFiles());
    expect(sitePageFiles()).toContain("index.html");
  });

  it("serves each page at the path its file name implies, in both directions", () => {
    // The Worker publishes `assets.html_handling: "auto-trailing-slash"`, which
    // is what serves `privacy.html` for `/privacy`; `wrangler.test.ts` holds that
    // setting, and this holds the two halves of the mapping agreeing.
    expect(sitePageFiles().map(pagePath)).toEqual([
      "/",
      "/privacy",
      "/support",
      "/terms",
      "/whats-new",
    ]);
    for (const file of sitePageFiles()) {
      expect(pageFile(pagePath(file))).toBe(file);
    }
  });

  it("answers every apex URL the submission material cites", () => {
    // The read has to be finding something, or a regex that stopped matching
    // would pass this by asserting nothing.
    expect(citedApexPaths).toContain("/");
    expect(citedApexPaths).toContain("/privacy");

    const sitePaths = sitePageFiles().map(pagePath);
    expect(
      citedApexPaths.filter((path) => !sitePaths.includes(path) && !appRoutePaths.includes(path)),
    ).toEqual([]);
  });
});
