import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { collectRepoFiles, repoPath } from "@pocketcircle/dev-tools/repo-walk";
import { describe, expect, it } from "vitest";
import viteConfig from "../vite.config.js";

const repoRoot = join(import.meta.dirname, "../../..");
const packageRoot = join(import.meta.dirname, "..");
const wranglerConfig = readFileSync(join(packageRoot, "wrangler.jsonc"), "utf8");

/** Every Worker in the repo; the Site is the third, and they share one account. */
const workerConfigs = collectRepoFiles(repoRoot, (fileName) => fileName === "wrangler.jsonc");

function stringValue(key: string) {
  return new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`).exec(wranglerConfig)?.[1];
}

describe("the Site Worker", () => {
  it("serves static assets only, with no Worker script", () => {
    // No `main` means Workers answers every request from the asset manifest, so
    // the homepage costs no Worker invocations and stays in the free tier
    // (ADR 0035). A guard that missed the key would ship a billed Worker, so it
    // tolerates any spacing JSONC allows around the colon.
    expect(wranglerConfig).not.toMatch(/"main"\s*:/);
    expect(wranglerConfig).not.toMatch(/"script"\s*:/);
  });

  it("claims no custom domain and answers on workers.dev", () => {
    // The apex is the product app's until the cutover, and two Workers cannot
    // claim one hostname. `canonical-origins.test.ts` enforces that repo-wide;
    // this states the Site's half of it where the config lives.
    expect(wranglerConfig).not.toMatch(/"custom_domain"\s*:/);
    expect(wranglerConfig).not.toMatch(/"routes"\s*:/);
    expect(wranglerConfig).toMatch(/"workers_dev"\s*:\s*true/);
  });

  it("publishes the directory the build writes", () => {
    // A stale or misspelled assets directory deploys the previous build (or
    // nothing) without erroring, so the two are compared, not trusted.
    const outDir = viteConfig.build?.outDir ?? "dist";
    expect(resolve(packageRoot, stringValue("directory") ?? "")).toBe(resolve(packageRoot, outDir));
  });

  it("has a Worker name no other Worker in the repo claims", () => {
    // Deploying to a name another Worker already owns replaces that Worker in
    // the account, so the whole repo's set is compared, not just this config.
    const names = workerConfigs.map(
      (file) => /"name"\s*:\s*"([^"]*)"/.exec(readFileSync(file, "utf8"))?.[1],
    );
    expect(names).toContain("pocketcircle-site");
    expect(new Set(names).size).toBe(names.length);
  });

  it("is one of the Workers the walk found", () => {
    // Guards the walk itself: a repo-root mistake would make the assertions above
    // pass on one config.
    expect(workerConfigs.map((file) => repoPath(repoRoot, file))).toEqual(
      expect.arrayContaining([
        "wrangler.jsonc",
        "packages/mcp-worker/wrangler.jsonc",
        "apps/site/wrangler.jsonc",
      ]),
    );
  });
});
