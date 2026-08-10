# USR-3 · Account deletion

| | |
|---|---|
| **Status** | Ready for implementation |
| **Labels** | `enhancement`, `ready-for-agent` |
| **Depends on** | EML-1, MEM-7, MEM-8 (shipped) |
| **ADRs** | 0029 |
| **Glossary** | Account Deletion, Deleted Member, Historical Member, Personal Circle, Invitation, Notification Center, Account Export |

## Intent

A User can permanently delete their Spend Circle account. Account Deletion removes the User's login identity and app-owned profile data while preserving Circle-level financial attribution needed by other Members.

This is not strict User Erasure. Existing Circle, Transaction, and Category History stays immutable. Circle-scoped Member attribution remains through Deleted Members.

This issue records product decisions only. Before implementation, verify the current app/backend state against the codebase and ADRs; do not infer technical details from stale dependency notes.

## Product Contract

### Deleted Member

When a User deletes their account, every non-owner membership in another person's Circle becomes a Deleted Member.

- Deleted Members have no Circle access.
- Deleted Members keep Display Name for financial attribution.
- Deleted Members do not keep Profile Picture.
- Deleted Members do not count toward Circle Capacity.
- Deleted Members are never reconnected to a future User, even if the same person signs up again with the same Google account or email.
- Deleted Members appear only where historical attribution matters.

### History

Account Deletion does not rewrite existing Circle, Transaction, or Category History.

When a User becomes a Deleted Member in a Circle, Account Deletion records a new Circle History event for that Circle.

When Account Deletion auto-revokes Invitations, those revocations are recorded in Circle History.

### Owned Circles

Account Deletion is blocked only by regular Circles the User owns.

| User state | Account Deletion outcome | User-facing action |
|---|---|---|
| Owns active regular Circle with active co-Members | Blocked | Transfer ownership of `<Circle name>` |
| Owns archived regular Circle with active co-Members | Blocked | Transfer ownership of `<Circle name>` |
| Owns setup-complete active regular Circle with no active co-Members | Blocked | Archive `<Circle name>` |
| Owns setup-incomplete regular Circle with no active co-Members | Allowed; Circle is deleted during Account Deletion | None |
| Owns archived regular Circle with no active co-Members | Allowed; Circle is deleted during Account Deletion | None |
| Owns Personal Circle | Allowed; Personal Circle is deleted during Account Deletion | None |
| Active Member of another Owner's active Circle | Allowed; membership becomes Deleted Member | None |
| Active Member of another Owner's archived Circle | Allowed; membership becomes Deleted Member | None |

Ownership transfer is allowed while a regular Circle is archived. This is a narrow lifecycle exception to Archived Circle read-only behavior so an Owner can hand off responsibility without restoring financial writes.

A setup-incomplete regular Circle is disposable only when the deleting User is its sole active Member. If active co-Members somehow exist, ownership transfer remains required.

### Invitations

Account Deletion revokes pending Invitations created by the User.

Account Deletion also revokes pending Invitations addressed to the User's Google Account Email, so a future new User cannot inherit pre-deletion pending access.

These automatic revocations create Circle History events. They do not create Notifications.

### Notifications

Account Deletion deletes Notifications owned by the deleted User.

Account Deletion does not rewrite or delete other Users' Notifications.

Account Deletion does not create Notifications for other Users.

### Email-event records

Account Deletion deletes User-scoped feedback and invitation email-event records. These records are rate-limit metadata, not user-facing History.

### Account Export

The Delete Account surface offers an Account Export CTA before deletion. Account Export is not required before deletion and its backend is out of scope for this slice; the CTA may be disabled/dead in this pre-alpha slice.

### Confirmation

The Delete Account surface lives in Settings > Danger zone.

If blockers exist, the User cannot start deletion. The UI shows exact action links:

- `Archive <Circle name>` links to that Circle's Settings page.
- `Transfer ownership of <Circle name>` links to that Circle's Members page.

No blocker action is performed inline from Account Settings.

Once no blockers remain:

- User types the exact confirmation phrase `DELETE MY ACCOUNT` before starting deletion.
- User receives an email verification link.
- The verification link requires a current authenticated session for the same User. If the session is absent or expired, the User signs in again and reopens the link.
- The final deletion step re-checks blockers before completing deletion.
- No grace period or undo exists after verification completes.

### Completion and cleanup

Successful verification immediately and irreversibly removes login access, signs the User out, converts shared memberships, and revokes pending Invitations. User-owned profile data, Notifications, and email-event records are deleted as part of the deletion workflow.

