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
