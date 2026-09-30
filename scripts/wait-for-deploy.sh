#!/usr/bin/env bash

# Hold the release open until the deployment it dispatched has finished.
#
# `gh workflow run` returns as soon as the dispatch is accepted, so without this
# the Release workflow's own run ends and its `release` concurrency group is
# released while the production run is still going. `deploy.yml` serializes on its
# own `production` group, and GitHub allows one running and one pending run there,
# replacing a pending run when a third arrives. So:
#
#   A deploys.  B's tag is cut, B's deploy is queued behind A, B's Release ends.
#   C's tag is cut, C's deploy arrives and REPLACES B's pending deploy.
#
# B's tag exists, B never deploys, and B never publishes. That is the stranded
# version this whole workflow exists to prevent, reached by releasing twice in a
# row rather than by failing once.
#
# So the Release workflow waits for its own deployment to reach a terminal state
# before it ends, which keeps the `release` group held for the whole release and
# makes the next one queue rather than collide. The verdict is reported and
# propagated: a release whose deploy failed should not read as a green run.

set -euo pipefail

die() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  echo "usage: wait-for-deploy.sh OWNER/REPO WORKFLOW_PATH SHA" >&2
  die "expected exactly three arguments, got ${1:-0}"
}

[[ $# -eq 3 ]] || usage "$#"

repo="$1"
workflow_path="$2"
sha="$3"

[[ -n "$repo" && "$repo" == */* ]] || die "repo must be OWNER/REPO, got '$repo'"
[[ -n "$workflow_path" ]] || die "workflow path must not be empty"
[[ "$sha" =~ ^[0-9a-f]{7,40}$ ]] || die "not a commit SHA: '$sha'"

# Bounded, because this waits on a run that can hang. Comfortably longer than a
# deploy: the production run spends ~9 minutes in E2E before it starts deploying
# and then verifies three origins against live traffic, several of which retry.
readonly TIMEOUT_SECONDS="${DEPLOY_WAIT_SECONDS:-7200}"
readonly POLL_SECONDS="${DEPLOY_POLL_SECONDS:-30}"

# The dispatched run only. `workflow_dispatch` is the discriminator: the same
# commit and the same workflow are what a hand-pushed tag would produce, and
# waiting on somebody else's run would report a verdict about a different
# release.
status_for() {
  gh api "repos/$repo/actions/runs?head_sha=$sha&event=workflow_dispatch&per_page=100" \
    --jq ".workflow_runs
           | map(select(.path == \"$workflow_path\"))
           | first
           | if . == null then \"not-started\"
             elif .status == \"completed\" then (.conclusion // \"none\")
             else \"running\" end" 2>/dev/null || echo "unreadable"
}

is_terminal() {
  case "$1" in
    success | action_required | cancelled | failure | neutral | skipped | stale | \
      startup_failure | timed_out | none | "") return 0 ;;
    *) return 1 ;;
  esac
}

deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))

while :; do
  state="$(status_for)"
  if is_terminal "$state"; then
    if [[ "$state" == "success" ]]; then
      echo "Deploy finished successfully."
      exit 0
    fi
    # A deploy that is not green is a release that did not ship, and saying so
    # here is what stops a red deployment from reading as a green release. The
    # version may or may not be spent — the README's recovery table is the
    # authority on that, and it depends on how far the deploy got.
    die "Deploy finished '$state'. This release did not ship. Re-run the deploy against the same tag if it failed before the first production write; otherwise the version is spent and the changelog should say why."
  fi
  if (( $(date +%s) >= deadline )); then
    # The lock is released either way, so this cannot be a wait-forever. It is
    # reported as a failure because a release whose deploy is still running after
    # two hours is not something to call green.
    die "Deploy is still '$state' after ${TIMEOUT_SECONDS}s. The release lock is being released with the deployment unfinished — check the deploy run before releasing again."
  fi
  echo "waiting for the deploy to finish: $state"
  sleep "$POLL_SECONDS"
done