Physical deletion of Personal Circle and eligible regular Circle data runs as durable, idempotent, bounded cleanup. Cleanup may continue after sign-out, but it cannot restore access or be undone. No cleanup query or mutation may collect an unbounded Circle dataset or attempt the entire cascade in one transaction.

## Acceptance Criteria

- User with no blockers can complete Account Deletion and is signed out afterward.
- User-owned profile/login data is removed.
- User-owned Notifications are removed.
- User-scoped feedback and invitation email-event records are removed.
- Personal Circle and all its scoped data are removed.
- Setup-incomplete regular Circles owned solely by the User are removed.
- Archived regular Circles owned by the User with no active co-Members are removed.
- Active regular Circles owned by the User block deletion and show archive/transfer CTAs as described above.
- Active shared regular Circles owned by the User block deletion until ownership is transferred.
- Archived shared regular Circles owned by the User block deletion until ownership is transferred; transfer is available while archived.
- Non-owner memberships become Deleted Members, keep Display Name, clear Profile Picture, lose access, do not count toward Circle Capacity, and do not reconnect to future Users.
- Existing History rows are not rewritten.
- Account Deletion writes Circle History for memberships becoming Deleted Members.
- Pending Invitations created by or addressed to the User are revoked with Circle History events.
- Account Deletion creates no Notifications for other Users.
- Other Users' Notifications remain unchanged.
- Final deletion re-checks blockers after email verification.
- Verification without a matching authenticated session requires sign-in before the link can complete deletion.
- Deletion immediately removes access and starts durable, idempotent, bounded cleanup for owned Circle data.
- Account Export CTA appears but does not need working backend.

## Implementation Constraints

- Use Better Auth's verified deletion flow and re-check blockers in the final server-authoritative deletion path.
- Do not reuse the current zero-Transaction Circle cascade unchanged. Account Deletion must cover Transactions, Transaction-Category joins, search projections, Categories, Invitations, Circle/Transaction/Category History, Members, test-only Invitation tokens, and Circle-scoped email-event records.
- Add indexes needed to resolve owned Circles, pending Invitations created by the User, pending Invitations addressed to the User's canonical Google Account Email, and User-owned cleanup records without table scans.
- Model Deleted Members distinctly from Removed Members. Historical-member reads include both; only Removed Members can reconnect to the same surviving User.
- Automatic deletion changes write Circle History but schedule no Notifications. Existing Notifications owned by other Users remain untouched.
- Cleanup steps are retry-safe and bounded. Tests must prove multi-batch completion, idempotent retries, blocker re-checking, and no access after verification.

## Out of Scope

- Rewriting existing History to anonymize old Display Names.
- Grace period or undo.
- Working Account Export backend.
- Vendor/support inbox deletion outside Spend Circle's database.

## Technical decisions and implementation analysis (2026-08-10)

### Current-state findings

- Better Auth `1.6.16` and `@convex-dev/better-auth` `0.12.3` are already wired in `packages/convex/convex/auth.ts`. User deletion is not enabled. Better Auth's verified flow supports `user.deleteUser.enabled`, `sendDeleteAccountVerification`, a one-day token by default, and a token callback that requires a current session for the same Better Auth User.
- The Better Auth component User has the mapped app `users` id in its `userId` field. The component client's `user.onDelete` trigger is the authoritative finalization seam: it runs from the adapter's User deletion mutation. Put the final blocker check and app-side deletion handoff there so a thrown blocker error aborts the auth User deletion transaction. Do not put destructive app changes in Better Auth `beforeDelete`; that callback runs from the HTTP action and would commit separately before auth deletion.
- `members.status` currently has only `active | removed`; `acceptInvitation` reactivates any Removed Member row found by `(circleId, userId)`. A distinct `deleted` status is required.
- Existing `circles.by_owner` already resolves owned Circles. `members.by_user`, `notifications.by_user`, `feedbackEmailEvents.by_user_and_sentAt`, and `invitationEmailEvents.by_user_and_sentAt` already cover part of cleanup. Invitations lack global inviter/status and email/status indexes. Circle cascade also lacks Circle indexes on Transaction search projections, Transaction-Category joins, and History.
- `deleteCircleCascade` is intentionally insufficient: it collects whole tables, assumes zero Transactions, omits Transaction projections/joins/History, invitation email events, and can exceed Convex transaction limits. Do not extend or call it for Account Deletion.
- `transferOwnership` currently calls `access.assertWritable()`, so archived transfer fails server-side. The Members UI already renders the transfer form for an archived regular Circle. Remove only this writable assertion; keep archived Circles read-only for every other write.
- Settings has Profile, Privacy, Feedback, and About sections only. Auth client has sign-in/sign-out wrappers but no deletion wrapper. Routing has public and protected layouts; add the verification/result surfaces to the public layout.

