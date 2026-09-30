#!/usr/bin/env bash

# Assert that this version is not already behind what has run in production.
#
# A GitHub Release is published only after a deploy has succeeded, so published
# releases are a *sufficient* record of what production has run — but not a complete
# one, and the gap is the case that matters. A deploy that reached the first
# production mutation and then failed before publishing has changed production and
# published nothing. Reading only the release list would report the previous version
# as current, and releasing it would move production backwards while the newer
# version sits in production unpublished.
#
# So the record used here is the deploy runs themselves, and a version counts as
# having been in production when any attempt of any of its runs reached that
# mutation. That subsumes the published releases — a published release implies a
# successful deploy, which implies the mutation ran — so one signal answers both
# cases and there is no second list to keep in step.
#
# The recovery table in the README tells an operator whose deploy failed before the
# first production mutation to re-run that deploy with the same version. That is
# right while nothing newer has shipped. Once v0.8.5 has been in production, re-running
# v0.8.4's deploy is not a recovery — it moves production back to older code and
# publishes the older version after the newer one. The tag checks cannot catch it:
# they prove the tag still names the commit being deployed, not that the commit is
# the newest one production has seen.
#
# Deliberately not the same question as `assert-release-unpublished.sh`, which asks
# whether *this* version ever reached production. This asks whether production has
# moved past it, which is the other half of "is this version still current", and the
# answer can be yes for a version that never deployed anything at all.
#
# Both lists are paginated to the end rather than capped: a truncated history would
# report the wrong newest version, and "we only looked at the first hundred" is not a
# safe way to decide whether production has moved.
#
# Fails closed. An unreadable list means the ordering is unknown, and an unknown
# ordering is not evidence that this version is current.

set -euo pipefail

die() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  echo "usage: assert-release-not-superseded.sh OWNER/REPO VERSION" >&2
  die "expected exactly two arguments, got ${1:-0}"
}

[[ $# -eq 2 ]] || usage "$#"

repo="$1"
version="$2"
[[ -n "$repo" && "$repo" == */* ]] || die "repo must be OWNER/REPO, got '$repo'"
[[ -n "$version" ]] || die "version must not be empty"

# Only plain `vMAJOR.MINOR.PATCH` names are ordered. A pre-release or a
# hand-invented tag is not something this script can place on a line, and guessing
# its position would be a way to refuse a legitimate release.
readonly VERSION_PATTERN='^v[0-9]+\.[0-9]+\.[0-9]+$'
[[ "$version" =~ $VERSION_PATTERN ]] ||
  die "version '$version' is not vMAJOR.MINOR.PATCH, so it cannot be ordered against what has shipped"

readonly MARKER_STEP="Sync MCP Worker verification keys to Convex"
readonly DEPLOY_WORKFLOW="deploy.yml"
readonly HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Is this tag strictly newer than the version being released? `sort -V` is what
# makes the answer correct rather than nearly correct: lexicographic order puts
# v0.8.10 before v0.8.3, and a guard comparing versions as strings would wave
# through exactly the case it exists for.
newer_than() {
  [[ "$1" =~ $VERSION_PATTERN ]] || return 1
  [[ "$1" != "$version" ]] || return 1
  [[ "$(printf '%s\n%s\n' "$version" "$1" | sort -V | tail -1)" == "$1" ]]
}

# Every version this repository has ever deployed, from the deploy runs rather than
# from the releases, so a version that reached production without publishing is
# included. `head_branch` is the tag for a tag-triggered run and for one dispatched
# on a tag; narrowing happens here rather than through the API's `head_branch`
# filter, which matches branch names only and would return the whole repository's
# runs. Paginated, because the run that matters is not necessarily a recent one.
deployed_tags="$(gh api \
  "repos/$repo/actions/workflows/$DEPLOY_WORKFLOW/runs?per_page=100" --paginate \
  --jq '.workflow_runs[].head_branch' 2>/dev/null)" ||
  die "could not list deploy runs in $repo, so whether $version is behind production is unknown"

# Candidates strictly newer than this version, deduplicated. Sorted last-to-first so
# the first one that turns out to have been in production is also the newest such
# version, and therefore the one worth naming in the error.
candidates="$(printf '%s\n' "$deployed_tags" | grep -E "$VERSION_PATTERN" | sort -u -V -r || true)"

newest_superseding=""
while read -r candidate; do
  [[ -n "$candidate" ]] || continue
  newer_than "$candidate" || continue

  # Delegate the "did this one reach production" question rather than re-deriving
  # it: that decision, its marker step, and its fail-closed rules all live in one
  # script, and a second copy here is a second thing to keep correct. A non-zero exit
  # means spent, unreachable, or in flight — all three are reasons to refuse, so the
  # reasons are not distinguished and the output is discarded.
  if ! "$HERE/assert-release-unpublished.sh" "$repo" "$candidate" >/dev/null 2>&1; then
    newest_superseding="$candidate"
    break
  fi
done <<< "$candidates"

if [[ -n "$newest_superseding" ]]; then
  die "$newest_superseding has already been in production, so $version is behind it. Deploying $version would move production back to older code and publish it after $newest_superseding. Release the next version, or roll back deliberately by deploying $newest_superseding."
fi

echo "No version after $version has been in production, so $version is current."
