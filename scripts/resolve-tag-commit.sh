#!/usr/bin/env bash

# What commit does a ref actually name?
#
# Two callers need this and neither can be right without it. `refs/tags/X` can
# point at a *commit* (a lightweight tag) or at a *tag object* (an annotated or
# signed one, which is what `git tag -a` makes and therefore what a hand-pushed
# release tag is). The REST ref endpoint reports `object.sha`, and for an
# annotated tag that is the tag object's own SHA — not the commit it points at.
# Comparing it to a commit SHA therefore never matches, and code that means "this
# tag already names the commit I gated" reads as "this tag names something else".
#
# So this dereferences: a ref, then as many tag objects as it takes to reach a
# commit, and prints that commit's SHA. Nothing else in the repo should be
# resolving a ref by hand.
#
# A tag is also *movable* until a release is published against it — immutability
# begins at publication, not at creation. So the answer is only ever true at the
# moment it was asked for, which is why both callers check it immediately before
# the step that would make the tag mean something, rather than once at the start
# of a long run.

set -euo pipefail

die() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  echo "usage: resolve-tag-commit.sh OWNER/REPO TAG" >&2
  die "expected exactly two arguments, got $#"
}

[[ $# -eq 2 ]] || usage
repo="$1"
tag="$2"

[[ -n "$repo" && "$repo" == */* ]] || die "repo must be OWNER/REPO, got '$repo'"
[[ -n "$tag" ]] || die "tag must not be empty"

# `gh api` is the boundary here, so it is the only thing this script talks to.
# `--jq` prints one field rather than an object, which keeps the caller from
# parsing JSON and keeps this script free of a JSON parser.
#
# The output is validated before it is read. `gh` exits non-zero on an API error,
# which the callers below already treat as "unreadable", but a response that is
# well-formed HTTP and not the shape expected here — an empty body, a rate-limit
# message, a field renamed out from under this — would otherwise be read as an
# object of some unnamed type, and the error would name the tag rather than the
# disagreement. Validating the shape is what turns that into a message a person
# can act on.
read_ref_object() {
  local url="$1" resolved
  resolved="$(gh api "$url" --jq '.object | "\(.type) \(.sha)"')" || return 1
  # Trim before validating. Whitespace around the answer is not a disagreement
  # about the ref, and a strict pattern on an untrimmed string reports a good
  # response as a malformed one — which sends the reader looking at the API
  # instead of at the tag.
  resolved="${resolved#"${resolved%%[![:space:]]*}"}"
  resolved="${resolved%"${resolved##*[![:space:]]}"}"
  if [[ ! "$resolved" =~ ^(commit|tag|tree|blob)[[:space:]][0-9a-f]{7,40}$ ]]; then
    die "unexpected response from $url: '$resolved'"
  fi
  printf '%s\n' "$resolved"
}

# A tag object carries the ref it really points at. `git/tags` answers for the
# tag object's own SHA and names the type of what it wraps, so the same shape
# comes back and the loop is the same shape too.
resolved="$(read_ref_object "repos/$repo/git/ref/tags/$tag")" ||
  die "no such tag: $tag in $repo"

# Bounded rather than `while true`: a ref that points at itself would otherwise
# spin until the job's timeout, which reads as a hang rather than as bad input.
# Three hops is far past anything git produces in practice — a tag of a tag of a
# tag — and the point of the bound is to fail loudly rather than to be clever.
for _ in 1 2 3; do
  type="${resolved%% *}"
  sha="${resolved##* }"

  if [[ "$type" == "commit" ]]; then
    [[ "$sha" =~ ^[0-9a-f]{7,40}$ ]] || die "$tag resolved to '$sha', which is not a commit SHA"
    printf '%s\n' "$sha"
    exit 0
  fi

  if [[ "$type" != "tag" ]]; then
    die "$tag points at a '$type' object, not a commit or a tag"
  fi

  resolved="$(read_ref_object "repos/$repo/git/tags/$sha")" ||
    die "$tag names tag object $sha, which could not be read"
done

die "$tag is nested more than three tag objects deep; refusing to guess"
