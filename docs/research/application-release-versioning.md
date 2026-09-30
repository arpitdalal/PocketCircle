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
2. When ready, prepare the versioned `CHANGELOG.md` section on `main`
   (`## [vX.Y.Z] - YYYY-MM-DD`, with at least one bullet or paragraph) and merge
   it. **Do not create the tag yourself** — see step 3. Pushing a tag by hand
   triggers `deploy.yml` straight from `push: tags`, bypassing the gate on the
   commit entirely, which is the ungated deployment path this document used to
   recommend.
3. The **Release** workflow cuts the tag and dispatches the production
   workflow, which checks out **the tag SHA**, validates it, and deploys only
   that exact revision. Dispatch Release from current `main`; do not create the
   tag or the GitHub Release by hand, which skips the gate on the commit and is
   the failure this document's point 5 used to make permanent. Use one production concurrency group; do not cancel
   an active deployment. GitHub documents that concurrency is independent of an
   Environment and is the mechanism that prevents concurrent production jobs.
   [GitHub deployment control](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments)
4. Give the `production` Environment an explicit allowed **tag** pattern
   (`v*`), required reviewer(s), and self-review prevention. Environment rules
   run before the job gets its environment secrets; selected branch/tag rules
   match the run's `GITHUB_REF`.
   [GitHub deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
5. Roll back by releasing/deploying a prior immutable tag, not by moving or
   recreating a version tag. Protect `v*` with **GitHub's release immutability**
   (**Settings → General → Releases**), *not* with a hand-written tag ruleset
   restricting updates and deletion.
   [GitHub immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)

   **Superseded 2026-09-28 (#423).** This originally recommended a `v*` ruleset
   restricting tag updates and deletion. That is stricter than the platform
   feature and cannot express the distinction that matters: immutability begins
   when a release is *published*, so a tag with no release behind it stays
   mutable and can be corrected, while a published one is locked for good. A
   ruleset applies to both alike, so it also blocks recovering a release that
   never deployed — v0.8.1 was stranded as a permanent tag on a commit whose
   deploy failed, and the fix shipped as v0.8.2 with the number spent. Following
   the original advice would restore exactly that failure.

   The tag is now cut by the **Release** workflow *after* the commit is gated on
   `main`'s own CI and E2E verdicts, rather than pushed by hand, so the failure
   mode the ruleset was protecting against is closed at the source. See the
   repository README's release procedure and recovery table.

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
