#!/usr/bin/env bash

set -euo pipefail

die() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: release-context.sh [--version vMAJOR.MINOR.PATCH] [--base <release-tag>] [--head <revision>]

Emit read-only release evidence for PocketCircle changelog drafting.

Baseline order without --base:
  1. nearest published GitHub Release ancestor of --head (tip-most among
     stable SemVer tags ordered by publishedAt, then ancestry)
  2. complete history (initial release)

--base must name a published GitHub Release with a stable SemVer tag.
--version must be an unused stable tag that advances past the resolved baseline.
Neither option creates a tag, release, commit, or changelog entry.
USAGE
}

is_stable_version() {
  [[ "$1" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
}

# True when $1 is strictly greater than $2 under stable SemVer ordering.
version_greater() {
  local IFS=.
  local -a left right
  read -r -a left <<< "${1#v}"
  read -r -a right <<< "${2#v}"
  local i
  for i in 0 1 2; do
    if (( left[i] > right[i] )); then
      return 0
    fi
    if (( left[i] < right[i] )); then
      return 1
    fi
  done
  return 1
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

[[ -z "$version" ]] || is_stable_version "$version" || \
  die "version must be stable SemVer: vMAJOR.MINOR.PATCH"
[[ -z "$base" ]] || is_stable_version "$base" || \
  die "base must be a stable SemVer tag: vMAJOR.MINOR.PATCH"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "run inside a Git work tree"
head_commit="$(git rev-parse --verify "${head}^{commit}")" || die "invalid head: $head"
command -v gh >/dev/null 2>&1 || die "GitHub CLI is required to verify published releases"
gh auth status >/dev/null 2>&1 || die "authenticate GitHub CLI before generating release evidence"

published_releases="$(gh release list --limit 1000 --json tagName,isDraft,isPrerelease,publishedAt \
  --jq '[.[] | select(.isDraft | not) | select(.isPrerelease | not) | select(.tagName | test("^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$"))] | sort_by(.publishedAt) | reverse | .[].tagName')" || \
  die "could not list published GitHub Releases"

if [[ -n "$base" ]]; then
  printf '%s\n' "$published_releases" | grep -Fx -- "$base" >/dev/null || \
    die "base '$base' is not a published GitHub Release"
  candidates="$base"
else
  candidates="$published_releases"
fi

# Prefer the tip-most published ancestor of HEAD, not the first list entry.
# publishedAt ordering alone is wrong when an older draft is published later.
baseline=""
baseline_commit=""
while IFS= read -r candidate; do
  [[ -n "$candidate" ]] || continue
  candidate_commit="$(git rev-parse --verify "refs/tags/${candidate}^{commit}" 2>/dev/null)" || \
    die "published GitHub Release '$candidate' has no local immutable tag; fetch tags and retry"
  git merge-base --is-ancestor "$candidate_commit" "$head_commit" || continue
  if [[ -z "$baseline_commit" ]]; then
    baseline="$candidate"
    baseline_commit="$candidate_commit"
    continue
  fi
  if git merge-base --is-ancestor "$baseline_commit" "$candidate_commit" && \
    [[ "$baseline_commit" != "$candidate_commit" ]]; then
    baseline="$candidate"
    baseline_commit="$candidate_commit"
  elif [[ "$baseline_commit" == "$candidate_commit" ]] && version_greater "$candidate" "$baseline"; then
    baseline="$candidate"
  fi
done <<< "$candidates"

if [[ -n "$base" && -z "$baseline" ]]; then
  die "base '$base' is not an ancestor of $head_commit"
fi

if [[ -n "$baseline" ]]; then
  range="${baseline_commit}..${head_commit}"
else
  range="$head_commit"
fi

if [[ -n "$version" ]]; then
  if git rev-parse --verify "refs/tags/${version}" >/dev/null 2>&1; then
    die "version '$version' already exists as an immutable tag"
  fi
  printf '%s\n' "$published_releases" | grep -Fx -- "$version" >/dev/null && \
    die "version '$version' already has a published GitHub Release"
  if [[ -n "$baseline" ]] && ! version_greater "$version" "$baseline"; then
    die "version '$version' must be greater than baseline '$baseline'"
  fi
fi

changelog_version=""
if [[ -f CHANGELOG.md ]]; then
  changelog_version="$(sed -nE 's/^##[[:space:]]+\[?(v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*))\]?.*/\1/p' CHANGELOG.md | sed -n '1p')"
fi

echo "# Release evidence"
if [[ -n "$version" ]]; then
  if [[ -n "$baseline" ]]; then
    echo "- Target version: \`$version\` (unused; greater than baseline \`$baseline\`)"
  else
    echo "- Target version: \`$version\` (unused; initial release)"
  fi
fi
echo "- Head: \`$head_commit\`"
if [[ -n "$baseline" ]]; then
  echo "- Baseline: \`$baseline\` (published GitHub Release, \`$baseline_commit\`)"
  echo "- Git range: \`${range}\`"
else
  echo "- Baseline: initial release; no published GitHub Release is reachable"
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
references="$(printf '%s\n' "$subjects" | { grep -oE '\(#[0-9]+\)' || true; } | tr -d '()' | sort -u)"
if [[ -n "$references" ]]; then
  printf '%s\n' "$references"
else
  echo "- none; inspect commits and GitHub manually"
fi

echo
echo "## Checks"
if [[ -n "$version" && -n "$baseline" ]]; then
  echo "- target version \`$version\` is unused and greater than baseline \`$baseline\`"
elif [[ -n "$version" ]]; then
  echo "- target version \`$version\` is unused (initial release)"
fi
if [[ -n "$changelog_version" && "$changelog_version" != "$baseline" ]]; then
  echo "- warning: CHANGELOG.md starts at $changelog_version, which is not this successful release baseline; keep its changes in scope"
elif [[ -n "$baseline" ]]; then
  echo "- baseline is a published GitHub Release with an immutable ancestor tag"
else
  echo "- no successful released baseline was found"
fi
