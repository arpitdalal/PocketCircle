import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    expect(gate).toContain("Wait for main to clear this commit");
    expect(cut).not.toContain("Wait for main to clear this commit");

    // THE invariant of #423. A tag makes a version number real and cannot be
    // un-made: once a release is published against it, release immutability locks
    // the tag and reserves the name for good. So the one job that creates a tag
    // must not be reachable except through a job that has already established the
    // commit passed. `needs: gate` is the whole mechanism, and it is invisible to
    // a test that only looks for the tag push somewhere in the file — a `needs:`
    // dropped during a refactor reads exactly like a passing workflow.
    expect(cut).toContain("needs: gate");
    // And `gate` is the only thing it depends on: a second entry, or an entry on
    // some other job, satisfies the line above while still cutting a tag whose
    // commit was never checked.
    expect([...cut.matchAll(/^ {4}needs: (.+)$/gm)].map(([, value]) => value.trim())).toEqual([
      "gate",
    ]);
  });

  it("gates on main's own CI and E2E verdicts, waited for rather than re-run", () => {
    // The gate that stopped v0.8.1, and it is a bigger gate than re-running the
    // checks here would be: CI on main already runs typecheck, lint, the unit
    // tests and both production builds, and E2E is the real Playwright suite
    // against a live backend. Re-running any of it would cost ~9 minutes per
    // release to re-derive a verdict main has already reached.
    expect(gate).toContain("actions/runs?head_sha=");
    expect(gate).toContain("verdict CI");
    expect(gate).toContain("verdict E2E");
    // E2E is the one that makes this a gate rather than a formality. A commit
    // whose E2E is red can need a code change, and a code change means the tag
    // cannot be reused — which is the exact failure this workflow is for.
    expect(gate).toContain('"$ci" == "success" && "$e2e" == "success"');
    // And a red verdict must stop the release rather than be waited out.
    expect(gate).toMatch(/if failed "\$ci" \|\| failed "\$e2e"; then/);
    // Bounded, because this waits on somebody else's workflow; and a timeout is
    // explicitly not a spent version, because nothing was cut.
    expect(gate).toMatch(/deadline=\$\(\( \$\(date \+%s\) \+ 2700 \)\)/);
    expect(gate).toMatch(/no version was spent/);
    // The same script `deploy.yml` runs, so the two cannot disagree about which
    // version is releasable.
    expect(gate).toContain("./scripts/release-notes.sh");
  });

  it("releases main's tip, not merely any commit main once contained", () => {
    // An ancestry test is not enough. A stale branch whose tip was merged last
    // week is an ancestor of main, and releasing from it would tag and deploy code
    // main has been superseded by while every check stayed green — which is a
    // worse failure than a red commit, because nothing reports it.
    expect(gate).toMatch(/if \[\[ "\$DISPATCH_REF" != "refs\/heads\/main" \]\]; then/);
    // And the commit is captured once, here, because main can advance between the
    // dispatch and the cut, and the tag has to name what the release asked for.
    expect(gate).toContain("sha=$DISPATCH_SHA");
    expect(cut).toContain("ref: $" + "{{ needs.gate.outputs.sha }}");
  });

  it("cannot deploy, roll back, or reach a User", () => {
    // This workflow reads main's verdicts, cuts a tag and dispatches. It holds no
    // production credential, so the deploy stays the only thing that can move
    // production — a release gate that could also deploy would double the blast
    // radius of every mistake in it, and the gate's whole job is to have already
    // run.
    for (const secret of [
      "CLOUDFLARE_API_TOKEN",
      "CONVEX_DEPLOY_KEY",
      "MCP_WORKER_HMAC_SECRET",
      "MCP_WORKER_SIGNING_PRIVATE_JWK",
      "MCP_WORKER_VERIFYING_JWKS",
    ]) {
      expect(release).not.toContain(secret);
    }
    // And the writes are scoped to the job that needs them: the gate only reads
    // run verdicts. `actions: write` is not optional alongside the dispatch — an
    // unspecified scope is `none`, so leaving it out fails the dispatch with a
    // 403 *after* the tag is already cut, which is the worst place to find out.
    expect(gate).not.toContain("contents: write");
    expect(gate).not.toContain("actions: write");
    expect(gate).toContain("actions: read");
    expect(cut).toContain("contents: write");
    expect(cut).toContain("actions: write");
  });

  it("reuses a tag that already names the gated commit, and refuses one that does not", () => {
    // The re-run of a release whose dispatch or deploy did not finish. Because
    // the tag already names this exact commit, deploying it is correct and the
    // version is not spent — which is the recovery this whole workflow exists to
    // make possible.
    expect(cut).toContain("reusing it");
    // Compared by RESOLVED commit, through the shared script, never by what the
    // ref endpoint reports. An annotated tag — which is what `git tag -a` makes,
    // and so every hand-pushed release tag in this repo's history — reports the
    // tag object's SHA, and comparing that to a commit rejects a tag naming
    // exactly the right commit.
    expect(cut).toContain("./scripts/resolve-tag-commit.sh");
    expect(cut).not.toMatch(/git\/ref\/tags\/\$VERSION" --jq \.object\.sha/);
    // A tag naming anything else is that version spent on different code, and it
    // is not recoverable by deleting and re-cutting. Refusing is the only honest
    // answer, so the message has to say what to do instead.
    expect(cut).toMatch(/already names commit \$existing, not \$SHA/);
    expect(cut).toMatch(/release the next one/i);
  });

  it("gates on main's own push runs, not any run of the same workflow", () => {
    // Both CI and E2E also run for `pull_request`, and a commit reaches main with
    // a SHA a PR run can share — every merge that keeps the commit identity,
    // which is what a rebase or a direct promotion does. Unfiltered, the first
    // CI-shaped run for that SHA wins, so a green PR run can stand in for a red
    // main run, or for one that has not started. A PR run says nothing about
    // main: it merges a synthetic merge commit and its head_sha is the branch tip.
    // The filter is a jq expression inside a shell string inside YAML, so the
    // quotes are backslash-escaped in the file; matched as plain text, which is
    // what it is.
    expect(gate).toContain('.event == \\"push\\"');
    expect(gate).toContain('.head_branch == \\"main\\"');
  });

  it("keeps the gate job's checkout permission", () => {
    // A job-level `permissions` map REPLACES the workflow-level one and sets
    // every scope it does not name to `none` — it is not a merge. Naming only
    // `actions: read` here silently removes the `contents: read` the checkout
    // needs, and the failure is at step 1 of the run, having validated nothing.
    // That is a bug this branch shipped once already.
    expect(gate).toMatch(/^ {6}contents: read$/m);
    expect(gate).toMatch(/^ {6}actions: read$/m);
  });

  it("refuses to publish a release that would attest to a different commit", () => {
    // The last irreversible step. Publishing an immutable release locks its tag to
    // whatever the tag names at that instant, and a tag is protected from the
    // moment a release exists — not from the moment it is created. A tag moved
    // during the E2E and approval minutes would be frozen in, with production
    // serving one commit and the release attesting to another, both permanent.
    // `--verify-tag` does not help: it asserts the tag exists, never which commit
    // it names.
    expect(deploy).toContain("./scripts/resolve-tag-commit.sh");
    expect(deploy).toMatch(/\$named" != "\$GITHUB_SHA/);
    expect(deploy).toMatch(/Refusing to publish/);
    // And it has to be before every publish path, not only the create one.
    const publish = deploy.indexOf("Publish release notes");
    const create = deploy.indexOf("gh release create", publish);
    const edit = deploy.indexOf("gh release edit", publish);
    expect(publish).toBeGreaterThan(-1);
    expect(deploy.indexOf("resolve-tag-commit.sh")).toBeLessThan(create);
    expect(deploy.indexOf("resolve-tag-commit.sh")).toBeLessThan(edit);
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

  it("deploys the commit it was dispatched against, not whatever the tag says later", () => {
    // A tag is protected from the moment a release is published against it, not
    // from the moment it is created — so between the dispatch and the release
    // job, a tag with no release yet is still deletable and re-creatable.
    // `github.ref` re-resolves it at each checkout; a run that spent minutes in
    // E2E and then waited on a human approval could deploy a commit no check in
    // that run ever saw. `github.sha` is fixed for the life of the run.
    expect(deploy).not.toContain("ref: $" + "{{ github.ref }}");
    expect([...deploy.matchAll(/^ {10}ref: \$\{\{ github\.sha \}\}$/gm)]).toHaveLength(2);
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
    // The run this would cancel is the one holding the gate for a version
    // somebody is waiting on. A *pending* run is still replaced by a newer one,
    // which is the right way round here: a second dispatch is a correction of
    // the first, and the newest request is the one that should run.
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

describe("resolve-tag-commit.sh", () => {
  const script = join(import.meta.dirname, "../../scripts/resolve-tag-commit.sh");

  const LIGHTWEIGHT_COMMIT = "51e359e2" + "a".repeat(32);
  const ANNOTATED_COMMIT = "8730aa05" + "b".repeat(32);
  const TAG_OBJECT = "bacffa56" + "5a811e81fc732e9c9ed32d6969b35df4".slice(0, 32);

  /**
   * A `gh` that answers from a fixture, so the script's real logic runs — the
   * ref lookup, the dereference loop, the type check, the argument validation —
   * against ref shapes git actually produces. `gh` is the boundary here, and it
   * is the only thing faked: the script is executed, not reimplemented.
   *
   * `read -r` over a here-string rather than a pipe, because a `while read` loop
   * consuming a pipe never sees the last line without a trailing newline, and a
   * fixture that silently drops its final rule is a fixture that lies.
   */
  async function resolve(fixtures: Record<string, string | "missing">) {
    const dir = await mkdtemp(join(tmpdir(), "resolve-tag-"));
    const gh = join(dir, "gh");
    const rules = Object.entries(fixtures).map(([url, answer]) =>
      answer === "missing" ? `${url}\tmissing\t-` : `${url}\t${answer}`,
    );
    await writeFile(
      gh,
      `#!/usr/bin/env bash
# The first argument that looks like a repo path, rather than a fixed position:
# \`gh api URL --jq FILTER\` keeps the filter as one argument, so counting
# positions is a guess about how the caller quoted it.
url=""
for a in "$@"; do
  case "$a" in
    repos/*) url="$a"; break ;;
  esac
done
while IFS=$'\\t' read -r pat type sha; do
  [[ -z "$pat" ]] && continue
  if [[ "$url" == *"$pat"* ]]; then
    if [[ "$type" == "missing" ]]; then echo "gh: Not Found" >&2; exit 1; fi
    printf '%s %s\\n' "$type" "$sha"; exit 0
  fi
done <<< "$(cat "$GH_FIXTURE")"
echo "gh: unhandled $url" >&2; exit 1
`,
    );
    await chmod(gh, 0o755);
    const fixtureFile = join(dir, "fixture");
    await writeFile(fixtureFile, `${rules.join("\n")}\n`);
    try {
      return await execFileAsync(script, ["arpitdalal/PocketCircle", "v1.0.0"], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}`, GH_FIXTURE: fixtureFile },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const ref = "git/ref/tags/v1.0.0";
  const tags = (sha: string) => `git/tags/${sha}`;

  it("resolves a lightweight tag to its commit", async () => {
    const { stdout } = await resolve({ [ref]: `commit ${LIGHTWEIGHT_COMMIT}` });
    expect(stdout.trim()).toBe(LIGHTWEIGHT_COMMIT);
  });

  it("dereferences an annotated tag to the commit it points at", async () => {
    // The bug this script exists for. The ref endpoint reports the tag OBJECT's
    // SHA for an annotated tag, so comparing `object.sha` to a commit rejects a
    // tag naming exactly the right commit. Every hand-pushed release tag in this
    // repo is annotated, so this is the common shape and not an edge case.
    const { stdout } = await resolve({
      [ref]: `tag ${TAG_OBJECT}`,
      [tags(TAG_OBJECT)]: `commit ${ANNOTATED_COMMIT}`,
    });
    expect(stdout.trim()).toBe(ANNOTATED_COMMIT);
    expect(stdout.trim()).not.toBe(TAG_OBJECT);
  });

  it("follows a tag of a tag", async () => {
    const { stdout } = await resolve({
      [ref]: "tag 1111111",
      [tags("1111111")]: "tag 2222222",
      [tags("2222222")]: `commit ${ANNOTATED_COMMIT}`,
    });
    expect(stdout.trim()).toBe(ANNOTATED_COMMIT);
  });

  it("refuses a tag nested past the hop bound instead of spinning", async () => {
    await expect(
      resolve({
        [ref]: "tag 1111111",
        [tags("1111111")]: "tag 2222222",
        [tags("2222222")]: "tag 3333333",
        [tags("3333333")]: `commit ${ANNOTATED_COMMIT}`,
      }),
    ).rejects.toMatchObject({ stderr: expect.stringMatching(/three tag objects deep/) });
  });

  it("names the tag when it does not exist", async () => {
    await expect(resolve({ [ref]: "missing" })).rejects.toMatchObject({
      stderr: expect.stringMatching(/no such tag: v1\.0\.0 in arpitdalal\/PocketCircle/),
    });
  });

  it("refuses a tag pointing at neither a commit nor a tag", async () => {
    // A tag on a blob is a git-legal thing to write. It is not a release, and
    // silently treating it as a commit would compare a blob SHA to a commit SHA.
    await expect(resolve({ [ref]: "blob deadbeef" })).rejects.toMatchObject({
      stderr: expect.stringMatching(/'blob' object, not a commit or a tag/),
    });
  });

  it("refuses a malformed response rather than reading it as some object", async () => {
    // A well-formed HTTP response that is not the expected shape — an empty body,
    // a rate-limit message — must not be read as an object of an unnamed type,
    // which would report the tag as broken when the API is.
    await expect(resolve({ [ref]: "commit" })).rejects.toMatchObject({
      stderr: expect.stringMatching(/unexpected response/),
    });
  });

  it("requires a repo and a tag", async () => {
    await expect(execFileAsync(script, [])).rejects.toMatchObject({
      stderr: expect.stringMatching(/exactly two arguments/),
    });
    await expect(execFileAsync(script, ["not-a-repo", "v1.0.0"])).rejects.toMatchObject({
      stderr: expect.stringMatching(/OWNER\/REPO/),
    });
  });
});
