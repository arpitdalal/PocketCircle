#!/usr/bin/env bash

set -euo pipefail

die() {
  echo "error: $*" >&2
  exit 1
}

# Keep a Changelog category headings alone are not release notes.
is_substantive_note_line() {
  local line="$1"
  [[ -z "${line//[[:space:]]/}" ]] && return 1
  [[ "$line" =~ ^#+[[:space:]] ]] && return 1
  return 0
}

[[ $# -eq 1 ]] || die "usage: release-notes.sh vMAJOR.MINOR.PATCH"
version="$1"
[[ "$version" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || \
  die "version must be stable SemVer: vMAJOR.MINOR.PATCH"

[[ -f CHANGELOG.md ]] || die "CHANGELOG.md is required before tagging a release"

heading_prefix="## [$version] - "
found=false
has_content=false
body=()

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
  body+=("$line")
  if is_substantive_note_line "$line"; then
    has_content=true
  fi
done < CHANGELOG.md

[[ "$found" == true ]] || die "missing release heading for $version in CHANGELOG.md"
[[ "$has_content" == true ]] || \
  die "release notes for $version need a bullet or paragraph, not only category headings"

if ((${#body[@]} > 0)); then
  printf '%s\n' "${body[@]}"
fi