### Data model and indexes

Make these schema changes in `packages/convex/convex/schema.ts` and regenerate Convex types:

1. Members
 - Extend `status` to `active | removed | deleted`.
 - Add optional `deletedAt`.
 - Keep `userId` as the former app User id even after that User row is deleted. It is an opaque, dangling attribution key, not profile data. A newly created app User receives a different id, so `(circleId, userId)` can never reconnect the Deleted Member.
 - Add `by_user_and_status: [userId, status]` so active and removed rows can be converted in bounded batches without repeatedly reading already-deleted rows.
 - On conversion, keep `displayName`, clear `image`, set `status: "deleted"` and `deletedAt`, and preserve an existing `removedAt`.

2. Bounded Circle deletion
 - Add `circleId` to every `histories` row and `histories.by_circle`. Keep all existing History reads and authorization based on the audited entity; this field is an internal lifecycle/cascade key only and is never returned to clients or put in `changes`.
 - Carry `circleId` in the typed History entity passed to `recordEvent`; update `circleEntity`, `transactionEntity`, and `categoryEntity` call sites. This intentionally amends ADR 0018's implementation detail that History has no denormalized Circle key; ADR 0029's bounded whole-Circle deletion requires it.
 - Add `transactionSearchDocuments.by_circle`, `transactionCategories.by_circle`, and `invitationEmailEvents.by_circle`. Existing `categories.by_circle`, `transactions.by_circle`, `invitations.by_circle`, `members.by_circle`, and the `e2eInvitationTokens.by_circle_and_email` prefix are sufficient.

3. Invitation revocation
 - Add `invitations.by_inviter_status_createdAt: [invitedByUserId, status, createdAt]`.
 - Add `invitations.by_email_status_createdAt: [emailLower, status, createdAt]`.
 - The cleanup job stores `finalizedAt` and revokes only pending Invitations with `createdAt <= finalizedAt`. This prevents a fast re-signup with the same email from having a genuinely new, post-deletion Invitation revoked by the old User's still-running cleanup.

4. Blocker read model on `circles`
 - Add required `accountDeletionBlocked: boolean` and optional `accountDeletionBlockerAction: "archive" | "transfer"`.
 - Add `by_owner_and_account_deletion_blocked: [ownerUserId, accountDeletionBlocked]`.
 - One shared helper recomputes both fields from the Circle plus at most two effective active Members:
 - Personal Circle: not blocked.
 - Regular Circle with more than one effective active Member: `transfer`, regardless of active/archived/setup state.
 - Solo, active, setup-complete regular Circle: `archive`.
 - Solo setup-incomplete or solo archived regular Circle: not blocked.
 - Call the helper transactionally after every state transition that can change the answer: regular Circle creation/setup completion, archive/restore, Invitation acceptance, remove/leave, ownership transfer, Circle deletion, and Deleted Member materialization. Personal Circle creation is always unblocked.
 - This denormalization is required: finalization must prove there are no blockers with one bounded indexed `.first()`; scanning an unbounded set of owned Circles and then each Circle's Members is not acceptable.

5. Cleanup job
 - Add `accountDeletionJobs` with former `userId`, canonical `emailLower`, `finalizedAt`, phase, optional current `circleId`, timestamps, and an optional failure/diagnostic field. Index by former User id. The row is operational state and is deleted when cleanup completes.
 - If the E2E auth flow needs to retrieve the emailed token, add an E2E-only Account Deletion token row/index following the existing `e2eInvitationTokens` flag-gated pattern; include it in user cleanup. Never write or expose it when `E2E_TEST_AUTH` is unset.

No backfill/compatibility path: this is pre-alpha and project policy explicitly rejects obsolete compatibility layers. Update all seeds/builders to create the new required Circle fields.

### Effective Deleted Member semantics (immediate behavior without unbounded writes)

Finalization can delete one User with unbounded memberships, so it cannot synchronously patch every Member. Make app User absence the immediate logical tombstone:

