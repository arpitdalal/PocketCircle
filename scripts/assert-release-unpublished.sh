#!/usr/bin/env bash

# Assert that no previous attempt at this tag ever reached production.
#
# Whether a failed release can be re-cut under the same version is not a fact
# about git — it is a question about what the failed attempts did to production,
# and asking the operator to remember is exactly how a version number ends up
# identifying two different production states. The answer is in GitHub's own
# record of the runs.
#
# The boundary is the first step in `deploy.yml` that writes to production. Every
# step before it is read-only: validation, `pnpm validate`, both builds. That step
# — "Sync MCP Worker verification keys to Convex" — runs `convex env set` against
# the live deployment, and everything after it (the push-delivery gate, the backend
# deploy, both Workers) mutates too. Its step conclusion therefore separates "never
# touched anything" from "may have touched something", and it is queryable:
# `GET /actions/runs/{id}/attempts/{n}/jobs` reports a conclusion per step.
#
# So: the marker step `skipped` means that attempt stopped before production, and
# only if *every* attempt ever made at this tag skipped it is the version free to
# re-cut. Anything else — `success`, `failure`, `cancelled`, `timed_out` — means it
# ran, and the version is spent.
#
# "Every attempt", not "the most recent one", is the whole safety property. A tag
# accumulates attempts in two ordinary ways, and the newest one is not a reliable
# witness in either:
#
#   * Re-running a failed job. GitHub re-runs the *same* run with an incremented
#     `run_attempt`. If attempt 1 reached the marker and attempt 2 was cancelled
#     before it, the latest attempt reads `skipped` while production was already
#     rewritten by attempt 1.
#   * A tag re-cut by hand, or a re-dispatch, creating a second run for the same
#     tag name. The newest run may have failed early while an older one deployed.
#
# Judging the newest attempt alone would therefore report "never deployed" for a
# version that is live in production — the exact failure this script exists to
# catch, introduced by the very step meant to catch it.
#
# The failure direction is the point. `failure` and `cancelled` are treated as
# "spent" because a step that started may have written before it stopped, and this
# check cannot see how far into it got: the sync step issues four `convex env set`
# commands and GitHub reports one conclusion for all of them. A run that has not
# finished is likewise treated as spent, because it may reach the marker moments
# from now. Erring toward "spent" costs a version number in a rare case; erring the
# other way would let one version number identify two production revisions, which is
# the thing this whole workflow exists to prevent.

set -euo pipefail

die() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  echo "usage: assert-release-unpublished.sh [--has-deploy-history] OWNER/REPO TAG" >&2
  die "expected two arguments, got ${1:-0}"
}

# `--has-deploy-history` answers a different question and shares the same query, so
# it is a mode on this script rather than a second script re-listing the runs.
# It reports the answer on stdout and exits 0 either way, because "no" must not be
# spelled the same way as "could not tell": the caller acts on this answer, and an
# error that looked like "no" would let a previously-cut version be re-cut.
history_only=false
if [[ "${1:-}" == "--has-deploy-history" ]]; then
  history_only=true
  shift
fi

