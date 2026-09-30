#!/usr/bin/env bash

# Refuse to continue when the tag no longer names the commit about to be deployed.
#
# A tag is protected from the moment a release is *published*, not from the moment
# it is created, so between a run starting and its first production write there is
# a window in which the tag can be moved. `github.sha` is fixed for the run and is
# what every checkout uses, so a tag naming anything else is a version whose name
# and its content disagree — and which of the two a User ends up running depends on
# nothing anybody checked.
#
# Called twice, and both calls are load-bearing:
#
#   - Early, to fail in seconds rather than after `pnpm install`, `pnpm validate`
#     and two production builds, which is the difference between learning about a
#     moved tag immediately and learning about it ten minutes later.
#   - Again immediately before the first live write, because the early call is only
#     true at the moment it ran. Everything between the two is a long stretch of
#     work, and the question that matters — "does the tag still name what I am
#     about to ship?" — is only worth asking once, as late as possible.
#
# One script rather than two copies of the check, because the two calls exist only
# to close the window at both ends of it, and a second implementation is a second
# thing to keep correct.

set -euo pipefail

die() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  echo "usage: assert-tag-names.sh OWNER/REPO TAG EXPECTED_SHA [GATED_SHA]" >&2
  die "expected three or four arguments, got ${1:-0}"
}

[[ $# -ge 3 && $# -le 4 ]] || usage "$#"

repo="$1"
tag="$2"
expected="$3"
gated="${4:-}"

[[ -n "$repo" && "$repo" == */* ]] || die "repo must be OWNER/REPO, got '$repo'"
for sha in "$expected" "$gated"; do
  [[ -z "$sha" || "$sha" =~ ^[0-9a-f]{7,40}$ ]] || die "not a commit SHA: '$sha'"
done

# Dereferenced, not read off the ref: an annotated tag reports the tag object's own
# SHA there, which is never the commit anything deploys.
named="$(./scripts/resolve-tag-commit.sh "$repo" "$tag")"

if [[ "$named" != "$expected" ]]; then
  die "tag $tag names $named, but this run is pinned to $expected. The tag was moved after the run started. Nothing has been deployed; re-run this workflow if the tag is moved back."
fi

# Only meaningful when the Release workflow dispatched this one: for a hand-pushed
# tag the run and the gate are the same commit by construction, so requiring it
# would assert nothing. Empty is the hand-push case, not a failure.
if [[ -n "$gated" && "$expected" != "$gated" ]]; then
  die "this run resolved to $expected but Release gated $gated. The tag was moved before the dispatch resolved it. Nothing has been deployed."
fi

echo "tag $tag names $named, which is what this run deploys."