- Add one shared member-identity helper used by Member, Transaction, Category, Search/filter, and History views. If the referenced app User row is absent, return effective status `deleted`, the stored Display Name, and no Profile Picture even if the background job has not patched that Member row yet.
- Add/reuse one shared effective-active predicate: stored status must be `active` **and** the referenced app User must exist. Use it in capacity counting, Member management/transfer targets, Paid By validation, notification fan-out, and any other live-member path. `deliverOne` should no-op, not throw, when its recipient User no longer exists.
- Default Member List reads include effective active Members only. Rename the widening argument from `includeRemoved` to `includeHistorical`; it includes both Removed and Deleted Members for Transaction/Search/History attribution. Update consumers and labels (`removed` versus `deleted account`) instead of treating every non-active state as Removed.
- History actor, Transaction member refs, and Category creator refs must all use the shared identity helper so a pre-materialization row cannot leak the deleted Profile Picture.
- Once the app `users` row is deleted, Circle access is already impossible because auth resolution cannot return that User. The helpers above also immediately remove the person from capacity and live UI. Durable cleanup then materializes `status: "deleted"`/cleared image in bounded batches. This satisfies both immediate product behavior and the bounded-write constraint.

### Server workflow

Implement a focused `packages/convex/convex/accountDeletion.ts`; do not spread the workflow through `users.ts` or `circles.ts`.

1. Readiness query
 - Add a paginated authenticated query over `circles.by_owner_and_account_deletion_blocked == true`.
 - Return only `circleId/ref`, Circle name, and action (`archive` or `transfer`). Build canonical refs server-side with existing `buildRef` conventions.
 - The Settings links are `/circles/:circleRef/settings` for archive and `/circles/:circleRef/members` for transfer.

2. Start verified deletion
 - Enable `user.deleteUser` in `createAuth`.
 - `sendDeleteAccountVerification` must parse the Better Auth User with Zod to obtain the Convex plugin's mapped `userId`; do not add a TypeScript cast.
 - From that callback, run an internal mutation that rechecks `by_owner_and_account_deletion_blocked`, then enqueues the verification email through the existing `emailPool`/`sendEmail` seam. A blocker throws before email is sent. The Better Auth verification row may already exist, but its undisclosed token is harmless.
 - Add the deletion email template to `@spend-circle/domain` and the existing dev email-preview surface. Use a token-specific Resend idempotency key. Do not send via raw fetch from the auth callback.
 - Do not email Better Auth's backend callback URL directly. Use the callback's supplied `token` to build `${SITE_URL}/delete-account/verify?token=...`. The public SPA route can explain missing/mismatched sessions and then call Better Auth's own token endpoint; Better Auth remains the token issuer/validator.

3. Verify/finalize
 - The public verification route waits for auth state. If signed out, it starts Google sign-in with the exact verification URL as `callbackURL`; after sign-in the same route resumes. If signed in, call `authClient.deleteUser({ token })` once. Better Auth validates token expiry and that `token.value === current session user.id`.
 - On success, navigate to a public completion page. On missing/expired/mismatched session/token, show a generic non-leaking error and a sign-in/retry path. Never log or analytics-capture the token.
 - In the Better Auth component `user.onDelete` trigger, normalize the mapped app User id, recheck the indexed blocker read model, create the cleanup job, delete the app `users` row, and schedule the first cleanup batch. These writes occur in the auth adapter User-deletion mutation; a blocker throw aborts final auth deletion. Keep the existing exported `onDelete` trigger API.
 - Better Auth then removes its User/session/account rows and clears auth cookies. Do not call `signOut` separately.

4. Durable bounded cleanup
 - Use a small constant batch (for example 32 documents). Each internal mutation processes one phase/batch and atomically schedules the next `ctx.scheduler.runAfter(0, ...)`. Query only indexed remaining rows with `.take(BATCH_SIZE)`; never `.collect()` an account-wide or Circle-wide dataset.
 - User phases, in order: convert active memberships; convert removed memberships; revoke pending Invitations created by the former User; revoke pending Invitations addressed to `emailLower`; delete owned Notifications; delete feedback email events; delete User invitation email events; delete E2E Account Deletion token metadata if present.
 - Each membership conversion writes exactly one Circle History event such as `member deleted`, with system actor, frozen Member Display Name, and no Notification. Each actual pending→revoked Invitation writes exactly one existing `invitation revoked` Circle History event with system actor and email change; the existing ADR 0028 read redaction still applies. Querying only remaining states makes retries idempotent and prevents duplicate History.
 - Invitation revocation phases may overlap; the first phase changes status, so the second phase cannot reprocess/re-record the same row. Do not call notification helpers.
 - Owned-Circle phases select one remaining Circle with `circles.by_owner.first()`, save it on the job, then batch-delete in this order: Histories, Transaction-Category joins, Transaction search projections, Transactions, Categories, Invitations, Circle-scoped invitation email events, E2E Invitation tokens, Members, then the Circle. Clear `circleId` and repeat until no owned Circle remains. Delete the job last.
 - Every phase transition and scheduling operation is in the same mutation as its writes. A retry sees only remaining source rows. Keep an internal resume entry point keyed by job id for operational recovery after a code/deployment error; it must be safe to call repeatedly.
 - Leave every other User's Notification row untouched, even if its text/link mentions the deleted User or a deleted Circle. Existing queued Invitation emails already re-read pending status and inviter existence, so revocation/User deletion makes them no-op.

