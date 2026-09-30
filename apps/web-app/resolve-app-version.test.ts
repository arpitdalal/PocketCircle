import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";
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

const repository = join(import.meta.dirname, "../..");
const sha = "a".repeat(40);
const oldSha = "b".repeat(40);

function workflow(name: string) {
  return parseDocument(readFileSync(join(repository, `.github/workflows/${name}.yml`), "utf8"));
}

function workflowSteps(name: string, job: string) {
  const steps = workflow(name).getIn(["jobs", job, "steps"], true);
  if (!isSeq(steps)) throw new Error("Expected workflow steps");
  return steps.items.map((step) => {
    if (!isMap(step)) throw new Error("Expected workflow step");
    return step;
  });
}

function mapping(value: unknown) {
  if (!isMap(value)) throw new Error("Expected mapping");
  return value.toJSON();
}

function scalar(value: unknown) {
  if (!isScalar(value)) throw new Error("Expected scalar");
  return value.value;
}

function draft(version = "v1.0.0", phase = "prepared", commit = oldSha) {
  return {
    id: 1,
    tag_name: version,
    draft: true,
    target_commitish: "main",
    body: `<!-- pocketcircle-release:${phase} ${commit} -->`,
  };
}

// Only gh, the network boundary, is doubled. Every release decision runs in the real CLI.
async function releaseCommand(
  command: string,
  options: {
    releases?: ReturnType<typeof draft>[];
    tag?: string;
    annotated?: boolean;
    runs?: object[];
    fail?: string;
    env?: Record<string, string>;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "release-cli-"));
  const statePath = join(dir, "state.json");
  await writeFile(
    statePath,
    JSON.stringify({
      releases: options.releases ?? [],
      tag: options.tag,
      annotated: options.annotated,
      runs: options.runs ?? [],
      calls: [],
      fail: options.fail,
    }),
  );
  await writeFile(
    join(dir, "gh"),
    `#!${process.execPath}
const fs = require("node:fs");
const path = process.env.RELEASE_TEST_STATE;
const state = JSON.parse(fs.readFileSync(path, "utf8"));
const args = process.argv.slice(2);
state.calls.push(args);
fs.writeFileSync(path, JSON.stringify(state));
if (state.fail && args.join(" ").includes(state.fail)) process.exit(1);
let answer;
const url = args[1]?.replace("repos/arpitdalal/PocketCircle/", "");
const method = args.includes("--method") ? args[args.indexOf("--method") + 1] : "GET";
const fields = Object.fromEntries(args.filter((arg, i) => ["-f", "-F"].includes(args[i-1])).map(arg => {
  const at = arg.indexOf("="); return [arg.slice(0, at), arg.slice(at+1)];
}));
if (args[0] === "workflow") answer = {};
else if (url?.startsWith("actions/runs?")) answer = [{workflow_runs: state.runs}];
else if (url === "releases?per_page=100") answer = [state.releases];
else if (url?.startsWith("git/matching-refs/tags/")) answer = state.tag ? [{ref:"refs/tags/v1.0.0", object:{type:state.annotated ? "tag":"commit", sha:state.annotated ? "c".repeat(40):state.tag}}] : [];
else if (url?.startsWith("git/tags/")) answer = {object:{type:"commit",sha:state.tag}};
else if (url === "git/refs" || url?.startsWith("git/refs/tags/")) {state.tag=fields.sha;answer={};}
else if (url === "releases" && method === "POST") {
  answer={id:state.releases.length+1,tag_name:fields.tag_name,draft:true,target_commitish:"main",body:fields.body};state.releases.push(answer);
} else if (url?.startsWith("releases/") && method === "PATCH") {
  answer=state.releases.find(r=>r.id===Number(url.split("/")[1]));delete fields.target_commitish;Object.assign(answer, fields);
} else { console.error("Unhandled gh command", args);process.exit(2); }
fs.writeFileSync(path, JSON.stringify(state));
process.stdout.write(JSON.stringify(answer));
`,
  );
  await chmod(join(dir, "gh"), 0o755);
  try {
    let failure = "";
    try {
      await execFileAsync(process.execPath, [join(repository, "scripts/release.mjs"), command], {
        cwd: repository,
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          RELEASE_TEST_STATE: statePath,
          GH_REPO: "arpitdalal/PocketCircle",
          VERSION: "v1.0.0",
          SHA: sha,
          GITHUB_REF: command === "gate" ? "refs/heads/main" : "refs/tags/v1.0.0",
          GATE_TIMEOUT_SECONDS: "0",
          ...options.env,
        },
      });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      failure = error.message;
    }
    const state: unknown = JSON.parse(await readFile(statePath, "utf8"));
    return { failure, state };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("release safety", () => {
  it("wires gate, tag changes and production writes under the required locks", () => {
    const release = workflow("release");
    const deploy = workflow("deploy");
    expect(scalar(release.getIn(["jobs", "cut", "needs"], true))).toBe("gate");
    expect(mapping(release.getIn(["jobs", "gate", "permissions"]))).toEqual({
      contents: "read",
      actions: "read",
    });
    expect(mapping(release.getIn(["jobs", "cut", "permissions"]))).toEqual({
      contents: "write",
      actions: "write",
    });
    expect(mapping(release.getIn(["jobs", "cut", "concurrency"]))).toEqual(
      mapping(deploy.get("concurrency")),
    );
    expect(mapping(deploy.get("concurrency"))).toEqual({
      group: "production",
      "cancel-in-progress": false,
      queue: "max",
    });
    expect(deploy.getIn(["jobs", "deploy", "permissions", "contents"])).toBe("write");
    const steps = workflowSteps("deploy", "deploy");
    const mark = steps.findIndex((step) => step.get("run") === "node scripts/release.mjs mark");
    const mutation = steps.findIndex(
      (step) => step.get("name") === "Sync MCP Worker verification keys to Convex",
    );
    expect(mark).toBeGreaterThan(-1);
    expect(mark).toBe(mutation - 1);
    expect(
      steps.find((step) => step.get("run") === "node scripts/release.mjs check"),
    ).toBeDefined();
    for (const name of ["release", "deploy"]) {
      const jobs = workflow(name).get("jobs", true);
      if (!isMap(jobs)) throw new Error("Expected jobs");
      for (const pair of jobs.items) {
        const job = scalar(pair.key);
        if (typeof job !== "string") throw new Error("Expected job name");
        if (isMap(pair.value) && pair.value.has("steps")) {
          for (const step of workflowSteps(name, job)) {
            const run = step.get("run");
            if (typeof run === "string") expect(run).not.toMatch(/\$\{\{ inputs\./);
            if (step.get("uses") === "actions/checkout@v6") {
              expect(step.getIn(["with", "ref"])).toBe("$" + "{{ github.sha }}");
            }
          }
        }
      }
    }
  });

  it("cuts a fresh tag, records a prepared draft, and dispatches the gated SHA", async () => {
    const result = await releaseCommand("cut");
    expect(result.failure).toBe("");
    expect(result.state).toMatchObject({ tag: sha, releases: [draft("v1.0.0", "prepared", sha)] });
    expect(result.state).toHaveProperty(
      "calls",
      expect.arrayContaining([
        [
          "workflow",
          "run",
          "deploy.yml",
          "--repo",
          "arpitdalal/PocketCircle",
          "--ref",
          "v1.0.0",
          "-f",
          `gate_sha=${sha}`,
        ],
      ]),
    );
  });

  it("moves only prepared tags, with explicit opt-in", async () => {
    const options = { tag: oldSha, releases: [draft()] };
    expect((await releaseCommand("cut", options)).failure).toMatch(/replace_unreleased_tag/);
    const result = await releaseCommand("cut", {
      ...options,
      env: { REPLACE_UNRELEASED_TAG: "true" },
    });
    expect(result.failure).toBe("");
    expect(result.state).toMatchObject({ tag: sha, releases: [draft("v1.0.0", "prepared", sha)] });
  });

  it("records a spent marker before writes and permits retries only at the same SHA", async () => {
    const result = await releaseCommand("mark", {
      tag: sha,
      releases: [draft("v1.0.0", "prepared", sha)],
    });
    expect(result.failure).toBe("");
    expect(result.state).toMatchObject({ releases: [draft("v1.0.0", "spent", sha)] });
    expect(
      (await releaseCommand("mark", { tag: sha, releases: [draft("v1.0.0", "spent", sha)] }))
        .failure,
    ).toBe("");
    expect(
      (
        await releaseCommand("cut", {
          tag: oldSha,
          releases: [draft("v1.0.0", "spent")],
          env: { REPLACE_UNRELEASED_TAG: "true" },
        })
      ).failure,
    ).toMatch(/touched production/);
  });

  it("cannot erase a spent version by deleting its tag or Actions history", async () => {
    const result = await releaseCommand("cut", {
      releases: [draft("v1.0.0", "spent")],
      env: { REPLACE_UNRELEASED_TAG: "true" },
    });
    expect(result.failure).toMatch(/touched production/);
    expect(result.state).not.toHaveProperty("tag");
  });

  it("requires opt-in to recreate a prepared version at a different SHA", async () => {
    expect((await releaseCommand("cut", { releases: [draft()] })).failure).toMatch(
      /replace_unreleased_tag/,
    );
    expect(
      (
        await releaseCommand("cut", {
          releases: [draft()],
          env: { REPLACE_UNRELEASED_TAG: "true" },
        })
      ).failure,
    ).toBe("");
  });

  it("refuses opaque drafts and stale publication retries", async () => {
    expect(
      (
        await releaseCommand("cut", {
          tag: sha,
          releases: [{ ...draft(), body: "Unknown deployment state" }],
        })
      ).failure,
    ).toMatch(/touched production/);
    expect(
      (
        await releaseCommand("assert-tag", {
          tag: sha,
          releases: [draft("v1.0.10", "spent")],
        })
      ).failure,
    ).toMatch(/superseded/);
  });

  it("refuses unknown legacy tag corrections and conservatively records same-SHA retries", async () => {
    expect(
      (await releaseCommand("cut", { tag: oldSha, env: { REPLACE_UNRELEASED_TAG: "true" } }))
        .failure,
    ).toMatch(/durable proof/);
    const result = await releaseCommand("cut", { tag: sha });
    expect(result.failure).toBe("");
    expect(result.state).toMatchObject({ releases: [draft("v1.0.0", "spent", sha)] });
  });

  it.each(["cut", "check", "mark"])(
    "%s refuses published and numerically newer spent versions",
    async (command) => {
      for (const release of [
        { ...draft("v1.0.0", "spent", sha), draft: false },
        draft("v1.0.10", "spent", sha),
      ]) {
        const result = await releaseCommand(command, { tag: sha, releases: [release] });
        expect(result.failure).toMatch(/already published|superseded/);
        expect(result.state).toMatchObject({ releases: [release] });
      }
      expect(
        (await releaseCommand(command, { tag: sha, releases: [draft("v1.0.10", "prepared", sha)] }))
          .failure,
      ).toBe("");
    },
  );

  it.each(["check", "mark", "assert-tag"])(
    "%s rejects moved tags and mismatched dispatch SHA",
    async (command) => {
      expect((await releaseCommand(command, { tag: oldSha })).failure).toMatch(/no longer names/);
      expect(
        (await releaseCommand(command, { tag: sha, env: { GATE_SHA: oldSha } })).failure,
      ).toMatch(/gated SHA/);
      expect((await releaseCommand(command, { tag: sha, annotated: true })).failure).toBe("");
    },
  );

  it.each(["cut", "mark"])("%s stops on unreadable releases", async (command) => {
    const result = await releaseCommand(command, { tag: sha, fail: "releases?" });
    expect(result.failure).not.toBe("");
    expect(result.state).toMatchObject({ tag: sha, releases: [] });
  });

  it("never dispatches after tag or draft creation fails", async () => {
    for (const fail of ["git/refs", "draft=true"]) {
      const result = await releaseCommand("cut", { fail });
      expect(result.failure).not.toBe("");
      expect(result.state).not.toHaveProperty(
        "calls",
        expect.arrayContaining([expect.arrayContaining(["workflow"])]),
      );
    }
  });

  const run = (path: string, conclusion = "success", id = 1) => ({
    id,
    path,
    head_sha: sha,
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion,
  });
  const ci = ".github/workflows/ci.yml";
  const e2e = ".github/workflows/e2e.yml";

  it("gates both exact-SHA main push workflows, ignoring PR and wrong-SHA verdicts", async () => {
    expect(
      (
        await releaseCommand("gate", {
          runs: [run(ci), run(e2e), { ...run(ci, "failure", 9), event: "pull_request" }],
        })
      ).failure,
    ).toBe("");
    for (const bad of [
      { ...run(e2e), event: "pull_request" },
      { ...run(e2e), head_sha: oldSha },
      { ...run(e2e), head_branch: "other" },
      { ...run(e2e), status: "in_progress" },
    ]) {
      expect((await releaseCommand("gate", { runs: [run(ci), bad] })).failure).toMatch(/Timed out/);
    }
  });

  it.each([
    "failure",
    "cancelled",
    "neutral",
    "skipped",
    "timed_out",
    "action_required",
    "stale",
    "startup_failure",
    null,
  ])("refuses terminal E2E conclusion %s", async (conclusion) => {
    expect(
      (await releaseCommand("gate", { runs: [run(ci), { ...run(e2e), conclusion }] })).failure,
    ).toMatch(/failed on/);
  });

  it("uses the latest run and refuses non-main dispatches", async () => {
    expect(
      (await releaseCommand("gate", { runs: [run(ci), run(e2e), run(ci, "failure", 2)] })).failure,
    ).toMatch(/failed on/);
    expect(
      (await releaseCommand("gate", { env: { GITHUB_REF: "refs/heads/stale" } })).failure,
    ).toMatch(/from main/);
  });
});
