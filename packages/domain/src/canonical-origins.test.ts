// @vitest-environment node

/**
 * Repo guard for the canonical origins (#404). `origins.ts` is the only module
 * allowed to spell out PocketCircle's public origins; this test fails the build
 * the moment another file does, so an origin migration stays a one-line change
 * instead of a hunt across a dozen call sites.
 *
 * It lives beside the module it guards (there is no repo-root Vitest project).
 *
 * Two kinds of file are not fully governed by the scan, and both are handled
 * explicitly rather than skipped:
 *
 * - **The module itself**, which is where the literals live.
 * - **Files that cannot import TypeScript** — wrangler config, GitHub workflows,
 *   the shipped plugin manifests, and the env templates a developer copies.
 *   Each is listed in `ALLOWED_LITERALS` with exactly the origins it may contain,
 *   so a *new* origin appearing in one of them is a violation, not a silent pass.
 *
 * Prose (`*.md`, `docs/`) documents the origins rather than consuming them and is
 * out of scope, as are `*.example` templates *except* the two that set an app
 * origin, which are in the allowance list below.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APEX_HOSTNAME,
  APEX_ORIGIN,
  APP_HOSTNAME,
  APP_ORIGIN,
  LOCAL_APP_ORIGIN,
  MCP_HOSTNAME,
  MCP_ORIGIN,
  MCP_RESOURCE_URI,
} from "./origins.js";

const repoRoot = join(import.meta.dirname, "../../..");

/** Build output, caches, and vendored trees — never source we own. */
const SKIPPED_DIRECTORIES = new Set([
  ".auth",
  ".git",
  ".react-router",
  ".wrangler",
  "_generated",
  "blob-report",
  "build",
  "coverage",
  "docs",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);

const SKIPPED_FILES = new Set([".env.local", "pnpm-lock.yaml"]);

/**
 * The one module allowed to spell the origins out.
 */
const ORIGINS_MODULE = "packages/domain/src/origins.ts";

/**
 * Files that cannot `import` the module, mapped to the exact origins each is
 * allowed to contain. A match outside its file's list fails the build; an entry
 * that no longer appears also fails, so the list cannot rot.
 */
const ALLOWED_LITERALS: Record<string, readonly string[]> = {
  // The product app Worker, once served from the app subdomain (ADR 0035).
  "wrangler.jsonc": [],
  "packages/mcp-worker/wrangler.jsonc": [APP_ORIGIN],
  ".github/workflows/deploy.yml": [APEX_ORIGIN],
  // The backend's SITE_URL has to match the origin Playwright drives the app on.
  ".github/workflows/e2e.yml": [LOCAL_APP_ORIGIN],
  // Shipped plugin manifests: read by ChatGPT/Codex, never executed here.
  "plugins/pocketcircle/.mcp.json": [MCP_ORIGIN],
  "plugins/pocketcircle/.codex-plugin/plugin.json": [APEX_ORIGIN],
  // Env templates a developer copies verbatim.
  ".env.example": [LOCAL_APP_ORIGIN],
  "packages/mcp-worker/.dev.vars.example": [LOCAL_APP_ORIGIN],
};

/** Includes the file types the ADR 0035 marketing Site will add. */
const SOURCE_FILE = /\.(?:[cm]?js|astro|html?|json|jsonc|mdx|sh|ts|tsx|txt|webmanifest|ya?ml)$/;

function escapeForRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function repoPath(absolute: string) {
  return relative(repoRoot, absolute).split(sep).join("/");
}

function readRepoFile(path: string) {
  return readFileSync(join(repoRoot, path), "utf8");
}

/**
 * Every origin this module owns, as patterns. The hostname alternation is built
 * from the constants, so an origin added here is guarded the moment it exists.
 * The lookbehind keeps a different subdomain of the apex (`assets.` for R2
 * media, which this module does not own) from reading as the apex itself, and
 * requiring a scheme keeps a bare hostname out of scope — a wrangler route
 * pattern is a hostname, not an origin, and is asserted separately below.
 */
const OWNED_ORIGIN = new RegExp(
  `(?<![\\w.-])https?://(?:${[APEX_HOSTNAME, APP_HOSTNAME, MCP_HOSTNAME]
    .map(escapeForRegExp)
    .join("|")})(?![\\w-])`,
  "g",
);

const LOCAL_APP_ORIGIN_PATTERN = new RegExp(
  `https?://${escapeForRegExp(LOCAL_APP_ORIGIN.slice("http://".length))}(?![\\d/])`,
  "g",
);

const FORBIDDEN = [
  { label: "a public origin", pattern: OWNED_ORIGIN },
  { label: "the local app origin", pattern: LOCAL_APP_ORIGIN_PATTERN },
];

/** Origins present in `content` that its file is not allowed to contain. */
function unaccountedOrigins(path: string, content: string) {
  const allowed = ALLOWED_LITERALS[path] ?? [];
  const found: string[] = [];
  for (const { pattern, label } of FORBIDDEN) {
    for (const match of content.matchAll(pattern)) {
      if (!allowed.includes(match[0])) {
        found.push(`${label} ${match[0]}`);
      }
    }
  }
  return found;
}

/** Allowance entries that no longer appear, so a stale entry is itself a failure. */
function staleAllowances(path: string, content: string) {
  return (ALLOWED_LITERALS[path] ?? [])
    .filter((literal) => !content.includes(literal))
    .map((literal) => `stale allowance ${literal}`);
}

function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        results.push(...collectSourceFiles(join(dir, entry.name)));
      }
      continue;
    }
    const full = join(dir, entry.name);
    const path = repoPath(full);
    if (path === ORIGINS_MODULE) {
      continue;
    }
    // Templates and untracked env files document the origins rather than consume
    // them — except the ones a developer copies an app origin out of, which are
    // listed in ALLOWED_LITERALS and therefore still scanned.
    const isTemplate = SKIPPED_FILES.has(entry.name) || entry.name.endsWith(".example");
    if (isTemplate && !(path in ALLOWED_LITERALS)) {
      continue;
    }
    if (SOURCE_FILE.test(entry.name) || path in ALLOWED_LITERALS) {
      results.push(full);
    }
  }
  return results;
}

