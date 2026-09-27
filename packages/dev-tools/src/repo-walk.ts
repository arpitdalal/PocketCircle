import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * One directory walk for the tests and builds that read a tree.
 *
 * `canonical-origins.test.ts` (origins) and `tokens.test.ts` (brand tokens) both
 * need to read the whole repo to prove a fact is written down exactly once. They
 * used to carry their own skip list and path helper, which meant a directory
 * added to one guard was missing from the other and the two drifted. The skip
 * list is the sensitive part: too wide and a guard reads build output or vendored
 * files, too narrow and it walks into `.pnpm-store` or a docs tree and reports
 * files nobody owns.
 *
 * `apps/site` reads a tree too, rooted at the *package* rather than the repo, and
 * it used to carry its own walk for the same reason — which is a second skip list
 * waiting to disagree with the first. So there is one walk, here, and the roots
 * differ only in what they return.
 */

/** Build output, caches, vendored trees, and agent/tooling docs — never source we own. */
export const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  ".agents",
  ".auth",
  ".claude",
  ".cursor",
  ".git",
  ".pnpm-store",
  ".react-router",
  ".wrangler",
  "_generated",
  "blob-report",
  "build",
  "coverage",
  "dist",
  "docs",
  "node_modules",
  "playwright-report",
  "test-results",
]);

/** Repo-relative path with forward slashes, so assertions can be written as literals. */
export function repoPath(repoRoot: string, absolutePath: string) {
  return relative(repoRoot, absolutePath).split(sep).join("/");
}

/** How a walk treats directories it does not want to descend into. */
export interface WalkOptions {
  /**
   * Directory names to skip in addition to {@link SKIPPED_DIRECTORIES}.
   *
   * The shared list is repo-wide, and a walk rooted at a *package* can need one
   * more exclusion the repo does not have: `apps/site` copies `public/` into its
   * output verbatim, so an HTML file there is a served asset rather than a source
   * document.
   */
  readonly skipDirectories?: readonly string[];
  /**
   * Whether to skip every dot-prefixed directory, not just the ones named above.
   *
   * {@link SKIPPED_DIRECTORIES} enumerates the dot directories this repo happens to
   * have. A tool can create another at any time, and a walk rooted at a package
   * meets it where the repo-wide list does not name it.
   */
  readonly skipDotDirectories?: boolean;
}

/**
 * Every file under `root` that `isSourceFile` selects, as a path relative to
 * `root`, sorted. The predicate sees the file name and the relative path together.
 *
 * Sort order is the caller's contract as much as this function's: a build input
 * list and an assertion over "the pages this package publishes" both read better
 * when the order is the same every run, and `readdir` does not promise one.
 */
export function collectFiles(
  root: string,
  isSourceFile: (fileName: string, rootRelativePath: string) => boolean,
  options: WalkOptions = {},
): string[] {
  return walk(root, options, isSourceFile, repoPath);
}

/**
 * The same walk, with absolute paths — for a caller that is going to open the
 * files rather than name them in an assertion.
 */
export function collectRepoFiles(
  repoRoot: string,
  isSourceFile: (fileName: string, repoRelativePath: string) => boolean,
  options: WalkOptions = {},
): string[] {
  return walk(repoRoot, options, isSourceFile, (root, path) => path);
}

function walk(
  root: string,
  { skipDirectories = [], skipDotDirectories = false }: WalkOptions,
  isSourceFile: (fileName: string, rootRelativePath: string) => boolean,
  toResult: (root: string, absolutePath: string) => string,
): string[] {
  const skip = new Set([...SKIPPED_DIRECTORIES, ...skipDirectories]);
  const collected: string[] = [];
  const descend = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name) && !(skipDotDirectories && entry.name.startsWith("."))) {
          descend(path);
        }
        continue;
      }
      if (isSourceFile(entry.name, repoPath(root, path))) {
        collected.push(toResult(root, path));
      }
    }
  };
  descend(root);
  return collected.sort();
}
