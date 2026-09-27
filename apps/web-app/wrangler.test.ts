import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The product app Worker (#410). Its config sits at the repo root, which is where
 * the deploy workflow's product deploy and `pnpm start` find it; this test lives
 * with the app it serves.
 *
 * What it guards is the one thing about this config nothing else checks: the SPA
 * fallback, which is the whole of how a cold load of a deep link works — a
 * bookmarked Circle, a Transaction edit link with the filters a shared link
 * carries, a filtered search URL. All of them are client routes with no file behind
 * them, so `not_found_handling` is the only thing that answers them. Neither
 * `routes.ts` nor the deploy check can see it: the build publishes the same files
 * either way, and an origin that 404s every deep link is a 404, not a build
 * failure. It is what makes the app resolve on both of the hosts the Worker claims.
 *
 * The hostname claims are `canonical-origins.test.ts`'s half of the same config,
 * asserted there against the constants in `origins.ts` so a wrangler pattern and
 * the app's own links cannot drift.
 */
const wranglerConfig = readFileSync(join(import.meta.dirname, "../../wrangler.jsonc"), "utf8");

describe("the product app Worker", () => {
  it("serves static assets only, with no Worker script", () => {
    // No `main` means Workers answers every request from the asset manifest, so
    // serving the app from a second hostname still costs no Worker invocations and
    // stays in the free tier (ADR 0035). A guard that missed the key would ship a
    // billed Worker, so it tolerates any spacing JSONC allows around the colon.
    expect(wranglerConfig).not.toMatch(/"main"\s*:/);
    expect(wranglerConfig).not.toMatch(/"script"\s*:/);
  });

  it("answers every unmatched path with the app shell", () => {
    expect(wranglerConfig).toMatch(/"not_found_handling"\s*:\s*"single-page-application"/);
  });
});
