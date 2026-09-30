#!/usr/bin/env bash

# Has `main` cleared this commit, for a release to be cut from it?
#
# This is the gate that stopped v0.8.1. That tag was cut by hand onto a commit
# whose own CI run on `main` had already gone red, the deploy re-ran the same
# checks, failed at step 8 of 25, and the fix shipped as v0.8.2 with v0.8.1
# stranded on a deploy that never happened (#423).
#
# The decision lives here rather than inside the workflow because a workflow is
# the one place in this repo that nothing executes. Asserting on its text proves
# the tokens are present, not that the branch they control reaches the right
# conclusion: a quoting mistake in the jq expression, an inverted condition, a
# filter that silently matches nothing, and a gate that rejects every release or
# none all look identical to a `toContain`. So the logic is a script, the
# workflow calls it, and the tests below drive the real thing with a faked `gh`.
#
# `main`'s own verdicts, waited for rather than re-run. Every push to `main`
# already runs typecheck, lint, the unit tests, both production builds, and the
# real Playwright suite against a live backend (ADR 0019) — so there is nothing
# to re-run, only something to wait for, and main is normally already green.
# Asking "did the commit this tag will name, forever, pass" is also the right
# question, where re-running would only ask whether it passes twice.
#
# Only `push` runs on `main` count, and the filter is load-bearing rather than
# tidy: both workflows also run for `pull_request`, and a commit reaches `main`
# with a SHA a PR run can share — every merge that keeps the commit identity,
# which is what a rebase or a direct promotion does. Unfiltered, the first
# CI-shaped run for that SHA wins, so a green PR run can stand in for a red
# `main` run, or for one that has not started yet. A PR run says nothing about
# `main`: it merges a synthetic merge commit and its `head_sha` is the branch tip.

set -euo pipefail

die() {
  echo "error: $*" >&2
  exit 1
}

[[ $# -eq 1 ]] || {
  echo "usage: wait-for-main-gate.sh SHA" >&2
  die "expected exactly one argument, got $#"
}

sha="$1"
[[ "$sha" =~ ^[0-9a-f]{7,40}$ ]] || die "not a commit SHA: '$sha'"

repo="${GITHUB_REPOSITORY:-}"
[[ -n "$repo" && "$repo" == */* ]] ||
  die "GITHUB_REPOSITORY must be OWNER/REPO, got '$repo'"

# Both workflows this gate reads. Named by workflow file rather than display
# name: a display name is a label someone can edit in the UI, and a rename would
# silently turn the gate into "wait for a workflow that does not exist".
readonly -a REQUIRED=(".github/workflows/ci.yml" ".github/workflows/e2e.yml")

# Bounded, because this waits on somebody else's workflow and an unbounded wait
# reads as a hang rather than as a timeout. 45 minutes is well past a normal E2E
# (about nine) and short enough that a wedged run is reported.
readonly TIMEOUT_SECONDS="${GATE_TIMEOUT_SECONDS:-2700}"
readonly POLL_SECONDS="${GATE_POLL_SECONDS:-30}"

# A verdict is one of: success, still-running, not-started, unreadable, or a
# terminal non-success. Terminal means the run has finished and will never become
# `success` for this SHA, so waiting for it only spends the timeout.
#
# The list is every terminal conclusion the workflow-runs API documents, not the
# ones this repo has happened to produce: `action_required`, `cancelled`,
# `failure`, `neutral`, `skipped`, `stale`, `timed_out`, `startup_failure`. An
# earlier version listed only the five this repo's own history contains, and the
# other three — a skipped matrix job, a stale check run — were classified as
# still-running, so a release that could never succeed sat out the full 45
# minutes before reporting a failure it already knew. Enumerated rather than
# negated, because the safe default for an unlisted conclusion is to stop and not
# cut a tag, not to keep waiting.
#
# `cancelled` is the ordinary case: it is what a newer push to `main` does to a
# superseded run.
is_terminal_failure() {
  case "$1" in
    action_required | cancelled | failure | neutral | skipped | stale |       startup_failure | timed_out | "") return 0 ;;
    *) return 1 ;;
  esac
}

# The most recent matching run for one workflow, as a single word. `head_sha`,
# `event` and `head_branch` are all filters rather than post-hoc checks, so a
# PR run for the same commit is never in the set to be chosen from.
verdict_for() {
  local path="$1" answer
  answer="$(gh api "repos/$repo/actions/runs?head_sha=$sha&per_page=100" \
    --jq ".workflow_runs
           | map(select(.path == \"$path\"
                        and .event == \"push\"
                        and .head_branch == \"main\"))
           | first
           | if . == null then \"not-started\"
             elif .status == \"completed\" then (.conclusion // \"none\")
             else \"running\" end" 2>/dev/null)" || {
    # An API error is not a verdict. Reporting it as "unreadable" keeps it on the
    # waiting path, where it times out with an honest message, instead of
    # failing the release for a reason that has nothing to do with the commit.
    echo "unreadable"
    return 0
  }
  [[ -n "$answer" ]] || answer="unreadable"
  echo "$answer"
}

deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))

while :; do
  verdicts=()
  ready=true
  for path in "${REQUIRED[@]}"; do
    answer="$(verdict_for "$path")"
    verdicts+=("$path=$answer")
    if is_terminal_failure "$answer"; then
      # The case this script exists for. A red commit that got tagged is a
      # version spent; caught here it is nothing, and the same version number is
      # still free to use on the fix.
      die "$path on $sha is '$answer'. A tag names a commit that passed, and this one did not. Fix it on main, then re-run the release with the same version."
    fi
    [[ "$answer" == "success" ]] || ready=false
  done

  if [[ "$ready" == true ]]; then
    echo "main's checks are green on $sha: ${verdicts[*]}"
    exit 0
  fi

  if (( $(date +%s) >= deadline )); then
    # Not a failed release: nothing was cut and no version was spent, so the
    # message says to re-run rather than to use a different number.
    die "gave up after ${TIMEOUT_SECONDS}s waiting for main's checks on $sha (${verdicts[*]}). Nothing was cut and no version was spent — re-run once they finish."
  fi

  echo "waiting on main's checks for $sha: ${verdicts[*]}"
  sleep "$POLL_SECONDS"
done
