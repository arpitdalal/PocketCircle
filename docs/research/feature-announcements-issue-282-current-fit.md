# Feature announcements issue #282: current fit

> **Pre-implementation research snapshot (2026-08-25).** Captures the contract
> alignment before #282 shipped. The Feature Announcement catalog, User
> acknowledgment field, Convex-before-Worker deploy order, and Unreleased
> changelog entry now exist on `main` via PR #304 — treat the “not implemented”
> matrix rows and Worker-first deploy notes below as historical.

Research date: 2026-08-25. Sources are the issue, merged feature work, repository source, tests, ADRs, release workflow, and published GitHub releases.

## Verdict

[Issue #282](https://github.com/arpitdalal/PocketCircle/issues/282) still describes a useful product capability, but it is not ready to implement as written for Duplicate Transaction. Three assumptions no longer fit:

1. Duplicate has no context-free CTA. It starts from a specific Transaction Detail and requires both a source Circle and source Transaction.
2. PocketCircle has no durable record that a User used Duplicate. The only signal is optional, client-side PostHog analytics. The product deliberately stores no duplication lineage.
3. `main` is not production under this repository's release model. Duplicate merged on 2026-08-25, but the latest production tag and GitHub Release are still `v0.2.0` from 2026-08-17/18. The release cutoff therefore does not exist yet.

The issue also leaves PWA prompt arbitration undecided and omits the repository's backend-before-client compatibility requirement. The replacement behavior and rollout contract were aligned on 2026-08-25 and are recorded below.

## Source state

- #282 is open, has no comments, and has only the `enhancement` label. GitHub records it as created and last updated on 2026-08-19. Its stated blocker is "a real feature with a working create/use route." [Issue #282](https://github.com/arpitdalal/PocketCircle/issues/282)
- Duplicate Transaction was specified in [#293's resolution](https://github.com/arpitdalal/PocketCircle/issues/293#issuecomment-5400438196), implemented by [PR #302](https://github.com/arpitdalal/PocketCircle/pull/302), and merged as commit [`91260560`](https://github.com/arpitdalal/PocketCircle/commit/91260560767d26ee27a9b9d0a5db442010c9f5f8) on 2026-08-25.
- Production deploys only from `v*` tags, after validation. Merging to `main` does not deploy production. See `.github/workflows/deploy.yml:3-25` and `docs/research/application-release-versioning.md:5-10,24-30`.
- The latest repository tag is `v0.2.0`, and the latest published release is [v0.2.0](https://github.com/arpitdalal/PocketCircle/releases/tag/v0.2.0). Both predate `91260560`. `CHANGELOG.md:8-10` has an empty Unreleased section and no Duplicate entry.

Under the repository's own terminology, Duplicate is code-complete on `main`, not yet released. If an out-of-band production deploy occurred, neither the release workflow nor GitHub Releases records it.

## Relevance matrix

| #282 claim or decision | Status | Current evidence and consequence |
| --- | --- | --- |
| Wait for a substantial capability with a working route | Resolved | Duplicate is implemented and E2E-covered and was accepted as the first substantial capability. It is not yet in a production tag. `e2e/duplicate-transaction.spec.ts:17-79`; `.github/workflows/deploy.yml:3-25`. |
| Discovery is separate from changelog and feature flags | Current | What's New is a protected, pull-based archive that parses released `CHANGELOG.md` sections. It does not auto-open or store seen state. `apps/web-app/app/routes/whats-new.tsx:12-67`; `apps/web-app/app/lib/changelog.ts:141-189`; `docs/adr/0013-posthog-for-product-analytics.md:1`. |
| A typed in-repo catalog owns announcement copy and rules | Current | No announcement catalog exists. This remains the simplest source for a small fixed set. A runtime CMS or PostHog flag still conflicts with the issue's purpose and ADR 0013. |
| Stable one-shot ID per capability | Current | Still suitable. The permanent first ID is `duplicate-transaction`. |
| Static `ctaHref`, or resolver needing a Circle ref | Superseded | Duplicate cannot begin from a Circle alone. The action on Transaction Detail builds `/transactions/new` with `sourceCircle`, `sourceTransaction`, optional destination Circle, Type, and `returnTo`. `apps/web-app/app/routes/circle/transaction-detail.tsx:68-88`; `docs/adr/0017-react-router-framework-mode-spa.md:19`. The catalog needs a Transaction-aware resolver, a different CTA, or a Detail-only announcement. |
| Show only to Users created before `releasedAt` | Resolved with different name | `users.createdAt` exists and is written at account creation. `packages/convex/convex/schema.ts:33-48`; `packages/convex/convex/model.ts:38-51`. The current session view omits it. `packages/convex/convex/users.ts:12-20`; `apps/web-app/app/lib/session.ts:18-25`. The catalog instead uses a product-chosen UTC `eligibleBefore` cutoff set during release preparation. |
| Do not show to Users who already used the feature | Stale for Duplicate | The new Transaction stores no source ID or method. `packages/convex/convex/schema.ts:151-167`; `packages/convex/convex/transactions.ts:578-656`. ADR 0017 explicitly says there is no stored source ID or duplication lineage. `docs/adr/0017-react-router-framework-mode-spa.md:19`. |
| Use feature-specific unused predicates | Superseded | No predicate can establish prior Duplicate use. Successful create emits `transaction_added` with `method: "duplicate"` only from the browser. `apps/web-app/app/components/transaction-form/use-transaction-form.ts:267-285`; `apps/web-app/app/lib/analytics-events.ts:57-65`. The replacement contract deliberately does not gate an announcement on feature use. |
| Persist dismissed IDs on the User for cross-device behavior | Current with broader terminology | The User row already owns analytics preference and account creation time, but has no announcement fields. `packages/convex/convex/schema.ts:33-48`. The replacement field stores IDs acknowledged through either CTA or close. Keeping it on the User makes Account Deletion automatic; a separate table would need explicit cleanup like `userActivation` and `homeSummaryExclusions`. `packages/convex/convex/accountDeletion.ts:504-517,653-679`. |
| Non-modal corner card, absent during Onboarding and Circle Setup | Current, partly supported | ProtectedLayout already prevents the normal shell from rendering during profile Onboarding. `apps/web-app/app/routes/layouts/protected-layout.tsx:71-85`. Circle Setup is a nested protected route and remains inside that shell, so the announcement layer must detect it. `apps/web-app/app/routes.ts:29-54`; `apps/web-app/app/routes/layouts/circle-layout.tsx:66-83`. |
| Never compete with the PWA install prompt | Resolved | The PWA provider owns an automatically opened modal and exposes `showInstallPrompt`. `apps/web-app/app/components/pwa-install.tsx:181-210,247-271,304-358`. The announcement remains mounted at a lower layer; visibility announcements and impressions wait until the PWA modal no longer covers it. |
| Changelog still lists the capability under Added | Current, not done | `CHANGELOG.md:8-10` is empty for Unreleased. The release workflow refuses a tag without a matching substantive release section. `.github/workflows/deploy.yml:38-49`; `scripts/release-notes.sh:31-63`. |
| What's New does not act as the marketing card | Implemented | The archive is manual-entry only and already distinguishes itself from Feature Announcements in the glossary. `CONTEXT.md:255-266`; `apps/web-app/app/components/account-menu.tsx:72-85`. |
| Account Deletion wipes announcement preferences | Current if stored on User | Deleting the `users` row removes fields on that row. If implementation chooses a separate table, it must extend the deletion batches and `deleteDocs` union. `packages/convex/convex/accountDeletionFinalize.ts:47-73`; `packages/convex/convex/accountDeletion.ts:653-679`. |
| Recurring Transactions remains out of scope | Stale example | It was the hypothetical first announcement. Duplicate is now the candidate capability. The exclusion causes no implementation problem, but the issue should name the chosen launch capability. |

## Rollout constraint

Production deploys the Cloudflare Worker before Convex. The workflow says a client that immediately needs an additive Convex function must receive that backend function in an earlier release. `.github/workflows/deploy.yml:80-95`.

A new eligibility query and acknowledgment mutation therefore cannot be assumed present when the announcement UI first loads. The aligned rollout changes the workflow to deploy backward-compatible Convex changes before the web bundle in the same release. If the web deployment fails, the additive backend remains deployed and the web deployment is retried. Breaking changes continue to use expand-contract releases.

## Resolved replacement specification

### Meaning and campaign lifecycle

- Duplicate Transaction is the first **Feature Announcement**. A Feature Announcement is a rare, non-modal discovery notice, not a changelog, feature flag, or completion checklist.
- CTA or close-button activation permanently acknowledges the announcement. Using Duplicate is never required, and organic Duplicate use is not tracked for announcement eligibility.
- One campaign owns the slot. The newest campaign replaces all older campaigns; there is no queue or fallback. If it has no usable CTA source, render nothing.
- An ignored campaign persists until acknowledged or replaced. It has no first-seen duration or expiry.
- Stable IDs are permanent, never reused, and never pruned from User records. The first ID is `duplicate-transaction`.

### Persistence and backend contract

- Add optional `acknowledgedFeatureAnnouncementIds?: string[]` to the User. Missing means no acknowledgments. No Feature, Announcement, or usage table is added.
- Use a shared typed registry of allowed IDs. The acknowledgment mutation rejects unknown IDs and idempotently merges a valid ID into the User array.
- Account Deletion needs no new cleanup because the preference lives on the User row.
- Keep display copy, cutoff, route eligibility, and CTA behavior in the typed in-repo web catalog. The backend owns only the allowed identifier contract, persisted acknowledgments, and source lookup.

### Eligibility and source

- A catalog entry has a fixed product-chosen UTC `eligibleBefore` set during release preparation. A User is eligible only when `users.createdAt < eligibleBefore` and the ID is not acknowledged.
- Having no usable Transaction is temporary, not an acknowledgment. An eligible older User can see the card after creating an eligible Transaction later.
- Home selects the most recently recorded active Transaction, by Transaction `createdAt`, across the User's active, setup-complete visible Circles.
- Circle Dashboard, Ledger, and Categories select the most recently recorded active Transaction in the current active, setup-complete visible Circle.
- A dedicated source query and a `by_circle_status_createdAt` Transaction index are needed; Home Summary cannot supply this source without applying unrelated filters and exclusions.
- While eligibility or source is loading, or when no source exists, render nothing—no placeholder, skeleton, fallback campaign, or toast.

### Routes, card, and overlays

- Allow only Home, Circle Dashboard, Ledger, and the Categories list. Exclude Search, Setup, create/edit/detail routes, Settings, Members, History, Feedback, and What's New.
- Render a fixed bottom-left, non-modal card. On mobile, inset it for safe areas and place it above the fixed Circle navigation. It may coexist with the Home Activation Checklist.
- Keep the card mounted behind the full-screen PWA install modal. Its lower stacking level lets the modal backdrop, focus trap, and inert behavior win naturally. Snackbars also remain above it.
- The card does not trap or steal focus and has no Escape behavior. Expose it as a labelled region and announce its first genuine visibility through a separate polite status message. Do not announce or count an impression while it is covered by the PWA modal.

### Copy and CTA flow

- Label: `New`
- Title: `Duplicate a transaction`
- Body: `Start from a recent transaction, select Duplicate, then review and save a separate copy.`
- CTA: `Try Duplicate`
- The CTA opens the selected Transaction Detail and carries the exact origin as `returnTo`. Detail then carries itself as the Duplicate flow's `returnTo`, preserving `origin → source Detail → Duplicate → new Detail` Back behavior.
- Keep Duplicate as a semantic link. When Detail was reached through an ordinary announcement CTA activation, transient navigation state gives that link temporary visual emphasis and focus after the Transaction resolves. Enter activates it; no custom Space behavior is added.

### Acknowledgment failures and races

- CTA and close optimistically hide the card and fire acknowledgment without awaiting it.
- Mutation failure shows `Couldn't save that preference.` The optimistic rollback makes the card eligible again on a qualifying route; there is no offline queue or local retry state.
- CTA activation still counts as acknowledgment if the selected target becomes unavailable before Detail resolves. Existing indistinguishable unavailable-link recovery applies.

### Analytics

- Add coarse impression, CTA, and dismiss events with only the stable announcement value; never include Circle, Transaction, financial, route, or free-form data.
- Record an impression only after the card is genuinely visible and not covered by a higher modal.
- Deduplicate impressions with `sessionStorage`, once per announcement per tab session. Route changes and reloads do not duplicate it; separate tabs may each record one.

## Recommendation

Keep #282, but replace its stale usage-gated behavior and Circle-only CTA assumption with the resolved specification above. It is ready for implementation once the issue records this contract and the release owner chooses the concrete UTC cutoff during release preparation.