### UI decisions

- Add a `Danger zone` card to Settings. While blockers exist, do not render/enable phrase confirmation; render every blocker with its exact archive/transfer link. Paginate/load more rather than truncate blockers.
- When unblocked, render a disabled Account Export CTA marked unavailable in this pre-alpha slice, the exact `DELETE MY ACCOUNT` input, and a destructive submit button enabled only on an exact case-sensitive match.
- The phrase is deliberate UI friction, not an authentication secret. Server security is the blocker checks plus Better Auth's matching-session email token; do not invent a second custom token/nonce protocol.
- After requesting deletion, show “Check your email” state and prevent duplicate in-flight requests. The account remains usable until verification completes.
- Add `requestAccountDeletion(token callback handled by Better Auth)`/deletion helpers to `apps/web-app/app/lib/auth-client.ts`, Convex readiness data hooks under `app/lib/data/`, and public verify/completion routes in `apps/web-app/app/routes.ts`.

### Required code touch points

- Backend: `schema.ts`, `auth.ts`, new `accountDeletion.ts`, `history.ts`, shared member identity helper, `members.ts`, `invitations.ts`, `circles.ts`, `model.ts`, `notify.ts`, Transaction/Category/Search view builders, `email.ts`, `convex.config.ts` only if an additional component is actually introduced (plain scheduler is sufficient).
- Domain: deletion email template and any new coded user-facing errors/labels.
- Web: `settings.tsx`, `settings.test.tsx`, `auth-client.ts`, data hooks, `routes.ts`, new public verification and completion routes/tests, History/member status labels, archived ownership-transfer regression coverage.
- Tests/helpers: put new shared seeds, scheduler draining, and component registration under `packages/convex/test/`, never the deployed `convex/` directory (ADR/project deploy-analyzer rule).

### Test matrix / completion proof

Backend tests must use real workflow helpers/wiring (mock only auth/vendor boundaries) and prove:

- Blocker derivation for every Product Contract row, including setup-incomplete with an unexpected co-Member and archived ownership transfer.
- Start is rejected with blockers; a blocker introduced after email issuance is rejected again by final `onDelete`.
- Auth User deletion trigger creates one cleanup job, removes the app User, immediately denies access, excludes the person from capacity/live Member reads, and suppresses Profile Picture before physical Member conversion.
- Active and already-Removed memberships become distinct Deleted Members; Display Name survives, image is cleared, History is written once, and a new User with the same Google email gets a new Member row rather than reactivation.
- Inviter and invitee-email pending Invitations are revoked once with History and no Notifications; Invitations created after `finalizedAt` survive.
- Only the deleted User's Notifications and user-scoped email-event rows are removed.
- Personal, solo setup-incomplete regular, and solo archived regular Circles delete every listed child table, including Transactions and multi-page History/projection/join data.
- More than one batch in every important phase completes; re-running the same batch/resume entry point is harmless; no mutation reads or writes more than the configured batch plus bounded lookup overhead.
- Other Users' Notifications and surviving Circle/Transaction/Category History remain byte-for-byte unchanged except for the newly appended deletion/revocation events.
- Better Auth configuration has verified deletion enabled and uses the matching-session token flow. Prefer one local E2E flow using the flag-gated auth path/token capture to prove verification, reactive sign-out, and inability to call protected queries afterward.

Web tests must prove blocker links, exact phrase gating, disabled Export CTA, email-sent/error states, archived transfer availability, signed-out verification→Google return-to behavior, one-shot token submission, completion routing, and Deleted-versus-Removed labels.

Run at minimum `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and the self-hosted `pnpm test:e2e:local` flow. Run `convex deploy`/the existing deploy-graph guard to catch test-only imports leaking into deployed modules.
