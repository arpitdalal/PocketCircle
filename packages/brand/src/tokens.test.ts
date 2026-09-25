// @vitest-environment node

/**
 * Repo guard for the shared brand tokens (#405). `tokens.css` is the only place
 * a brand token is written down; every surface stylesheet imports it. This test
 * fails the build the moment a stylesheet redefines one of those tokens or
 * forgets the import, so the product SPA and the marketing Site cannot drift.
 *
 * It lives beside the tokens it guards (there is no repo-root Vitest project),
 * and walks the repo the way `canonical-origins.test.ts` does — the list of
 * consumers is whatever the tree contains, so adding a surface cannot opt out
 * of the guard by not being listed here.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "../../..");
const TOKENS_FILE = "packages/brand/src/tokens.css";

/** Bare specifier the consumers import; also the package's export subpath. */
const TOKENS_IMPORT = "@pocketcircle/brand/tokens.css";

/** Build output, caches, and vendored trees — never source we own. */
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".react-router",
  ".wrangler",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);

/** `--token:` and `--token :`, the only way a stylesheet defines one. */
const CUSTOM_PROPERTY = /^\s*(--[\w-]+)\s*:/gm;

function repoPath(absolute: string) {
  return relative(repoRoot, absolute).split(sep).join("/");
}

function definedCustomProperties(css: string) {
  return [...css.matchAll(CUSTOM_PROPERTY)].map((match) => match[1] ?? "");
}

function collectStylesheets(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        results.push(...collectStylesheets(join(dir, entry.name)));
      }
      continue;
    }
    if (entry.name.endsWith(".css")) {
      results.push(join(dir, entry.name));
    }
  }
  return results;
}

const stylesheets = collectStylesheets(repoRoot);
const consumerStylesheets = stylesheets.filter((file) => repoPath(file) !== TOKENS_FILE);

describe("brand tokens are written down exactly once", () => {
  it("reads the whole repo, so the guard cannot pass by scanning nothing", () => {
    const found = stylesheets.map(repoPath);
    expect(found).toContain(TOKENS_FILE);
    expect(found).toContain("apps/web-app/app/app.css");
    expect(found).toContain("apps/site/src/site.css");
  });

  it("re-exports the palette as Tailwind theme colors", () => {
    // `@theme inline` is what turns the `:root` palette into `bg-background` and
    // friends. A token that is defined but never mapped is invisible to every
    // stylesheet, which reads as a styling bug rather than a missing mapping.
    const [palette, theme] = readFileSync(join(repoRoot, TOKENS_FILE), "utf8").split(
      "@theme inline",
    );
    expect(theme).toBeDefined();
    for (const token of definedCustomProperties(palette ?? "")) {
      expect(theme, token).toContain(`: var(${token});`);
    }
  });

  it("no stylesheet redefines a brand token", () => {
    const tokens = definedCustomProperties(readFileSync(join(repoRoot, TOKENS_FILE), "utf8"));
    const violations: string[] = [];
    for (const file of consumerStylesheets) {
      for (const property of definedCustomProperties(readFileSync(file, "utf8"))) {
        if (tokens.includes(property)) {
          violations.push(`${repoPath(file)}: redefines ${property}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("every surface stylesheet imports the shared tokens", () => {
    expect(consumerStylesheets.map(repoPath)).not.toEqual([]);
    for (const file of consumerStylesheets) {
      expect(readFileSync(file, "utf8"), repoPath(file)).toContain(`@import "${TOKENS_IMPORT}"`);
    }
  });
});
