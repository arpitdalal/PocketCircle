#!/usr/bin/env bash

set -euo pipefail

die() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: release-context.sh [--version vMAJOR.MINOR.PATCH] [--base <tag-or-commit>] [--head <revision>]

Emit read-only release evidence for PocketCircle changelog drafting.

Baseline order without --base:
  1. newest versioned heading in CHANGELOG.md
  2. newest stable SemVer tag reachable from --head
  3. complete history (initial release)

--version validates the intended stable release tag and only labels the output.
It does not create a tag, release, commit, or changelog entry.
USAGE
}

version=""
base=""
head="HEAD"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      [[ $# -ge 2 ]] || die "--version requires a value"
      version="$2"
      shift 2
      ;;
    --base)
      [[ $# -ge 2 ]] || die "--base requires a value"
      base="$2"
      shift 2
      ;;
    --head)
      [[ $# -ge 2 ]] || die "--head requires a value"
      head="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

[[ -z "$version" || "$version" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || \
  die "version must be stable SemVer: vMAJOR.MINOR.PATCH"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "run inside a Git work tree"
head_commit="$(git rev-parse --verify "${head}^{commit}")" || die "invalid head: $head"

changelog_version=""
if [[ -f CHANGELOG.md ]]; then
  changelog_version="$(sed -nE 's/^##[[:space:]]+\[?(v[0-9]+\.[0-9]+\.[0-9]+)\]?.*/\1/p' CHANGELOG.md | sed -n '1p')"
fi

baseline_source=""
if [[ -n "$base" ]]; then
  baseline="$base"
  baseline_source="--base"
elif [[ -n "$changelog_version" ]]; then
  baseline="$changelog_version"
  baseline_source="CHANGELOG.md"
else
  reachable_tags="$(git tag --merged "$head_commit" --sort=-version:refname)"
  baseline="$(printf '%s\n' "$reachable_tags" | sed -nE '/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/p' | sed -n '1p')"
  [[ -z "$baseline" ]] || baseline_source="reachable SemVer tag"
fi

if [[ -n "$baseline" ]]; then
  baseline_commit="$(git rev-parse --verify "${baseline}^{commit}")" || \
    die "baseline '$baseline' does not resolve to a commit"
  git merge-base --is-ancestor "$baseline_commit" "$head_commit" || \
    die "baseline '$baseline' is not an ancestor of $head_commit"
  range="${baseline_commit}..${head_commit}"
else
  baseline_commit=""
  range="$head_commit"
fi

echo "# Release evidence"
[[ -z "$version" ]] || echo "- Target version: \`$version\`"
echo "- Head: \`$head_commit\`"
if [[ -n "$baseline" ]]; then
  echo "- Baseline: \`$baseline\` (${baseline_source}, \`$baseline_commit\`)"
  echo "- Git range: \`${range}\`"
else
  echo "- Baseline: initial release; complete reachable history"
fi

echo
echo "## First-parent commits to review"
if [[ -n "$baseline" ]]; then
  git log --first-parent --reverse --format='- %h %cs %s' "$range"
else
  git log --first-parent --reverse --format='- %h %cs %s' "$head_commit"
fi

echo
echo "## Pull request references found in commit subjects"
if [[ -n "$baseline" ]]; then
  subjects="$(git log --first-parent --format=%s "$range")"
else
  subjects="$(git log --first-parent --format=%s "$head_commit")"
fi
references="$(printf '%s\n' "$subjects" | sed -nE 's/.*\(#([0-9]+)\).*/#\1/p' | sort -u)"
if [[ -n "$references" ]]; then
  printf '%s\n' "$references"
else
  echo "- none; inspect commits and GitHub manually"
fi

echo
echo "## Checks"
if [[ -n "$changelog_version" && "$changelog_version" != "$baseline" ]]; then
  echo "- warning: CHANGELOG.md resolves to $changelog_version but --base overrides it"
fi
if [[ -n "$baseline" && "$baseline" == "$changelog_version" ]]; then
  echo "- CHANGELOG.md baseline is represented by an ancestor commit"
elif [[ -n "$baseline" ]]; then
  echo "- baseline came from $baseline_source; confirm it is the last published changelog"
else
  echo "- no prior versioned changelog entry or reachable stable tag was found"
fi
