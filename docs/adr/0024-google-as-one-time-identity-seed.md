# Google is a one-time identity seed; PocketCircle owns the profile

At first sign-in (the Better Auth `onCreate` trigger) PocketCircle seeds a User's
`displayName`, `image`, and `email` from Google. Afterward Google no longer
overwrites `displayName` or `image` — the User owns them in PocketCircle (Display
Name is editable in-app; Profile Picture becomes editable when uploads land) —
while `email` stays synced with Google because it is identity- and
delivery-critical. We chose this over mirroring the full Google profile on every
sign-in so that user edits are never clobbered and users manage their identity in
our app rather than in Google, removing that round-trip friction.

## Consequences

- The Better Auth `user.onUpdate` trigger is reduced to syncing `email` only; it
  no longer propagates `displayName`/`image`.
- Amends ADR 0018: materialized member-identity propagation (refresh ACTIVE
  memberships, leave Removed Members frozen) is now triggered by the in-app
  `updateProfile` mutation, not the auth trigger.
- `displayName`/`image` may drift from the live Google profile by design; this is
  accepted (almost nobody changes their Google name, and the app value is now the
  owned one).
- Security: invitation acceptance matches the **live** Google session email
  (`authUser.email`), not a stored snapshot, so a changed Google email cannot be
  exploited through a stale copy.
- The Personal Circle name is seeded from the Google first name at creation and auto-tracks the User's
  Display Name until the owner manually renames it (`personalNameCustomizedAt` on the Circle row; absent
  ⇒ auto-tracking). After a manual rename, Onboarding and App Settings Display Name edits no
  longer change the Circle name. The Mark always derives from the Circle's current name via the shared
  `initials` helper at every write that can change the name (bootstrap, identity reconcile, manual rename).
  Identity-driven reconciles patch directly (no Circle History event). Fallback when no usable first token:
  **Personal Circle** (mark `"PC"`). The field is optional — existing rows need no backfill.
- Circle Settings exposes a **Match my display name** toggle (USR-2): when on, the Personal Circle
  name and Mark auto-track Display Name edits again; turning it on immediately re-derives from the
  current Display Name; turning it off (or manually renaming) sets `personalNameCustomizedAt` and
  stops auto-sync. No Circle History event for toggle-driven reconciles.