[[ $# -eq 2 ]] || usage "$#"

repo="$1"
tag="$2"
[[ -n "$repo" && "$repo" == */* ]] || die "repo must be OWNER/REPO, got '$repo'"
[[ -n "$tag" ]] || die "tag must not be empty"

# The first step in `deploy.yml` that writes to production. A workflow cannot
# import a constant from here, so the two are kept in step by a test that asserts
# `deploy.yml` still has a step with this name — a rename fails CI rather than
# silently turning every verdict into "unknown".
readonly MARKER_STEP="Sync MCP Worker verification keys to Convex"
readonly DEPLOY_WORKFLOW="deploy.yml"

# Every run of the deploy workflow for this tag, as `id<TAB>status<TAB>attempts`.
#
# Listed by workflow and narrowed to the tag client-side, rather than passed as the
# API's `head_branch` filter: that filter matches *branch* names only, and the runs
# of interest are tag-triggered. Asking for it returns every run in the repository,
# which would then judge a re-cut of v0.8.1 by whatever v0.8.2 did. Verified against
# this repository's real runs, where `head_branch=v0.8.1` returns CI and E2E runs
# from main and only the payload's `head_branch` is correct.
#
# Deliberately not filtered to completed runs, and paginated: a tag can have more
# than the 100 most recent deploy runs, and the run that matters is the one nobody
# remembers.
runs="$(gh api \
  "repos/$repo/actions/workflows/$DEPLOY_WORKFLOW/runs?per_page=100" --paginate \
  --jq ".workflow_runs[] | select(.head_branch == \"$tag\")
         | \"\(.id)\t\(.status)\t\(.run_attempt)\"" 2>/dev/null)" ||
  die "could not list deploy runs for $tag in $repo"

if $history_only; then
  # "Has this version been cut before?" — the question the create path has to ask
  # *before* it creates a ref, because a tag that no longer exists can still have
  # been deployed. A tag is mutable until its release publishes, so a version whose
  # deploy reached production but then failed before publishing can have had its tag
  # deleted, and re-creating that name at a different commit would put one version
  # number on two production states with nothing left to contradict it.
  if [[ -z "$runs" ]]; then
    echo "none"
  else
    echo "history"
  fi
  exit 0
fi

if [[ -z "$runs" ]]; then
  # No deploy ever ran for this tag, so nothing reached production. The re-cut is
  # not even contested — there is nothing to correct.
  echo "No deploy run found for $tag, so nothing was deployed."
  exit 0
fi

# The `Deploy` job's marker-step conclusion for one attempt of one run, or the empty
# string if the job never started.
marker_for_attempt() {
  local run_id="$1" attempt="$2" steps conclusion

  steps="$(gh api \
    "repos/$repo/actions/runs/$run_id/attempts/$attempt/jobs?per_page=100" --paginate \
    --jq '.jobs[]
           | select(.name | startswith("Deploy"))
           | .steps[]
           | "\(.number)\t\(.name)\t\(.conclusion)"' 2>/dev/null)" ||
    die "could not read the steps of deploy run $run_id (attempt $attempt)"

  # No Deploy job at all means the job never started — the `verify` job failed, or
  # the run was cancelled before it — and a job that never started mutates nothing.
  # A distinct token rather than the empty string: empty is also what a *missing
  # marker* would leave, and that case must fail closed while this one is safe.
  [[ -n "$steps" ]] || { printf '%s' "not-started"; return 0; }

  # An `if` rather than `[[ ... ]] && ...`: under `set -e` the last command of the
  # loop body decides the status of the command substitution, and a `&&` chain that
  # does not match returns 1 — which killed the assignment and exited silently,
  # printing nothing. A missing marker is the one case that must explain itself, so
  # it cannot be the one case that dies without a word.
  conclusion="$(while IFS=$'\t' read -r number name step_conclusion; do
    if [[ "$name" == "$MARKER_STEP" ]]; then
      printf '%s' "$step_conclusion"
      break
    fi
  done <<< "$steps")"

  # Fail closed. The step is missing, which means that attempt ran a deploy.yml
  # without the marker in it — an older shape, or a rename that has not reached
  # this script. Reporting "unknown" as safe would be the one answer that is wrong
  # in every direction at once.
  [[ -n "$conclusion" ]] ||
    die "deploy run $run_id (attempt $attempt) has no step named '$MARKER_STEP', so whether it reached production cannot be determined from that run. Release the next version, or investigate before re-cutting."

  printf '%s' "$conclusion"
}

checked=0
while IFS=$'\t' read -r run_id status attempts; do
  # A row that cannot be read is a row whose attempts cannot be counted, and a
  # `for` loop bounded by an unreadable count runs zero times — so a malformed row
  # would skip its own inspection and report success. This script is fail-closed
  # everywhere else; a row it cannot parse has to be the same. Refused rather than
  # skipped, because skipping is what produced the bug.
  [[ -n "$run_id" && -n "$status" && -n "$attempts" ]] ||
    die "could not read a deploy run for $tag from the API (got id='$run_id' status='$status' attempts='$attempts'), so whether $tag reached production cannot be determined. Release the next version, or investigate before re-cutting."

  # `run_attempt` is 1 or more for every real run, and bash arithmetic reads an
  # empty or non-numeric value as 0 — which would silently reduce the loop below
  # to nothing. Asserted rather than assumed, because the failure it prevents is
  # the worst one available: reporting a version as never deployed when in fact
  # nothing was ever looked at.
  [[ "$attempts" =~ ^[1-9][0-9]*$ ]] ||
    die "deploy run $run_id reports '$attempts' attempts, which is not a positive count, so whether $tag reached production cannot be determined. Release the next version, or investigate before re-cutting."

  # A run that has not finished may reach the marker seconds from now, and "it has
  # not reached production yet" is not a statement about the version.
  [[ "$status" == "completed" ]] ||
    die "deploy run $run_id for $tag is still $status, so it may yet reach '$MARKER_STEP'. Wait for it to finish, or release the next version."

  for ((attempt = 1; attempt <= attempts; attempt++)); do
    conclusion="$(marker_for_attempt "$run_id" "$attempt")"
    # `not-started` is as safe as `skipped`: a job that never ran wrote nothing.
    [[ "$conclusion" == "skipped" || "$conclusion" == "not-started" ]] ||
      die "deploy run $run_id (attempt $attempt) reached '$MARKER_STEP' ($conclusion), so $tag may already have changed production. The version is spent — release the next one."
    checked=$((checked + 1))
  done
done <<< "$runs"

# Unreachable now that every row is validated to carry at least one attempt, and
# kept as the backstop for the one thing this script must never do: report a
# version as unspent having inspected nothing. Zero checks with a non-empty run
# list means the loop above did not do what it says it does.
[[ "$checked" -gt 0 ]] ||
  die "no attempt of any deploy run for $tag was inspected, so whether it reached production is unknown. Release the next version, or investigate before re-cutting."

echo "No attempt at $tag ever reached '$MARKER_STEP' ($checked checked), so it never wrote to production. $tag can be re-cut."
