// @vitest-environment node

/**
 * Repo guard for the canonical origins (#404). `origins.ts` is the only module
 * allowed to spell out PocketCircle's public origins; this test fails the build
 * the moment another file does, so an origin migration stays a one-line change
 * instead of a hunt across a dozen call sites.
 *
 * It lives beside the module it guards (there is no repo-root Vitest project) and
 * deliberately asserts — rather than merely allows — the handful of files that
 * cannot import TypeScript: wrangler config, a GitHub workflow, and the shipped
 * plugin manifests. Prose (`*.md`, `docs/`) and env templates (`*.example`)
 * document the origins rather than consume them, so they are out of scope.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  APEX_HOSTNAME,
  APEX_ORIGIN,
  APP_HOSTNAME,
  APP_ORIGIN,
  LOCAL_APP_ORIGIN,
  MCP_HOSTNAME,
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

/** Files with no TypeScript to import from; each is pinned by a test below. */
const ASSERTED_ELSEWHERE = new Set([
  ".github/workflows/deploy.yml",
  ".github/workflows/e2e.yml",
  "plugins/pocketcircle/.codex-plugin/plugin.json",
  "plugins/pocketcircle/.mcp.json",
  "packages/mcp-worker/wrangler.jsonc",
  "wrangler.jsonc",
]);

const SOURCE_FILE = /\.(?:[cm]?js|json|jsonc|sh|ts|tsx|webmanifest|ya?ml)$/;

/** This module is the one place the literals live, so it is the one exemption. */
const ORIGINS_MODULE = "packages/domain/src/origins.ts";

function escapeForRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function repoPath(absolute: string) {
  return relative(repoRoot, absolute).split(sep).join("/");
}

/**
 * Every origin this module owns, as patterns. The hostname alternation is built
 * from the constants, so an origin added here is guarded the moment it exists.
 * The lookbehind keeps a different subdomain of the apex (`assets.` for R2
 * media, which this module does not own) from reading as the apex itself.
 */
const FORBIDDEN = [
  {
    label: "a public origin",
    pattern: new RegExp(
      `(?<![\\w.-])(?:${[APEX_HOSTNAME, APP_HOSTNAME, MCP_HOSTNAME]
        .map(escapeForRegExp)
        .join("|")})\\b`,
    ),
  },
  { label: "the local app origin", pattern: new RegExp(escapeForRegExp(LOCAL_APP_ORIGIN)) },
];

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
    if (path === ORIGINS_MODULE || path.endsWith(".example") || SKIPPED_FILES.has(entry.name)) {
      continue;
    }
    if (SOURCE_FILE.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

/** Strips the `//` line comments wrangler's JSONC allows; none can start a JSON string. */
function readJsoncFile<T>(path: string, schema: z.ZodType<T>) {
  const content = readFileSync(join(repoRoot, path), "utf8");
  const withoutComments = content
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  return schema.parse(JSON.parse(withoutComments));
}

const routesSchema = z.object({ routes: z.array(z.object({ pattern: z.string() })) });
const mcpWorkerWranglerSchema = routesSchema.extend({
  vars: z.object({ APP_ORIGIN: z.string() }),
});
const pluginManifestSchema = z.object({
  interface: z.object({
    websiteURL: z.string(),
    privacyPolicyURL: z.string(),
    termsOfServiceURL: z.string(),
    supportURL: z.string(),
  }),
});
const mcpServerFileSchema = z.object({
  mcpServers: z.object({ pocketcircle: z.object({ url: z.string() }) }),
});

describe("canonical origins are written down exactly once", () => {
  it("no source, config, or script hardcodes an origin this module owns", () => {
    const violations: string[] = [];
    for (const file of collectSourceFiles(repoRoot)) {
      const path = repoPath(file);
      if (ASSERTED_ELSEWHERE.has(path)) {
        continue;
      }
      const content = readFileSync(file, "utf8");
      for (const { label, pattern } of FORBIDDEN) {
        if (pattern.test(content)) {
          violations.push(`${path} hardcodes ${label}`);
        }
      }
    }
    expect(violations).toEqual([]);
  }, 30_000);
});

describe("files that cannot import the origins module still match it", () => {
  it("the app Worker claims the app custom domain", () => {
    // The apex is still the app origin today; the ADR 0035 cutover gives the
    // apex to the marketing Site and moves this route to `app.`.
    const config = readJsoncFile("wrangler.jsonc", routesSchema);
    expect(config.routes.map((route) => route.pattern)).toContain(APP_HOSTNAME);
  });

  it("the MCP Worker claims the MCP custom domain and trusts the app origin", () => {
    const config = readJsoncFile("packages/mcp-worker/wrangler.jsonc", mcpWorkerWranglerSchema);
    expect(config.routes.map((route) => route.pattern)).toContain(MCP_HOSTNAME);
    expect(config.vars.APP_ORIGIN).toBe(APP_ORIGIN);
  });

  it("the deploy workflow reports the apex as the production deployment", () => {
    const workflow = readFileSync(join(repoRoot, ".github/workflows/deploy.yml"), "utf8");
    expect(workflow).toContain(`url: ${APEX_ORIGIN}`);
  });

  it("the E2E workflow points the backend at the origin Playwright drives", () => {
    const workflow = readFileSync(join(repoRoot, ".github/workflows/e2e.yml"), "utf8");
    expect(workflow).toContain(`convex env set SITE_URL "${LOCAL_APP_ORIGIN}"`);
  });

  it("the shipped plugin points at the production MCP resource and apex pages", () => {
    const mcp = readJsoncFile("plugins/pocketcircle/.mcp.json", mcpServerFileSchema);
    expect(mcp.mcpServers.pocketcircle.url).toBe(MCP_RESOURCE_URI);

    const manifest = readJsoncFile(
      "plugins/pocketcircle/.codex-plugin/plugin.json",
      pluginManifestSchema,
    );
    for (const [key, url] of Object.entries(manifest.interface)) {
      expect(url, key).toContain(APEX_ORIGIN);
    }
  });
});
