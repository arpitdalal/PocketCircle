---
name: generate-changelog
description: Draft or prepare PocketCircle's next human-facing application changelog from the changes since the last released changelog entry. Use when asked to generate release notes, update CHANGELOG.md, prepare a vMAJOR.MINOR.PATCH release, or summarize user-visible changes since the previous release in this repository. Never use it to tag, deploy, publish a GitHub Release, or choose a release version without explicit user direction.
---

# Generate Changelog

Create a concise, customer-facing release draft. Treat Git history and GitHub
metadata as evidence, never as publishable copy.

## Scope and safety

- Work only from this repository's checkout and its GitHub remote.
- Never create tags, GitHub Releases, deployments, commits, pushes, labels, or
  workflow changes. A changelog preparation ends with an uncommitted
  `CHANGELOG.md` update after the user explicitly approves the draft.
- Do not choose a SemVer version. When no version is supplied, draft only an
  `Unreleased` section and ask the user to choose a version before applying a
  versioned release section.
- Do not overwrite a modified `CHANGELOG.md`; report the conflict and stop.
- Do not describe a tagged-but-failed deployment as released. The deployment
  workflow validates tagged notes, deploys, then publishes the GitHub Release.

## Gather trustworthy scope

1. Read `AGENTS.md`, `README.md`'s production-release section, and any existing
   `CHANGELOG.md` before making conclusions.
2. Run `./.agents/skills/generate-changelog/scripts/release-context.sh`. Pass
   `--version vX.Y.Z` only when the user supplied the intended stable release
   version. The script rejects a target that already exists as a tag/release or
   does not advance past the published baseline. It resolves the range from the
   latest published GitHub Release whose immutable stable tag is an ancestor of
   `HEAD`; otherwise it uses complete history for an initial release. A
   `CHANGELOG.md` heading that lacks that release is still in scope, so failed
   releases cannot hide changes.
3. Read the resulting first-parent commits. For each PR reference, use `gh pr
   view <number>` to inspect its description, linked issue, labels, and diff
   when the title is insufficient. Include direct commits without a PR in the
   evidence review. Never infer user impact from a title alone.
4. Compare the chosen baseline, `HEAD`, and candidate scope explicitly. Flag
   uncertainty, missing PR references, or a release boundary not represented by
   a published GitHub Release and immutable tag. For an initial release,
   summarize current user capability; do not turn the entire development
   history into a commit log.

## Draft

Use Keep a Changelog categories only when populated: `Added`, `Changed`,
`Deprecated`, `Removed`, `Fixed`, and `Security`.

- Lead with observable outcome, use plain language, and combine related
  implementation work into one bullet.
- Include migration/action required for a breaking change. Do not bury security
  issues, removals, or incompatibilities.
- Exclude refactors, CI, generated files, dependency bumps, observability, and
  internal restructuring unless a user can observe a material effect.
- Link to issues/PRs only when the link helps a contributor; do not include
  commit SHAs in customer-facing bullets.
- Preserve existing history exactly. Keep `## [Unreleased]` at the top. A
  versioned section uses `## [vX.Y.Z] - YYYY-MM-DD`, latest first.

Present the baseline, evidence reviewed, included/excluded changes, and the
full proposed Markdown. Wait for explicit approval before editing.

## Apply after approval

1. Recheck `git status --short` and the release range. Stop if `CHANGELOG.md`
   changed or the baseline/HEAD moved.
2. Create or update `CHANGELOG.md` with the approved text using `apply_patch`.
   Leave a fresh empty `Unreleased` section above the released section.
3. Review the diff. Do not tag or commit. Tell the user the resulting release
   preparation commit must merge to `main`, pass CI/E2E, then receive its
   immutable `vX.Y.Z` tag. The deploy workflow validates that exact section
   before production deployment and publishes it as the GitHub Release only on
   success.

## Resource

Run `./.agents/skills/generate-changelog/scripts/release-context.sh --help` for
range-resolution details. It is read-only and emits the provenance needed for a
draft; it does not generate or publish customer-facing text by itself.
