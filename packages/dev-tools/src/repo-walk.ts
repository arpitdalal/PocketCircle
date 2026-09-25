import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * One repo walk for the tests that guard repo-wide invariants.
 *
 * `canonical-origins.test.ts` (origins) and `tokens.test.ts` (brand tokens) both
 * need to read the whole tree to prove a fact is written down exactly once. They
 * used to carry their own skip list and path helper, which meant a directory
 * added to one guard was missing from the other and the two drifted. The skip
 * list is the sensitive part: too wide and a guard reads build output or vendored
 * files, too narrow and it walks into `.pnpm-store` or a docs tree and reports
 * files nobody owns.
 *
 * A guard picks the files it cares about with `isSourceFile` and gets
 * repo-relative paths back, so its assertions read the way the repo is laid out.
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

/**
 * Absolute paths of every file under `repoRoot` that `isSourceFile` selects,
 * skipping {@link SKIPPED_DIRECTORIES}. The predicate sees the file name and the
 * repo-relative path together, so a guard can match on either.
 */
export function collectRepoFiles(
  repoRoot: string,
  isSourceFile: (fileName: string, repoRelativePath: string) => boolean,
): string[] {
  const collected: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          walk(path);
        }
        continue;
      }
      if (isSourceFile(entry.name, repoPath(repoRoot, path))) {
        collected.push(path);
      }
    }
  };
  walk(repoRoot);
  return collected;
}