/** Custom-domain routes a wrangler config claims, in declaration order. */
function claimedCustomDomains(path: string) {
  return [...readRepoFile(path).matchAll(/"pattern":\s*"([^"]+)",\s*"custom_domain":\s*true/g)].map(
    ([, pattern]) => pattern,
  );
}

describe("canonical origins are written down exactly once", () => {
  it("no source, config, or script hardcodes an origin this module owns", () => {
    const violations: string[] = [];
    for (const file of collectSourceFiles(repoRoot)) {
      const path = repoPath(file);
      const content = readFileSync(file, "utf8");
      for (const finding of [
        ...unaccountedOrigins(path, content),
        ...staleAllowances(path, content),
      ]) {
        violations.push(`${path}: ${finding}`);
      }
    }
    expect(violations).toEqual([]);
  }, 30_000);
});

describe("the files that cannot import the module still match it", () => {
  it("the product app Worker claims the app custom domain and nothing else", () => {
    // Two Workers cannot both claim one hostname (ADR 0035), so the apex is not
    // an acceptable answer here once the marketing Site exists.
    expect(claimedCustomDomains("wrangler.jsonc")).toEqual([APP_HOSTNAME]);
  });

  it("the MCP Worker claims the MCP custom domain and trusts the app origin", () => {
    expect(claimedCustomDomains("packages/mcp-worker/wrangler.jsonc")).toEqual([MCP_HOSTNAME]);
  });

  it("the deploy workflow reports the production app as the deployment", () => {
    expect(readRepoFile(".github/workflows/deploy.yml")).toContain(`url: ${APEX_ORIGIN}`);
  });

  it("the shipped plugin points at the production MCP resource and apex pages", () => {
    expect(readRepoFile("plugins/pocketcircle/.mcp.json")).toContain(MCP_RESOURCE_URI);
    expect(readRepoFile("plugins/pocketcircle/.codex-plugin/plugin.json")).toContain(
      `"homepage": "${APEX_ORIGIN}"`,
    );
  });
});
