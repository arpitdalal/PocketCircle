# Application release versioning and production promotion

Research date: 2026-08-14. Sources are first-party documentation/specifications.

## Decision

Use immutable SemVer release tags as the **human-facing product release** and
retain the full commit SHA as **build provenance**. Promote to production only
from an approved release tag; merging to `main` remains continuous integration,
not a production release.

Recommended first release: `v0.1.0`, then `v0.1.1`, `v0.2.0`, etc. While the
product is pre-1.0, use `0.MINOR.PATCH`: increment MINOR for a user-visible
feature and PATCH for a fix. Avoid release dates as the primary version unless
the team truly releases on a calendar. SemVer defines `MAJOR.MINOR.PATCH` and
states that a released version's contents must not be modified.
[Semantic Versioning 2.0.0](https://semver.org/)

The app should display `v0.1.0`; release/error metadata should contain both
`v0.1.0` and the full immutable SHA (for example, `v0.1.0+<sha>`). A SHA alone
is excellent for exact diagnosis but poor release communication, support, and
release notes. Do not make the version name ambiguous by reusing a tag.

## Recommended workflow

1. Merge small, fully tested changes to protected `main`. CI and E2E run there;
   no production deployment runs on merge.
2. When ready, create annotated tag `vX.Y.Z` on the already-tested `main`
   commit, create GitHub Release notes, and trigger production from that tag.
3. The production workflow checks out **the tag SHA**, validates it, and deploys
   only that exact revision. Use one production concurrency group; do not cancel
   an active deployment. GitHub documents that concurrency is independent of an
   Environment and is the mechanism that prevents concurrent production jobs.
   [GitHub deployment control](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments)
4. Give the `production` Environment an explicit allowed **tag** pattern
   (`v*`), required reviewer(s), and self-review prevention. Environment rules
   run before the job gets its environment secrets; selected branch/tag rules
   match the run's `GITHUB_REF`.
   [GitHub deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
5. Roll back by releasing/deploying a prior immutable tag, not by moving or
   recreating a version tag. Protect `v*` with a GitHub tag ruleset that
   restricts updates and deletion. GitHub rulesets support controls for tag
   creation, update, and deletion.
   [GitHub ruleset rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)

This produces a deliberate cadence without a long-lived release branch. A
release can be cut whenever a coherent user-visible increment is ready; for a
small app, weekly or on-demand is normally preferable to batching a calendar
release.

## Artifact principle and PocketCircle scope

The stronger supply-chain model is **build once, promote the same immutable
artifact**: CI builds and tests a versioned web bundle, records its digest and
provenance, and the production job deploys that bundle rather than rebuilding.
GitHub artifact attestations establish where/how an artifact was built and can
be verified; GitHub also recommends immutable releases to reduce build-system
risk. [GitHub artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)
[GitHub build-system guidance](https://docs.github.com/en/code-security/tutorials/implement-supply-chain-best-practices/securing-builds)

Today, the deploy workflow correctly checks out the successful E2E run's exact
SHA before rebuilding, so it never deploys a newer `main` commit by accident.
That is a good source-revision guarantee, but not yet strict artifact
promotion. Adopt tag-based releases first. Later, if deploy assurance warrants
the added workflow complexity, upload the verified Vite build as a CI artifact,
attest its digest, and deploy that downloaded bundle; keep Convex deployment
at the same tag SHA and maintain backward-compatible, additive backend changes
across the frontend/backend rollout boundary.

Cloudflare Workers already models this separation: each upload creates a
version containing code, static assets, bindings, and compatibility settings;
a deployment selects the version(s) serving traffic. It supports decoupled
upload/promotion, gradual traffic shifts, and rollback. That is useful after
the simple tagged-release workflow is established, not a prerequisite for it.
[Cloudflare Workers versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/)

## Avoid

- Deploying every `main` push merely because the branch is protected. It makes
  every merge a release decision and weakens deliberate rollback/release notes.
- Triggering production from a mutable `main` ref after approval; always bind
  the job to the tag's resolved SHA.
- Moving `vX.Y.Z` to fix a bad release. Publish `vX.Y.(Z+1)` (or a new
  prerelease) instead.
- Treating a GitHub Release title/tag as evidence that arbitrary rebuilt bytes
  were tested. Preserve the tested revision now; promote attested bytes when
  the stricter guarantee is needed.
