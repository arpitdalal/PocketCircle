// @vitest-environment node

/**
 * Repo guard for the shared brand tokens (#405). `tokens.css` is the only place
 * a brand token is written down; every surface stylesheet imports it. This test
 * fails the build the moment a stylesheet redefines one of those tokens or
 * forgets the import, so the product SPA and the marketing Site cannot drift.
 *
 * It lives beside the tokens it guards and walks the repo through
 * `@pocketcircle/dev-tools/repo-walk` — the same walk `canonical-origins.test.ts`
 * uses, so the list of surfaces is whatever the tree contains and adding one
 * cannot opt out of the guard by not being listed here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collectRepoFiles, repoPath } from "@pocketcircle/dev-tools/repo-walk";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "../../..");
const TOKENS_FILE = "packages/brand/src/tokens.css";

/** Bare specifier the consumers import; also the package's export subpath. */
const TOKENS_IMPORT = "@pocketcircle/brand/tokens.css";

/** `--token:` and `--token :`, the only way a stylesheet defines one. */
const CUSTOM_PROPERTY = /^\s*(--[\w-]+)\s*:/gm;

function definedCustomProperties(css: string) {
  return [...css.matchAll(CUSTOM_PROPERTY)].map((match) => match[1] ?? "");
}

const readRepoFile = (path: string) => readFileSync(join(repoRoot, path), "utf8");

const stylesheets = collectRepoFiles(repoRoot, (fileName) => fileName.endsWith(".css"));
const surfaceStylesheets = stylesheets.filter((file) => repoPath(repoRoot, file) !== TOKENS_FILE);

describe("brand tokens are written down exactly once", () => {
  it("reads the whole repo, so the guard cannot pass by scanning nothing", () => {
    const found = stylesheets.map((file) => repoPath(repoRoot, file));
    expect(found).toContain(TOKENS_FILE);
    // A sentinel on both sides of the tree, so a moved repo root or a renamed
    // stylesheet fails loudly instead of going vacuous.
    expect(found).toContain("apps/web-app/app/app.css");
    expect(found).toContain("apps/site/src/site.css");
  });

  it("re-exports the palette as Tailwind theme colors", () => {
    // `@theme inline` is what turns the `:root` palette into `bg-background` and
    // friends. A token that is defined but never mapped is invisible to every
    // stylesheet, which reads as a styling bug rather than a missing mapping.
    const [palette, theme] = readRepoFile(TOKENS_FILE).split("@theme inline");
    expect(theme).toBeDefined();
    for (const token of definedCustomProperties(palette ?? "")) {
      expect(theme, token).toContain(`: var(${token});`);
    }
  });

  it("no stylesheet redefines a brand token", () => {
    const tokens = definedCustomProperties(readRepoFile(TOKENS_FILE));
    const violations: string[] = [];
    for (const file of surfaceStylesheets) {
      for (const property of definedCustomProperties(readFileSync(file, "utf8"))) {
        if (tokens.includes(property)) {
          violations.push(`${repoPath(repoRoot, file)}: redefines ${property}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("every surface stylesheet imports the shared tokens", () => {
    expect(surfaceStylesheets.map((file) => repoPath(repoRoot, file))).not.toEqual([]);
    for (const file of surfaceStylesheets) {
      expect(readFileSync(file, "utf8"), repoPath(repoRoot, file)).toContain(
        `@import "${TOKENS_IMPORT}"`,
      );
    }
  });
});
