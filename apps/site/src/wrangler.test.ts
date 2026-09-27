import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { collectRepoFiles, repoPath } from "@pocketcircle/dev-tools/repo-walk";
import { APEX_HOSTNAME } from "@pocketcircle/domain/origins";
import { describe, expect, it } from "vitest";
import viteConfig from "../vite.config.js";
import { NOT_FOUND_PAGE } from "./pages.js";

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

  it("claims the apex, and answers on the staging hostname as well", () => {
    // The cutover (#411) handed the apex over from the product app, so this Worker
    // owns it alone. Two Workers cannot both claim one hostname, which
    // `canonical-origins.test.ts` enforces repo-wide; this states the Site's half of
    // it where the config lives.
    //
    // `workers_dev` is not a leftover and the deploy does not read it: the release
    // verifies on the apex, because that is the only origin where a wrong answer is
    // possible. It is kept for the two things only a second hostname is good for —
    // inspecting this Worker without touching the public apex, and rolling back to it
    // if the apex claim is the thing that broke. The test holds it because a flag
    // that is load-bearing only in a failure nobody has had yet is exactly the flag
    // that gets "cleaned up".
    expect(wranglerConfig).toMatch(/"workers_dev"\s*:\s*true/);
    expect(
      [...wranglerConfig.matchAll(/"pattern"\s*:\s*"([^"]+)"/g)].map(([, pattern]) => pattern),
    ).toEqual([APEX_HOSTNAME]);
  });

  it("serves each page itself, at the path external material cites", () => {
    // The four marketing documents are published as `privacy.html` and friends and
    // have to answer `/privacy` and friends, because those are the URLs already
    // published to third parties and the ones Google requires to share the
    // branding homepage's domain (ADR 0035). `auto-trailing-slash` is the value
    // that maps one to the other, and it is the default, so it is written out and
    // held here: `force-trailing-slash` would answer `/privacy` with a redirect and
    // `none` would 404 it, and the build would stay green either way, because the
    // files are published either way. The redirect case is what
    // `scripts/assert-site-html.mjs` and the deploy check cannot see and this can.
    expect(wranglerConfig).toMatch(/"html_handling"\s*:\s*"auto-trailing-slash"/);
  });

  it("serves the authored not-found document rather than the platform's", () => {
    // `not_found_handling` names its file by convention and nothing else ties the
    // two together, so both halves are read here: a config naming `404-page` with no
    // such file published is a dead end back to a bare 404, and neither failure is
    // visible in the build output.
    // The value, not the file: the config's own comment names the value it forbids,
    // so a substring search would fail on the explanation.
    const notFoundHandling = /"not_found_handling"\s*:\s*"([^"]*)"/.exec(wranglerConfig)?.[1];
    expect(notFoundHandling).toBe("404-page");
    expect(readFileSync(join(packageRoot, NOT_FOUND_PAGE), "utf8")).toContain("<h1");
    // Never the SPA fallback: answering every unknown path with the homepage would
    // be duplicate content on every typo, and would make the legacy redirects look
    // indistinguishable from ones that had failed.
    expect(notFoundHandling).not.toMatch(/single-page-application/);
  });

  it("publishes the directory the build writes", () => {
    // A stale or misspelled assets directory deploys the previous build (or
    // nothing) without erroring, so the two are compared, not trusted.
    const outDir = viteConfig.build?.outDir ?? "dist";
    expect(resolve(packageRoot, stringValue("directory") ?? "")).toBe(resolve(packageRoot, outDir));
  });

  it("has a Worker name no other Worker in the repo claims", () => {
    // Deploying to a name another Worker already owns replaces that Worker in the
    // account, so the whole repo's set is compared, not just this config.
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

describe("the apex handover in the deploy workflow", () => {
  const workflow = readFileSync(join(repoRoot, ".github/workflows/deploy.yml"), "utf8");
  /**
   * Every step in the deploy job, in order — not just the ones named `Deploy`.
   *
   * The distinction is the whole test. A filter to deploy steps reads the same two
   * names as a full list does while the two deploys are adjacent, so it passes, and
   * it keeps passing after someone drops a `Verify` or a config step between them —
   * which is exactly the edit the assertion exists to catch, and exactly the one
   * that widens the handover gap without changing anything this list can see.
   */
  const steps = [...workflow.matchAll(/^ {6}- name: (.+)$/gm)].map(
    ([, name]) => name?.trim() ?? "",
  );

  it("deploys the product Worker and the Site back to back", () => {
    // Two Workers cannot both claim the apex, so the handover is sequential: the
    // product Worker drops it, the Site claims it. A custom domain sends every path
    // on its hostname to the Worker bound to it, so the gap is not only the
    // marketing homepage — a bookmarked Circle, a shared Transaction link, and an
    // already-delivered Invitation all fail for as long as neither Worker holds the
    // name.
    //
    // Nothing else in the repo defends the ordering. Each deploy is correct on its
    // own, the Site is the only Worker that can answer the apex afterwards, and the
    // redirect check passes as soon as it is up — so a step inserted between them
    // ships green and quietly widens the gap to the length of that step.
    const product = steps.indexOf("Deploy product app Worker");
    const site = steps.indexOf("Deploy marketing Site");
    expect(steps.length, "no steps found — the workflow's shape changed").toBeGreaterThan(10);
    expect(product, steps.join(" -> ")).toBeGreaterThanOrEqual(0);
    expect(site, steps.join(" -> ")).toBe(product + 1);
  });

  it("builds the Site before anything is deployed, and deploys it last of the three", () => {
    // The property that justifies splitting build from deploy: a Site that does not
    // compile, a document that was never published, an invalid assets config — those
    // are build failures, and catching them before the Convex deploy and the
    // push-delivery gate have moved at all is worth the ordering. The deploy itself
    // cannot come early, because claiming the apex is the *second* half of the
    // handover, so this is the most the ordering can buy.
    expect(steps.indexOf("Build marketing Site")).toBeLessThan(
      steps.indexOf("Deploy Convex production backend"),
    );
    expect(steps.indexOf("Deploy marketing Site")).toBeGreaterThan(
      steps.indexOf("Deploy product app Worker"),
    );
  });
});
