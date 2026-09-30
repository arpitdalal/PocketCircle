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

  it("delegates the gate decision to a script the tests execute", () => {
    // NOT a claim about this workflow's behaviour — a claim about where the
    // behaviour lives. The gate is `scripts/wait-for-main-gate.sh`, and its tests
    // drive the real script against a faked `gh` rather than searching this file
    // for tokens. A workflow is the one thing in the repo nothing executes, so an
    // assertion that its text contains a token proves the token is present and
    // nothing about what it does: an inverted condition, a quoting mistake in the
    // jq, and a gate that rejects every release or none all look identical to a
    // `toContain`.
    expect(gate).toContain("./scripts/wait-for-main-gate.sh");
    // And none of the decision is left inline here, because whatever is left
    // inline is precisely the part the tests cannot reach.
    expect(gate).not.toContain("actions/runs?head_sha=");
    expect(gate).not.toContain("head_branch");
    expect(gate).not.toContain("--jq");
    // The same script `deploy.yml` runs, so the two cannot disagree about which
    // version is releasable.
    expect(gate).toContain("./scripts/release-notes.sh");
  });

  it("keeps the gate job's checkout permission", () => {
    // A job-level `permissions` map REPLACES the workflow-level one and sets
    // every scope it does not name to `none` — it is not a merge. Naming only
    // `actions: read` here silently removes the `contents: read` the checkout
    // needs, and the failure is at step 1 of the run, having validated nothing.
    // That is a bug this branch shipped once already.
    expect(gate).toMatch(/^ {6}contents: read$/m);
    // Scoped to the `permissions:` block, because the job's comment explains the
    // rule by name and is not a scope. Both scopes are asserted by exact value so
    // that neither can be dropped and neither can be widened without this
    // failing — the second matters as much as the first, because a scope nothing
    // reads is a permission nobody has audited.
    const gatePermissions =
      /permissions:\n(?:\s*#.*\n)*(?<scopes>(?:\s{6}\w[\w-]*: \w+\n)+)/.exec(gate)?.groups
        ?.scopes ?? "";
    // `actions: read` as well, and the assertion names the reason: the gate script
    // lists workflow runs, which is an Actions read. Without it `gh api` 403s, the
    // script reports `unreadable` rather than a red commit, and the gate burns its
    // whole 45-minute timeout on every release before refusing. Quieter than the
    // checkout's failure because nothing goes red.
    expect(gatePermissions).toBe("      contents: read\n      actions: read\n");
    expect(cut).toMatch(/^ {6}contents: write$/m);
    expect(cut).toMatch(/^ {6}actions: write$/m);
  });

  it("refuses a moved tag before the first production mutation, and pins the run to it", () => {
    // The window this closes: Release cuts the tag, then dispatches the deploy,
    // and `--ref` resolves to whatever the tag names when the dispatch *begins*. A
    // tag is protected from the moment a release exists, not the moment it is
    // created, so one moved in that window — or in the minutes the deploy spends
    // in E2E and waiting on approval — would deploy a commit no check in that run
    // saw. Checking only before publishing is too late: by then Convex env, the
    // backend and both Workers have been mutated.
    const guard = deploy.indexOf("Refuse a tag that no longer names the commit being deployed");
    // The first thing in the job that writes to production, which is a Convex env
    // write and not the backend deploy 50-odd lines later.
    const firstMutation = deploy.indexOf("convex env set MCP_WORKER_VERIFYING_JWKS");
    expect(guard).toBeGreaterThan(-1);
    expect(firstMutation).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(firstMutation);

    // The comparisons themselves live in `scripts/assert-tag-names.sh`, which
    // dereferences the tag, compares it to this run's own `GITHUB_SHA`, and —
    // when Release dispatched this — to the commit it gated. Both are tested there
    // against the real script; what belongs to the workflow is calling it, and
    // calling it before anything is deployed.
    expect(deploy).toMatch(/gate_sha:/);
    expect(deploy).toMatch(
      /assert-tag-names\.sh "\$GH_REPO" "\$GITHUB_REF_NAME" "\$GITHUB_SHA" "\$\{\{ inputs\.gate_sha \}\}"/,
    );
    // Unconditional, not gated on Release having dispatched. The emergency
    // hand-push path — the one the rollback runbook uses, and the one nobody is
    // watching closely — had no tag check at all before production, because the
    // whole step was skipped without a `gate_sha`. The script treats an absent
    // gate as the hand-push case rather than as a failure.
    expect(deploy).not.toMatch(/if: inputs\.gate_sha/);

    // And called again immediately before the first production write. One call
    // near the top of the job is only true at the moment it ran, and
    // `pnpm install`, `pnpm validate` and two production builds sit between here
    // and there — long enough for a tag to be moved. Two calls, one script.
    const calls = [...deploy.matchAll(/\.\/scripts\/assert-tag-names\.sh/g)];
    expect(calls).toHaveLength(2);
    const firstWrite = deploy.indexOf("convex env set MCP_WORKER_VERIFYING_JWKS");
    expect(calls[1].index).toBeGreaterThan(-1);
    expect(calls[1].index).toBeLessThan(firstWrite);
    // Far enough after the first that the gap is real work, not the same check
    // twice in adjacent lines.
    expect(calls[1].index - calls[0].index).toBeGreaterThan(1000);

    // And a hand-pushed tag still works: the rollback path passes no gate_sha and
    // the person pushing it is making the statement themselves.
    expect(release).toMatch(/gh workflow run deploy\.yml .* -f gate_sha="\$SHA"/);
  });

  it("offers the recovery the README documents instead of only refusing", async () => {
    // The README's recovery table says a failure before the first production
    // mutation leaves the tag deletable, and release immutability makes that true.
    // The workflow only ever refused, so following the README stranded the version
    // anyway — the exact outcome #423 is about, reached by following the docs.
    //
    // Opt-in, because "the deploy failed" and "the deploy failed before touching
    // anything" are indistinguishable from inside the workflow. And gated on the
    // absence of a GitHub Release, because a published release reserves the tag
    // name permanently whatever the operator asks for.
    expect(cut).toContain("replace_unreleased_tag");
    expect(cut).toMatch(/inputs\.replace_unreleased_tag/);
    expect(cut).toMatch(/if \[ "\$\{\{ inputs\.replace_unreleased_tag \}\}"/);
    // Delete AND recreate. Deleting alone leaves the name absent and the very next
    // step dispatches the deploy against `refs/tags/$VERSION`, so the documented
    // recovery would fail at the dispatch and need a second, unexpected Release
    // run to finish. The recreate is asserted to come AFTER the delete, and both
    // to be inside the re-cut branch rather than after it.
    const deleteAt = cut.indexOf('--method DELETE "repos/$GH_REPO/git/refs/tags/$VERSION"');
    const recreateAt = cut.indexOf('--method POST "repos/$GH_REPO/git/refs"', deleteAt);
    expect(deleteAt).toBeGreaterThan(-1);
    expect(recreateAt).toBeGreaterThan(deleteAt);
    // And the recreated tag is the gated commit, not whatever it was before.
    expect(cut.slice(recreateAt)).toMatch(/-f ref="refs\/tags\/\$VERSION" -f sha="\$SHA"/);
    expect(cut).toMatch(/has a published GitHub Release/);
    // And the refusal is still the default path, with the recovery named in it, so
    // somebody who hits it is told both answers rather than only one.
    expect(cut).toMatch(/replace_unreleased_tag=true/);
    expect(cut).toMatch(/the version is spent/);
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

  const LIGHTWEIGHT_COMMIT = "51e359e2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const ANNOTATED_COMMIT = "8730aa05bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const TAG_OBJECT = "bacffa565a811e81fc732e9c9ed32d6969b35df4";

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

  it("reports the caller's argument count, not the usage function's own", async () => {
    // `$#` inside a function counts that function's arguments, so reading it
    // without forwarding the script's always reports 0 — the message would name a
    // count nobody passed. Asserted on a WRONG count, because the zero-argument
    // case is the one bug and fix agree on.
    await expect(execFileAsync(script, ["only-one"])).rejects.toMatchObject({
      stderr: expect.stringMatching(/exactly two arguments, got 1/),
    });
    await expect(execFileAsync(script, ["a", "b", "c"])).rejects.toMatchObject({
      stderr: expect.stringMatching(/exactly two arguments, got 3/),
    });
    await expect(execFileAsync(script, [])).rejects.toMatchObject({
      stderr: expect.stringMatching(/exactly two arguments, got 0/),
    });
  });

  it("requires a repo and a tag", async () => {
    await expect(execFileAsync(script, ["not-a-repo", "v1.0.0"])).rejects.toMatchObject({
      stderr: expect.stringMatching(/OWNER\/REPO/),
    });
  });
});

describe("wait-for-main-gate.sh", () => {
  const script = join(import.meta.dirname, "../../scripts/wait-for-main-gate.sh");

  const SHA = "ccfcd40cad56ee4ce9ad199b5ea7dbee69afdb44";

  /**
   * A `gh` that answers from a fixture keyed by the workflow path in the jq
   * filter, so the script's real logic runs: the API filter, the terminal-failure
   * classification, the readiness decision, the loop and the timeout.
   *
   * The stub is the only thing faked. `gh` is a genuine boundary — it is the only
   * thing the script talks to — so this is not a seam invented to make the test
   * pass. Everything in between is the real script, run as a subprocess with its
   * own PATH, which is also why the filter matching below has to quote `*`: an
   * unquoted `*` in a `[[ == ]]` right-hand side is a glob and silently matches
   * nothing, which looks exactly like an API that never answers.
   *
   * `GATE_TIMEOUT_SECONDS: "0"` makes the waiting paths terminate immediately
   * instead of sleeping, so a test for "waits" can assert the wait rather than
   * spend 45 minutes proving it.
   */
  async function gate(verdicts: Record<string, string | "error">) {
    const dir = await mkdtemp(join(tmpdir(), "main-gate-"));
    const rules = Object.entries(verdicts).map(([workflow, verdict]) =>
      verdict === "error" ? `${workflow}\tFAIL` : `${workflow}\t${verdict}`,
    );
    await writeFile(
      join(dir, "gh"),
      `#!/usr/bin/env bash
# Matched against the whole command line, not one argument. The two release
# scripts put the interesting string in different places — wait-for-main-gate.sh
# filters inside its jq expression while resolve-tag-commit.sh passes the ref path
# as the URL — and a stub that assumes either position matches nothing, which
# reads as a broken script rather than a broken harness.
query="$*"
while IFS=$'\\t' read -r pat ans; do
  [[ -z "$pat" ]] && continue
  needle="\${pat//\\*/\\\\*}"
  if [[ "$query" == *"$needle"* ]]; then
    if [[ "$ans" == "FAIL" ]]; then echo "gh: API error" >&2; exit 1; fi
    printf '%s\\n' "$ans"
    exit 0
  fi
done <<< "$(cat "$GH_FIXTURE")"
echo "gh: nothing matched this query" >&2
exit 1
`,
    );
    await chmod(join(dir, "gh"), 0o755);
    const fixture = join(dir, "verdicts");
    await writeFile(fixture, `${rules.join("\n")}\n`);
    try {
      return await execFileAsync(script, [SHA], {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH ?? ""}`,
          GH_FIXTURE: fixture,
          GITHUB_REPOSITORY: "arpitdalal/PocketCircle",
          GATE_TIMEOUT_SECONDS: "0",
          GATE_POLL_SECONDS: "0",
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const green = {
    "workflows/ci.yml": "success",
    "workflows/e2e.yml": "success",
  } as const;

  it("passes only when both CI and E2E are green on main", async () => {
    // Both, not either. E2E is what makes this a gate rather than a formality: a
    // commit whose E2E is red can need a code change, and a code change means the
    // tag cannot be reused, which is the exact failure the gate exists to prevent.
    const { stdout } = await gate(green);
    expect(stdout).toContain("green on");
  });

  it.each([
    ["failure", "CI failed"],
    ["cancelled", "CI was cancelled"],
    ["timed_out", "CI timed out"],
    ["action_required", "CI needed action"],
    ["startup_failure", "CI failed to start"],
    // The three this repo's own history had never produced, and which the first
    // version of this classifier treated as still-running. All three are terminal
    // in the workflow-runs API, so a release that could never succeed waited out
    // the full timeout instead of reporting a failure it already knew.
    ["neutral", "CI was neutral"],
    ["skipped", "CI was skipped"],
    ["stale", "CI was stale"],
  ])("refuses to release when CI reports %s", async (conclusion) => {
    // Every one of these is terminal: none will ever become `success` for this
    // SHA, so waiting for them would burn the whole timeout on a verdict that is
    // not coming. `cancelled` is the case a newer push to main causes.
    await expect(gate({ ...green, "workflows/ci.yml": conclusion })).rejects.toMatchObject({
      stderr: expect.stringMatching(/A tag names a commit that passed/),
    });
  });

  it("refuses when E2E is red even though CI is green", async () => {
    // The specific gap this branch was rewritten for: CI green is not a release.
    await expect(gate({ ...green, "workflows/e2e.yml": "failure" })).rejects.toMatchObject({
      stderr: expect.stringMatching(/e2e\.yml .* is 'failure'/s),
    });
  });

  it.each(["running", "not-started", "none", "unreadable"])(
    "waits rather than releasing when a verdict is %s",
    async (verdict) => {
      // None of these is a pass and none is a terminal failure, so the gate waits
      // — and with a zero timeout that surfaces as a timeout, not a release.
      await expect(gate({ ...green, "workflows/e2e.yml": verdict })).rejects.toMatchObject({
        stderr: expect.stringMatching(/no version was spent/),
      });
    },
  );

  it("treats every documented terminal conclusion as terminal, not the ones seen so far", async () => {
    // The list is enumerated rather than "anything that is not success", because
    // the safe default for a conclusion nobody has seen yet is to stop and not cut
    // a tag. A negated check would silently promote a new GitHub conclusion to
    // "keep waiting", which is the failure this whole script exists to prevent.
    const documented = [
      "action_required",
      "cancelled",
      "failure",
      "neutral",
      "skipped",
      "stale",
      "startup_failure",
      "timed_out",
    ];
    for (const conclusion of documented) {
      await expect(gate({ ...green, "workflows/ci.yml": conclusion })).rejects.toMatchObject({
        stderr: expect.stringMatching(/A tag names a commit that passed/),
      });
    }
  });

  it("treats an API error as unknown rather than as a red commit", async () => {
    // An unreachable API is not evidence about the commit. Failing the release
    // here would spend a version for a network problem, and the timeout already
    // handles it with an honest message.
    await expect(gate({ ...green, "workflows/ci.yml": "error" })).rejects.toMatchObject({
      stderr: expect.stringMatching(/unreadable/),
    });
  });

  it("requires CI and E2E to have run on main, not merely to exist for the commit", async () => {
    // The filter the stub cannot see is asserted in the release-workflow describe
    // above; what this proves is that a verdict with no matching run at all is
    // `not-started`, which is a wait and never a pass.
    await expect(gate({ "workflows/ci.yml": "success" })).rejects.toMatchObject({
      stderr: expect.stringMatching(/no version was spent/),
    });
  });

  it("names the commit in a timeout, and never reports one as spent", async () => {
    // A timeout is not a failed release: nothing was cut, so the message must not
    // tell the operator to take the next version number.
    await expect(gate({ ...green, "workflows/e2e.yml": "running" })).rejects.toMatchObject({
      stderr: expect.stringMatching(new RegExp(SHA)),
    });
  });

  it("rejects a SHA that is not a commit hash", async () => {
    await expect(execFileAsync(script, ["main"])).rejects.toMatchObject({
      stderr: expect.stringMatching(/not a commit SHA/),
    });
  });

  it("requires exactly one argument and a repository", async () => {
    await expect(execFileAsync(script, [])).rejects.toMatchObject({
      stderr: expect.stringMatching(/expected exactly one argument, got 0/),
    });
    // The count in the message is the SCRIPT's, not the usage function's own.
    await expect(execFileAsync(script, ["a", "b"])).rejects.toMatchObject({
      stderr: expect.stringMatching(/expected exactly one argument, got 2/),
    });
    await expect(
      execFileAsync(script, [SHA], { env: { ...process.env, GITHUB_REPOSITORY: "" } }),
    ).rejects.toMatchObject({
      stderr: expect.stringMatching(/GITHUB_REPOSITORY must be OWNER\/REPO/),
    });
  });
});

/**
 * One `gh` stub for the release scripts, keyed by the workflow path in the jq
 * filter and answering from a fixture. `gh` is the only thing faked — it is the
 * only thing these scripts talk to — so the scripts run for real and their own
 * logic is what is under test.
 *
 * The `*` in a fixture pattern is escaped before the comparison, because an
 * unquoted `*` on the right of `[[ == ]]` is a glob: it matches nothing, which
 * looks exactly like an API that never answers.
 */
async function withStubbedGh<T>(
  fixtures: Record<string, string>,
  run: (dir: string, env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "release-script-"));
  const rules = Object.entries(fixtures).map(([pattern, answer]) => `${pattern}\t${answer}`);
  await writeFile(
    join(dir, "gh"),
    `#!/usr/bin/env bash
# Matched against the whole command line, not one argument. The two release
# scripts put the interesting string in different places — wait-for-main-gate.sh
# filters inside its jq expression while resolve-tag-commit.sh passes the ref path
# as the URL — and a stub that assumes either position matches nothing, which
# reads as a broken script rather than a broken harness.
query="$*"
while IFS=$'\\t' read -r pat ans; do
  [[ -z "$pat" ]] && continue
  needle="\${pat//\\*/\\\\*}"
  if [[ "$query" == *"$needle"* ]]; then
    if [[ "$ans" == "FAIL" ]]; then echo "gh: API error" >&2; exit 1; fi
    printf '%s\\n' "$ans"
    exit 0
  fi
done <<< "$(cat "$GH_FIXTURE")"
echo "gh: nothing matched" >&2
exit 1
`,
  );
  await chmod(join(dir, "gh"), 0o755);
  const fixture = join(dir, "fixtures");
  await writeFile(fixture, `${rules.join("\n")}\n`);
  // The child env is built here rather than at each call site: a stub with no
  // `GH_FIXTURE` reads an empty path and reports "nothing matched", which looks
  // like a broken script rather than a broken harness.
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}`, GH_FIXTURE: fixture };
  try {
    return await run(dir, env);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("assert-tag-names.sh", () => {
  const script = join(import.meta.dirname, "../../scripts/assert-tag-names.sh");
  const COMMIT = "ccfcd40cad56ee4ce9ad199b5ea7dbee69afdb44";
  const OTHER = "51e359e2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  async function assertTag(tagResolvesTo: string, expected: string, gated?: string) {
    return withStubbedGh({ "git/ref/tags/v1.0.0": `commit ${tagResolvesTo}` }, (_dir, env) =>
      execFileAsync(
        "bash",
        [script, "arpitdalal/PocketCircle", "v1.0.0", expected, ...(gated ? [gated] : [])],
        {
          // Run from the repo root so the script's `./scripts/…` call resolves,
          // exactly as it does in a workflow's checkout.
          cwd: join(import.meta.dirname, "../.."),
          env,
        },
      ),
    );
  }

  it("passes when the tag names what the run is deploying", async () => {
    const { stdout } = await assertTag(COMMIT, COMMIT);
    expect(stdout).toContain("which is what this run deploys");
  });

  it("refuses when the tag was moved after the run started", async () => {
    // The whole reason the script exists: `github.sha` is fixed for the run, so a
    // tag naming anything else is a version whose name and its content disagree.
    await expect(assertTag(OTHER, COMMIT)).rejects.toMatchObject({
      stderr: expect.stringMatching(/was moved after the run started/),
    });
  });

  it("refuses when the run did not resolve to the commit Release gated", async () => {
    // The loop a tag-only check cannot see: the run resolved to B before the tag
    // moved back to A, so the tag agrees while the deploy does not.
    await expect(assertTag(OTHER, OTHER, COMMIT)).rejects.toMatchObject({
      stderr: expect.stringMatching(/Release gated/),
    });
  });

  it("ignores the gate check when there is no gate, as a hand-pushed tag has", async () => {
    // For a hand-pushed tag the run and the gate are the same commit by
    // construction, so asserting it would prove nothing.
    const { stdout } = await assertTag(COMMIT, COMMIT);
    expect(stdout).toContain("which is what this run deploys");
  });

  it("dereferences an annotated tag rather than comparing the tag object's SHA", async () => {
    // The ref endpoint reports the tag object for an annotated tag, which is never
    // the commit anything deploys — and every hand-pushed release tag in this
    // repo's history is annotated.
    await withStubbedGh(
      {
        "git/ref/tags/v1.0.0": `tag ${"bacffa5655555555555555555555555555555555"}`,
        "git/tags/": `commit ${COMMIT}`,
      },
      async (_dir, env) => {
        const { stdout } = await execFileAsync(
          "bash",
          [script, "arpitdalal/PocketCircle", "v1.0.0", COMMIT],
          { cwd: join(import.meta.dirname, "../.."), env },
        );
        expect(stdout).toContain("which is what this run deploys");
      },
    );
  });

  it("rejects a SHA that is not a commit hash, before touching the API", async () => {
    await expect(assertTag(COMMIT, "main")).rejects.toMatchObject({
      stderr: expect.stringMatching(/not a commit SHA/),
    });
  });
});

describe("wait-for-deploy.sh", () => {
  const script = join(import.meta.dirname, "../../scripts/wait-for-deploy.sh");
  const SHA = "ccfcd40cad56ee4ce9ad199b5ea7dbee69afdb44";
  // The `cut` job specifically: the wait only holds anything while it is in the
  // same job as the dispatch, since that is the job the `release` concurrency
  // group covers.
  const cut = (() => {
    const release = readFileSync(
      join(import.meta.dirname, "../../.github/workflows/release.yml"),
      "utf8",
    );
    const jobs = release.slice(release.indexOf("\njobs:\n"));
    const starts = [...jobs.matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)];
    return jobs.slice(starts[1].index, starts[2]?.index ?? jobs.length);
  })();

  async function waitForDeploy(verdict: string) {
    return withStubbedGh({ "workflows/deploy.yml": verdict }, (_dir, stubEnv) =>
      execFileAsync(
        "bash",
        [script, "arpitdalal/PocketCircle", ".github/workflows/deploy.yml", SHA],
        {
          // A zero timeout turns the waiting paths into a single poll, so a test
          // for "waits" asserts the wait without spending the two-hour bound.
          env: { ...stubEnv, DEPLOY_WAIT_SECONDS: "0", DEPLOY_POLL_SECONDS: "0" },
        },
      ),
    );
  }

  it("returns once the deploy succeeds", async () => {
    const { stdout } = await waitForDeploy("success");
    expect(stdout).toContain("finished successfully");
  });

  it("fails the release when the deploy does not succeed", async () => {
    // A release whose deploy failed must not read as a green run, or the next
    // release is cut believing the last one shipped.
    await expect(waitForDeploy("failure")).rejects.toMatchObject({
      stderr: expect.stringMatching(/did not ship/),
    });
  });

  it("waits rather than concluding while the deploy is still running", async () => {
    await expect(waitForDeploy("running")).rejects.toMatchObject({
      stderr: expect.stringMatching(/still 'running'/),
    });
  });

  it("waits before the dispatched run exists", async () => {
    // The dispatch is accepted before the run appears in the API, so `not-started`
    // is the normal first observation, not a failure.
    await expect(waitForDeploy("not-started")).rejects.toMatchObject({
      stderr: expect.stringMatching(/still 'not-started'/),
    });
  });

  it("treats an API error as unknown rather than as a failed deploy", async () => {
    // Refusing a release because GitHub was briefly unreachable would be a false
    // negative on the one thing this waits for.
    await expect(waitForDeploy("FAIL")).rejects.toMatchObject({
      stderr: expect.stringMatching(/still 'unreadable'/),
    });
  });

  it("is what holds the release lock open until the deploy finishes", () => {
    // The stranded-version path: the dispatch returns immediately, so without
    // this the `release` group frees while `deploy.yml`'s own `production` group
    // still has a pending run, and a third release replaces it — after the
    // second one's tag is already cut.
    const dispatch = cut.indexOf("gh workflow run deploy.yml");
    const wait = cut.indexOf("./scripts/wait-for-deploy.sh");
    expect(dispatch).toBeGreaterThan(-1);
    expect(wait).toBeGreaterThan(dispatch);
    // In the `cut` job, so the `release` concurrency group is still held while
    // the deployment runs — which is the entire reason to wait. A wait anywhere
    // else would end with the group and buy nothing.
  });

  it("rejects arguments that are not a repo, a workflow and a commit", async () => {
    const run = (args: string[]) =>
      execFileAsync("bash", [script, ...args], { cwd: join(import.meta.dirname, "../..") });
    await expect(run(["arpitdalal/PocketCircle"])).rejects.toMatchObject({
      stderr: expect.stringMatching(/exactly three arguments, got 1/),
    });
    await expect(run(["norepo", ".github/workflows/deploy.yml", SHA])).rejects.toMatchObject({
      stderr: expect.stringMatching(/OWNER\/REPO/),
    });
    await expect(run(["o/r", ".github/workflows/deploy.yml", "main"])).rejects.toMatchObject({
      stderr: expect.stringMatching(/not a commit SHA/),
    });
  });
});
