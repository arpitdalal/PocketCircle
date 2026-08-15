# Application changelog practices

Research date: 2026-08-14. Sources are primary documentation/specifications.

## Recommendation

Use a curated `CHANGELOG.md` section as the source for each immutable `vX.Y.Z`
production tag. The deployment workflow publishes that exact section as the
GitHub Release only after production succeeds, so there is one authored source
and one public representation.

This matches PocketCircle's deliberate tag-gated release process without adding
a package-release tool to a deployable application monorepo.

## Release-note workflow

1. Before cutting `vX.Y.Z`, draft and review a dated `CHANGELOG.md` section:
   outcome first, no commit SHAs or internal implementation detail, and clear
   migration/action for any breaking change.
2. Merge that release-preparation commit to `main` and let CI/E2E pass.
3. Push the annotated tag. The production workflow verifies the matching
   changelog section before deployment, then publishes it as the GitHub Release
   only after success. The release job alone receives `contents: write`.
4. Keep a short `Unreleased` section at the top for the next release.

GitHub can generate notes from merged PRs, contributors, and a full-change
link. Its `.github/release.yml` supports label-based categories and exclusions;
use it as draft evidence, not a second authoritative changelog.
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
