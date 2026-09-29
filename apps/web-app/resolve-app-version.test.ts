import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { LOCAL_APP_VERSION, resolveAppRelease, resolveAppVersion } from "./resolve-app-version.js";

const execFileAsync = promisify(execFile);

describe("resolveAppVersion", () => {
  it("uses the immutable release tag", () => {
    expect(resolveAppVersion({ APP_RELEASE_VERSION: "v0.1.0" })).toBe("v0.1.0");
  });

  it("labels local builds when no release tag is supplied", () => {
    expect(resolveAppVersion({})).toBe("local-dev");
    expect(resolveAppVersion({ APP_RELEASE_VERSION: "   " })).toBe("local-dev");
    expect(LOCAL_APP_VERSION).toBe("local-dev");
  });

  it("keeps the full SHA as telemetry provenance", () => {
    expect(
      resolveAppRelease({
        APP_RELEASE_VERSION: " v0.1.0 ",
        APP_RELEASE_SHA: " a1b2c3d4e5f6789012345678901234567890abcd ",
      }),
    ).toBe("v0.1.0+a1b2c3d4e5f6789012345678901234567890abcd");
    expect(resolveAppRelease({ APP_RELEASE_VERSION: "v0.1.0" })).toBe("v0.1.0");
  });
});

describe("Vite version injection", () => {
  it("centralizes version resolution in the Vite and Vitest configs", () => {
    const dir = import.meta.dirname;
    const viteConfig = readFileSync(join(dir, "vite.config.ts"), "utf8");
    const vitestConfig = readFileSync(join(dir, "vitest.config.ts"), "utf8");

    expect(viteConfig).toMatch(/from\s+["']\.\/resolve-app-version/);
    expect(viteConfig).toMatch(/resolveAppVersion\(/);
    expect(viteConfig).not.toMatch(/npm_package_version/);
    expect(vitestConfig).toMatch(/from\s+["']\.\/resolve-app-version/);
    expect(vitestConfig).toMatch(/resolveAppVersion\(/);
    expect(vitestConfig).not.toMatch(/npm_package_version/);
  });

  it("deploys only verified immutable SemVer release tags", () => {
    const deploy = readFileSync(
      join(import.meta.dirname, "../../.github/workflows/deploy.yml"),
      "utf8",
    );
    expect(deploy).toContain("tags: [v*]");
    expect(deploy).toContain("uses: ./.github/workflows/e2e.yml");
    expect(deploy).toContain("APP_RELEASE_VERSION: $" + "{{ steps.release.outputs.version }}");
    expect(deploy).toContain("APP_RELEASE_SHA: $" + "{{ steps.release.outputs.sha }}");
    expect(deploy).toContain("run: ./scripts/release-notes.sh");
    expect(deploy).toContain("release:");
    expect(deploy).toContain("needs: deploy");
    expect(deploy).toContain("contents: write");
    expect(deploy).toContain("gh release create");
    expect(deploy).toContain("gh release edit");
    expect(deploy).toContain("--notes-file release-notes.md");
    expect(deploy).toContain("--draft=false");
    expect(deploy).toMatch(
      /published with notes that differ from CHANGELOG\.md\. Refusing to overwrite/,
    );
    expect(deploy).not.toContain("treating this retry as complete");
    expect(deploy).not.toContain("workflow_run:");
  });

  it("syncs Convex release and Sentry env only after a successful backend deploy", () => {
    const deploy = readFileSync(
      join(import.meta.dirname, "../../.github/workflows/deploy.yml"),
      "utf8",
    );
    const backendDeploy = deploy.indexOf("convex deploy -y");
    const setRelease = deploy.indexOf("convex env set APP_RELEASE");
    expect(backendDeploy).toBeGreaterThan(-1);
    expect(setRelease).toBeGreaterThan(backendDeploy);
    expect(deploy).toMatch(/convex env set SENTRY_DSN "\$VITE_SENTRY_DSN"/);
    expect(deploy).toMatch(/convex env remove SENTRY_DSN/);
  });
});

/**
 * One workflow's `jobs:` block per job name, so an assertion can be about the job
 * that does a thing rather than about the file that mentions it.
 */
function jobBlocks(workflow: string) {
  const jobs = workflow.slice(workflow.indexOf("\njobs:\n"));
  const starts = [...jobs.matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)];
  return new Map(
    starts.map((match, index) => [
      match[1],
      jobs.slice(match.index, starts[index + 1]?.index ?? jobs.length),
    ]),
  );
}

/** The stable-SemVer shape every gate in the repo agrees on. */
const STABLE_SEMVER = String.raw`^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`;

describe("release workflow", () => {
  const release = readFileSync(
    join(import.meta.dirname, "../../.github/workflows/release.yml"),
    "utf8",
  );
  const deploy = readFileSync(
    join(import.meta.dirname, "../../.github/workflows/deploy.yml"),
    "utf8",
  );
  const jobs = jobBlocks(release);
  const gate = jobs.get("gate") ?? "";
  const cut = jobs.get("cut") ?? "";

  it("cuts the tag only from a job that depends on the gate", () => {
    // Every assertion in this block is scoped to one job, so it is only as good
    // as the split. If `cut` ever came back as the whole file, "the tag job
    // depends on the gate" would pass on the strength of a comment elsewhere, and
    // "the tag job runs no checks" would pass on the strength of the gate's. The
    // gate's own marker is the witness that the two really are separate.
    expect(gate).toContain("pnpm validate");
    expect(cut).not.toContain("pnpm validate");

    // THE invariant of #423. A tag makes a version number real and cannot be
    // un-made: release immutability locks it once a release is published against
    // it, and until then deleting it is the only way back. So the one job that
    // creates a tag must not be reachable except through a job that has already
    // run the checks. `needs: gate` is the whole mechanism, and it is invisible to
    // a test that only looks for the tag push somewhere in the file — a `needs:`
    // dropped during a refactor reads exactly like a passing workflow.
    expect(cut).toContain("needs: gate");
    // And `gate` is the only thing it depends on: a second entry, or an entry on
    // some other job, satisfies the line above while still cutting a tag whose
    // gates never ran.
    expect([...cut.matchAll(/^ {4}needs: (.+)$/gm)].map(([, value]) => value.trim())).toEqual([
      "gate",
    ]);
  });

  it("gates on every check that fails without a code change to fix it", () => {
    // Deterministic failures are pre-tag because fixing them needs a new commit,
    // which spends the version. E2E, the deploys, and a missing secret are all
    // absent on purpose: each is recoverable by re-running `deploy.yml` on the
    // same tag, so gating on them here would cost every release nine minutes to
    // re-derive an answer `main`'s own CI already gives.
    expect(gate).toContain("pnpm install --frozen-lockfile");
    expect(gate).toContain("run: pnpm validate");
    expect(gate).toContain("run: pnpm build");
    expect(gate).toContain("run: pnpm build:site");
    // The same script `deploy.yml` runs, so the two cannot disagree about which
    // version is releasable.
    expect(gate).toContain("./scripts/release-notes.sh");
  });

  it("cannot deploy, roll back, or reach a User", () => {
    // This workflow builds and cuts a tag. It holds no production credential, so
    // the deploy stays the only thing that can move production — a release gate
    // that could also deploy would double the blast radius of every mistake in it
    // for no gain, since the gate's whole job is to have already run.
    for (const secret of [
      "CLOUDFLARE_API_TOKEN",
      "CONVEX_DEPLOY_KEY",
      "MCP_WORKER_HMAC_SECRET",
      "MCP_WORKER_SIGNING_PRIVATE_JWK",
      "MCP_WORKER_VERIFYING_JWKS",
    ]) {
      expect(release).not.toContain(secret);
    }
    // And the write permissions are scoped to the job that needs them: the gate
    // reads. `actions: write` is not optional alongside the dispatch — an
    // unspecified scope is `none`, so leaving it out fails the dispatch with a
    // 403 after the tag is already cut, which is the worst place to find out.
    expect(gate).not.toContain("contents: write");
    expect(gate).not.toContain("actions: write");
    expect(cut).toContain("contents: write");
    expect(cut).toContain("actions: write");
  });

  it("reuses a tag that already points at the gated commit, and refuses one that does not", () => {
    // The re-run of a release whose dispatch or deploy did not finish. Because
    // the tag already names this exact commit, deploying it is correct and the
    // version is not spent — which is the recovery this whole workflow exists to
    // make possible.
    expect(cut).toContain('gh api "repos/$GH_REPO/git/ref/tags/$VERSION"');
    expect(cut).toContain("reusing it");
    // A tag pointing anywhere else is that version spent on different code, and
    // it is not recoverable by deleting and re-cutting. Refusing is the only
    // honest answer, so the message has to say what to do instead.
    expect(cut).toMatch(/already tags \$existing, not \$SHA/);
    expect(cut).toMatch(/release the next one/i);
  });

  it("dispatches the deploy on the tag, so no version is passed twice", () => {
    // A tag pushed with GITHUB_TOKEN does not trigger `push: tags`, so the deploy
    // is dispatched explicitly — on the tag ref, not on a branch with the version
    // as an input. That is what keeps the `production` environment's `v*` tag
    // policy satisfied, and it means `deploy.yml` still reads the version from
    // `GITHUB_REF_NAME`, so there is no second copy of it to drift.
    expect(cut).toContain("gh workflow run deploy.yml");
    expect(cut).toMatch(/--repo "\$GH_REPO" --ref "\$VERSION"/);
    expect(deploy).toMatch(/^ {2}workflow_dispatch:$/m);
    expect(deploy).toContain("tags: [v*]");
    expect(deploy).toContain("version=$GITHUB_REF_NAME");
  });

  it("agrees with every other gate about what a version looks like", () => {
    // Four places parse or accept the version: this workflow, `deploy.yml`,
    // `scripts/release-notes.sh`, and `packages/domain/src/changelog.ts`. A tag one
    // of them accepts and another rejects is a release that cannot be cut, so the
    // two workflows at least are held to the same shape.
    expect(release).toContain(STABLE_SEMVER);
    expect(deploy).toContain(STABLE_SEMVER);
  });

  it("never cancels a release in flight", () => {
    // The run this would cancel is the one holding the gates for a version
    // somebody is waiting on. A second dispatch queues behind it instead.
    expect(release).toMatch(/concurrency:\n {2}group: release\n {2}cancel-in-progress: false/);
  });
});

describe("release-notes.sh", () => {
  const script = join(import.meta.dirname, "../../scripts/release-notes.sh");

  async function extractNotes(changelog: string, version: string) {
    const dir = await mkdtemp(join(tmpdir(), "release-notes-"));
    await writeFile(join(dir, "CHANGELOG.md"), changelog);
    try {
      return await execFileAsync(script, [version], { cwd: dir });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("requires a bullet or paragraph, not only category headings", async () => {
    await expect(
      extractNotes(
        `# Changelog\n\n## [v0.1.0] - 2026-08-14\n\n### Added\n\n## [Unreleased]\n`,
        "v0.1.0",
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringMatching(/bullet or paragraph/),
    });
  });

  it.each([
    ["HTML comment", "<!-- internal -->"],
    ["thematic break", "---"],
    ["spaced thematic break", "- - -"],
    ["spaced asterisk break", "* * *"],
    ["spaced underscore break", "_ _ _"],
    ["empty ATX heading", "###"],
    ["empty list marker", "-"],
  ])("rejects %s-only sections", async (_label, filler) => {
    await expect(
      extractNotes(`# Changelog\n\n## [v0.1.0] - 2026-08-14\n\n### Added\n\n${filler}\n`, "v0.1.0"),
    ).rejects.toMatchObject({
      stderr: expect.stringMatching(/bullet or paragraph/),
    });
  });

  it("emits the dated section body when it has substantive notes", async () => {
    const { stdout } = await extractNotes(
      `# Changelog\n\n## [v0.1.0] - 2026-08-14\n\n### Added\n\n- Ship release notes from CHANGELOG.md\n`,
      "v0.1.0",
    );
    expect(stdout).toContain("### Added");
    expect(stdout).toContain("- Ship release notes from CHANGELOG.md");
  });
});
