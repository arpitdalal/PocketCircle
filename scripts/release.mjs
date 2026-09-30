import { execFileSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";

const [command] = process.argv.slice(2);
const { GH_REPO: repo, VERSION: version, SHA: sha, GATE_SHA: gated } = process.env;
const versionPattern = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

requireValue(/^[\w.-]+\/[\w.-]+$/.test(repo ?? ""), "GH_REPO must be OWNER/REPO");
requireValue(/^[0-9a-f]{40}$/.test(sha ?? ""), "SHA must be a full commit SHA");
if (command !== "gate")
  requireValue(versionPattern.test(version ?? ""), "VERSION must be vMAJOR.MINOR.PATCH");

function gh(...args) {
  return execFileSync("gh", args, { encoding: "utf8", timeout: 60_000 }).trim();
}

function api(path, ...args) {
  return JSON.parse(gh("api", `repos/${repo}/${path}`, ...args));
}

function list(path, field) {
  const pages = api(
    `${path}${path.includes("?") ? "&" : "?"}per_page=100`,
    "--paginate",
    "--slurp",
  );
  requireValue(Array.isArray(pages), "Invalid paginated API response");
  return pages.flatMap((page) => {
    const rows = field ? page[field] : page;
    requireValue(Array.isArray(rows), "Invalid API list");
    return rows;
  });
}

async function gate() {
  requireValue(process.env.GITHUB_REF === "refs/heads/main", "Dispatch Release from main");
  const deadline = Date.now() + Number(process.env.GATE_TIMEOUT_SECONDS ?? 2700) * 1000;
  while (true) {
    const runs = list(`actions/runs?head_sha=${sha}`, "workflow_runs");
    let ready = true;
    for (const path of [".github/workflows/ci.yml", ".github/workflows/e2e.yml"]) {
      const run = runs
        .filter(
          (r) =>
            r.path === path && r.head_sha === sha && r.event === "push" && r.head_branch === "main",
        )
        .sort((a, b) => b.id - a.id)[0];
      if (run?.status === "completed") {
        requireValue(run.conclusion === "success", `${path} failed on ${sha}: ${run.conclusion}`);
      } else ready = false;
    }
    if (ready) return;
    requireValue(
      Date.now() < deadline,
      `Timed out waiting for main CI/E2E on ${sha}. No tag was cut.`,
    );
    await setTimeout(Number(process.env.GATE_POLL_SECONDS ?? 30) * 1000);
  }
}

function newer(candidate) {
  const parts = candidate.match(versionPattern)?.slice(1).map(BigInt);
  if (!parts) return false;
  const current = version.match(versionPattern).slice(1).map(BigInt);
  const index = parts.findIndex((part, i) => part !== current[i]);
  return index >= 0 && parts[index] > current[index];
}

function releases() {
  const rows = list("releases");
  for (const row of rows) {
    requireValue(
      Number.isSafeInteger(row.id) &&
        typeof row.tag_name === "string" &&
        typeof row.draft === "boolean" &&
        (row.body === null || typeof row.body === "string") &&
        typeof row.target_commitish === "string",
      "Invalid release record",
    );
  }
  return rows;
}

function state(release) {
  const match = release?.body?.match(
    /^<!-- pocketcircle-release:(prepared|spent) ([0-9a-f]{40}) -->$/,
  );
  return match ? { phase: match[1], sha: match[2] } : undefined;
}

function marker(phase) {
  return `<!-- pocketcircle-release:${phase} ${sha} -->`;
}

function assertNotSuperseded(rows) {
  // Prepared drafts haven't touched production. All other drafts are conservative spent markers.
  const newerRelease = rows.find(
    (row) => newer(row.tag_name) && (!row.draft || state(row)?.phase !== "prepared"),
  );
  requireValue(
    !newerRelease,
    `${version} is superseded by ${newerRelease?.tag_name}. Use a newer version, including for rollback.`,
  );
}

function currentRelease(rows) {
  assertNotSuperseded(rows);
  const release = rows.find((row) => row.tag_name === version);
  requireValue(!release || release.draft, `${version} is already published. Use a new version.`);
  return release;
}

function tagCommit() {
  const refs = api(`git/matching-refs/tags/${version}`);
  requireValue(Array.isArray(refs), "Invalid tag list");
  let object = refs.find((ref) => ref.ref === `refs/tags/${version}`)?.object;
  if (!object) return;
  for (let depth = 0; depth < 10; depth++) {
    requireValue(/^[0-9a-f]{40}$/.test(object.sha), "Invalid tag object SHA");
    if (object.type === "commit") return object.sha;
    requireValue(object.type === "tag", "Release tag must resolve to a commit");
    object = api(`git/tags/${object.sha}`).object;
  }
  throw new Error("Release tag nesting exceeds 10 objects");
}

function assertTag() {
  requireValue(!gated || gated === sha, "Dispatch SHA differs from the gated SHA");
  requireValue(tagCommit() === sha, "Release tag no longer names this run's SHA");
}

function editDraft(release, phase) {
  api(
    `releases/${release.id}`,
    "--method",
    "PATCH",
    "-f",
    `body=${marker(phase)}`,
    "-f",
    `target_commitish=${sha}`,
  );
}

function createDraft(phase) {
  return api(
    "releases",
    "--method",
    "POST",
    "-f",
    `tag_name=${version}`,
    "-f",
    `target_commitish=${sha}`,
    "-f",
    `name=${version}`,
    "-f",
    `body=${marker(phase)}`,
    "-F",
    "draft=true",
  );
}

function cut() {
  const release = currentRelease(releases());
  const existing = tagCommit();
  if (release) {
    requireValue(
      state(release)?.sha === sha || state(release)?.phase === "prepared",
      "This version may have touched production at a different SHA. Use a new version.",
    );
  }
  if ((existing && existing !== sha) || (release && state(release)?.sha !== sha)) {
    requireValue(
      release && state(release)?.phase === "prepared",
      "No durable proof this tag is unused. Use a new version.",
    );
    requireValue(
      process.env.REPLACE_UNRELEASED_TAG === "true",
      "Set replace_unreleased_tag=true to move an unused tag",
    );
  }
  if (existing && existing !== sha) {
    // Atomic ref update avoids a delete/recreate gap.
    api(`git/refs/tags/${version}`, "--method", "PATCH", "-f", `sha=${sha}`, "-F", "force=true");
  } else if (!existing) {
    api("git/refs", "--method", "POST", "-f", `ref=refs/tags/${version}`, "-f", `sha=${sha}`);
  }
  if (!release) {
    // An unmanaged pre-existing tag has no proof of pre-production failure.
    createDraft(existing ? "spent" : "prepared");
  } else if (state(release)?.phase === "prepared") editDraft(release, "prepared");
  assertTag();
  gh("workflow", "run", "deploy.yml", "--repo", repo, "--ref", version, "-f", `gate_sha=${sha}`);
}

function check() {
  requireValue(process.env.GITHUB_REF === `refs/tags/${version}`, "Deploy from a version tag");
  const release = currentRelease(releases());
  requireValue(!release || state(release)?.sha === sha, "Draft release belongs to another SHA");
  assertTag();
  return release;
}

try {
  switch (command) {
    case "gate":
      await gate();
      break;
    case "cut":
      cut();
      break;
    case "check":
      check();
      break;
    case "mark": {
      const release = check();
      // Write durable state BEFORE any production mutation. Never delete this draft on failure.
      if (release) editDraft(release, "spent");
      else createDraft("spent");
      break;
    }
    case "assert-tag":
      assertNotSuperseded(releases());
      assertTag();
      break;
    default:
      throw new Error(`Unknown release command: ${command}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
