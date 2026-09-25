import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import viteConfig from "../vite.config.js";

const repoRoot = join(import.meta.dirname, "../../..");
const packageRoot = join(import.meta.dirname, "..");
const wranglerConfig = readFileSync(join(packageRoot, "wrangler.jsonc"), "utf8");

/**
 * Every Wrangler config in the repo. The Site is the third, and the three share
 * one Cloudflare account, so a name collision would replace a live Worker.
 */
const workerConfigs = [
  "wrangler.jsonc",
  "packages/mcp-worker/wrangler.jsonc",
  "apps/site/wrangler.jsonc",
];

function stringValue(key: string) {
  return new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`).exec(wranglerConfig)?.[1];
}

describe("the Site Worker", () => {
  it("serves static assets only, with no Worker script", () => {
    // No `main` means Workers answers every request from the asset manifest, so
    // the homepage costs no Worker invocations and stays in the free tier
    // (ADR 0035).
    expect(wranglerConfig).not.toMatch(/"main"/);
    expect(wranglerConfig).not.toMatch(/"script"/);
  });

  it("claims no custom domain and answers on workers.dev", () => {
    // The apex is the product app's until the cutover, and two Workers cannot
    // claim one hostname. `canonical-origins.test.ts` enforces that repo-wide;
    // this states the Site's half of it where the config lives.
    expect(wranglerConfig).not.toMatch(/custom_domain/);
    expect(wranglerConfig).not.toMatch(/"routes"/);
    expect(wranglerConfig).toMatch(/"workers_dev"\s*:\s*true/);
  });

  it("publishes the directory the build writes", () => {
    // A stale or misspelled assets directory deploys the previous build (or
    // nothing) without erroring, so the two are compared, not trusted.
    const outDir = viteConfig.build?.outDir ?? "dist";
    expect(resolve(packageRoot, stringValue("directory") ?? "")).toBe(resolve(packageRoot, outDir));
  });

  it("has a Worker name of its own", () => {
    const names = workerConfigs.map(
      (path) => /"name"\s*:\s*"([^"]*)"/.exec(readFileSync(join(repoRoot, path), "utf8"))?.[1],
    );
    expect(new Set(names).size).toBe(workerConfigs.length);
  });
});
