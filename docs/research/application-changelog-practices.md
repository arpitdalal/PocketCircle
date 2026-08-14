# Application changelog practices

Research date: 2026-08-14. Sources are primary documentation/specifications.

## Recommendation

Use a GitHub Release as the canonical public record for each immutable `vX.Y.Z`
production tag. Generate its notes from merged pull requests, then review the
draft before publishing. Keep a repository `CHANGELOG.md` only if release notes
must be visible outside GitHub (for example, in the product or a docs site).
Do not maintain both as independent sources of truth.

This matches PocketCircle's deliberate tag-gated release process without adding
a package-release tool to a deployable application monorepo.

## Release-note workflow

1. Give every user-visible pull request exactly one release category label:
   `release: feature`, `release: fix`, or `release: breaking`. Label internal,
   dependency-only, CI, and documentation-only pull requests `release: skip`.
2. Add `.github/release.yml` mapping those labels to human-facing sections,
   with a catch-all category so nothing is silently lost.
3. Before cutting `vX.Y.Z`, inspect GitHub's generated notes and rewrite the
   headings/bullets for customers: outcome first, no commit SHAs or internal
   implementation detail, clear migration/action for any breaking change.
4. Push the annotated tag. The production workflow verifies and deploys it;
   only after success should it publish the reviewed GitHub Release for that
   exact tag. This needs `contents: write` in that final workflow step.
5. If release notes must be in-repository, copy the same curated text into
   `CHANGELOG.md` under a dated release heading. Keep a short `Unreleased`
   section; move it into the versioned section when releasing.

GitHub can generate notes from merged PRs, contributors, and a full-change
link. Its `.github/release.yml` supports label-based categories and exclusions.
[GitHub automated release notes](https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes)

## Why not release automation from commits

Conventional Commits can map `feat`, `fix`, and breaking changes to SemVer, but
it makes commit messages an input to product release automation.
[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)

That conflicts with PocketCircle's intentional, manual production tag. Do not
adopt semantic-release now. It automates versioning, notes, tags, and publishing
after builds on release branches, which removes the release decision this
repository just introduced.
[semantic-release](https://github.com/semantic-release/semantic-release)

Changesets is excellent when independently versioned packages are published
from a monorepo: it collects per-package release intent, calculates versions,
and writes package changelogs. PocketCircle's workspace packages are private
implementation units and the user-facing application has one release version,
so it adds unnecessary package-version machinery.
[Changesets](https://github.com/changesets/changesets)

## If a `CHANGELOG.md` is needed

Keep a Changelog recommends human-curated, reverse-chronological entries with
one dated entry per version and an `Unreleased` section. Group changes as
Added, Changed, Deprecated, Removed, Fixed, and Security; it explicitly warns
against dumping commit logs into a changelog.
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/)
