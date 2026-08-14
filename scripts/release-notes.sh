#!/usr/bin/env bash

set -euo pipefail

die() {
  echo "error: $*" >&2
  exit 1
}

[[ $# -eq 1 ]] || die "usage: release-notes.sh vMAJOR.MINOR.PATCH"
version="$1"
[[ "$version" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || \
  die "version must be stable SemVer: vMAJOR.MINOR.PATCH"

[[ -f CHANGELOG.md ]] || die "CHANGELOG.md is required before tagging a release"

heading_prefix="## [$version] - "
found=false
has_content=false

while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ "$found" == false ]]; then
    if [[ "$line" == "$heading_prefix"* ]]; then
      date="${line#"$heading_prefix"}"
      [[ "$date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || \
        die "release heading must be '## [$version] - YYYY-MM-DD'"
      found=true
    fi
    continue
  fi

  [[ "$line" == "## "* ]] && break
  printf '%s\n' "$line"
  [[ -z "${line//[[:space:]]/}" ]] || has_content=true
done < CHANGELOG.md

[[ "$found" == true ]] || die "missing release heading for $version in CHANGELOG.md"
[[ "$has_content" == true ]] || die "release notes for $version are empty"
