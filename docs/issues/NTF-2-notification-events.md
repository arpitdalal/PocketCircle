# NTF-2 · Notification creation on events

| | |
|---|---|
| **Status** | Done |
| **Labels** | `area:notifications`, `backend` |
| **Depends on** | NTF-1 (done) · event-emitting slices: MEM-3/4/5/7/8, TXN-1/3, CAT-2 (all merged) |
| **PRD stories** | 81 |
| **ADRs** | 0015, 0016, 0018 |
| **Glossary** | Notification Center |

## Intent

The fan-out slice — built **last** (Tier 4), now that every action that emits an event exists. v1
Notifications are **focused on events that directly involve the User** (glossary) and are created
**server-side, in the same mutation/transaction as the action** (ADR 0015), so action and
notification can never diverge. The v1 events:

- An **Invitation you sent is accepted** → the inviting Owner is notified.
- An **Invitation to you is revoked** (and you already have an account) → you are notified.
- You are **removed from a Circle** → you are notified.
- **Ownership is transferred to you** → you (the new Owner) are notified.
- A **Circle you belong to is archived / restored** → every other Member is notified.
- A **Transaction is recorded with Paid By = you by another Member** → you are notified.
- **Your** Transaction is **archived / restored by someone else** (the Owner) → you are notified.
- **Your** Category is **archived / restored by someone else** (the Owner) → you are notified.

**The actor is never notified about their own action.** This is the load-bearing rule that keeps the
center free of self-spam (PRD 86) and is centralized in the single writer (see below).

> **Two events deliberately excluded from v1 (do not wire them):**
> - **Invitation *expired*.** There is **no expiry-detection path** in the backend — an invitation's
>   `status` never transitions to `"expired"`; expiry is evaluated lazily (`expiresAt <= now` is
>   filtered out in `listPendingInvitations` / rejected in `acceptInvitation`, leaving `status:
>   "pending"`). There is no cron and no other trigger, so there is nothing to hook. Building expiry
>   detection is out of scope for this fan-out slice.
> - **Being *added* to a Circle.** The only way to join is by accepting your *own* Invitation
>   (`acceptInvitation`), which is a self-action — the joiner is the actor, so per the actor rule
>   there is no notification. (The *inviter* is notified instead; see "accept" below.)

## Current state (read before implementing)

- **The writer lives in** [`notify.ts`](../../packages/convex/convex/notify.ts) — `notifyUser` is the sole
  `db.insert("notifications", …)` in production code (guarded by `deployGraph.test.ts`). Typed
  per-event constructors assemble canonical links via the domain builders and centralize the
  actor-skip rule.
- **The table already exists** (created in NTF-1) — `notifications` in
  [`schema.ts`](../../packages/convex/convex/schema.ts:245). **Do not redefine or add columns.**
  Fields: `userId: Id<"users">`, `type: string`, `title: string`, `body?: string`, `link?: string`
  (canonical in-app path), `read: boolean`, `createdAt: number`. Indexes `by_user`,
  `by_user_and_read`. New rows are inserted with `read: false`.
- **The reader is done** — NTF-1's
  [`notifications.ts`](../../packages/convex/convex/notifications.ts) lists **unread-only**, newest
  first, and **re-resolves each `link` for accessibility at read time** (drops to text-only when the
  User can't reach the target). So NTF-2 only ever *writes* rows; it never resolves links.
- **Link builders already exist** — reuse, don't rebuild — in
  [`packages/domain/src/notification-links.ts`](../../packages/domain/src/notification-links.ts):
  `buildCircleNotificationLink(circleRef)`,
  `buildTransactionNotificationLink(circleRef, transactionRef)`,
  `buildCategoryNotificationLink(circleRef, categoryRef)`. They emit exactly the three canonical
  shapes NTF-1's parser (`parseNotificationLinkPath`) understands — this is the writer/reader
  contract; do **not** hand-format link strings.
- **Refs** — a `<slug>-<id>` ref segment is built with `buildRef(name, id)` from
  `@pocketcircle/domain` (already imported server-side, e.g.
  [`circles.ts:44`](../../packages/convex/convex/circles.ts:44),
  [`transactions.ts:141`](../../packages/convex/convex/transactions.ts:141)). Build a circle ref from
  `buildRef(circle.name, circle._id)`, a transaction ref from `buildRef(txn.title, txn._id)`, a
  category ref from `buildRef(category.name, category._id)`.
- **`recordEvent`** in [`history.ts`](../../packages/convex/convex/history.ts:92) is the model to
  mirror: a **single deep module that is the sole writer** of its table, with typed constructors so
  call sites read clearly and the row shape lives in one place. `notifyUser` is its notification
  analogue.
- **Data each call site already has** (no new lookups beyond what's noted):
  - Members carry `userId` (`Doc<"members">.userId`); the acting member is usually
    `access.membership` (so the actor's userId is `access.membership.userId` /
    `access.user._id`).
  - A user can be found by email via the `by_email` index on `users`
    ([`schema.ts:16`](../../packages/convex/convex/schema.ts)).
  - Active members of a Circle: `members` `by_circle_and_status` index, `status: "active"`.

## Implement

### 1. The single writer — `packages/convex/convex/notify.ts`

- **`notifyUser(ctx, args)`** — the **sole** `db.insert("notifications", …)` in the codebase
  (mirror `recordEvent`; no scattered inserts). It inserts one row with `read: false`,
  `createdAt: Date.now()`, and the supplied `userId`, `type`, `title`, `body?`, `link?`.
- **Centralize the actor rule here.** Accept the recipient `userId` **and** the acting user's id;
  when they are equal, `notifyUser` **no-ops** (returns without inserting). This encodes "never
  notify the actor" in exactly one place so a call site can't forget it. (For fan-out call sites
  that already exclude the actor while iterating, this is a harmless second guard.)
- **Typed per-event constructors** so call sites read as the event they emit and the `type` string +
  title/body/link conventions are defined once — e.g. `notifyInvitationAccepted`,
  `notifyInvitationRevoked`, `notifyRemovedFromCircle`, `notifyOwnershipTransferred`,
  `notifyCircleArchived` / `notifyCircleRestored`, `notifyPaidBySet`, `notifyTransactionArchived` /
  `…Restored`, `notifyCategoryArchived` / `…Restored`. Each takes the typed entities it needs
  (recipient, actor, circle/txn/category) and assembles the canonical link via the domain builders.
- **`type` values** are a closed set — define them as an `as const` union so a typo can't create an
  unknown type. **Titles/bodies are frozen display strings written once at the action site**
  (mirroring history, ADR 0018) and must be **ID-free** in user-facing text (use names, e.g. the
  Circle name, Transaction title, Category name).

### 2. Wire the call sites (the bulk of the slice)

Each row: emit the notification **inside the existing mutation, after the action's `recordEvent`**.
Recipient is resolved as shown; `notifyUser`'s actor-skip prevents self-notification.

| Event | Mutation (file:fn) | Recipient userId | Skip when | Link |
|---|---|---|---|---|
| Invitation accepted | [`invitations.ts:238`](../../packages/convex/convex/invitations.ts:238) `acceptInvitation` | `invitation.invitedByUserId` | recipient == acceptor | circle |
| Invitation revoked | [`invitations.ts:432`](../../packages/convex/convex/invitations.ts:432) `revokeInvitation` | user found via `users` `by_email` on `invitation.emailLower` | **no account for that email** (skip — nothing to notify) | none¹ |
| Removed from Circle | [`members.ts:129`](../../packages/convex/convex/members.ts:129) `removeMember` | `target.userId` | — (owner is actor) | circle² |
| Ownership transferred | [`members.ts:75`](../../packages/convex/convex/members.ts:75) `transferOwnership` | `targetMember.userId` (the **new** owner) | — (old owner is actor) | circle |
| Circle archived | [`circles.ts:334`](../../packages/convex/convex/circles.ts:334) `archiveCircle` | every **other** active Member (`members` `by_circle_and_status`, `status:"active"`) | the acting Owner | circle |
| Circle restored | `circles.ts` `restoreCircle` | same fan-out as archive | the acting Owner | circle |
| Paid By set | [`transactions.ts:520`](../../packages/convex/convex/transactions.ts:520) `createTransaction` | `paidByMember.userId` | `paidByMember._id === recordedByMemberId` (the existing guard) | transaction |
| Transaction archived | [`transactions.ts:873`](../../packages/convex/convex/transactions.ts:873) `archiveTransaction` | recorder's userId (`db.get(txn.recordedByMemberId).userId`) | recorder == actor (recorder archived own) | transaction |
| Transaction restored | `transactions.ts` `restoreTransaction` | recorder's userId | recorder == actor | transaction |
| Category archived | [`categories.ts:456`](../../packages/convex/convex/categories.ts:456) `archiveCategory` | `category.creatorUserId` | creator == actor (creator archived own) | category |
| Category restored | `categories.ts` `restoreCategory` | `category.creatorUserId` | creator == actor | category |

¹ The revoked invitee is not (and may never have been) a Member, so a Circle link would always
resolve to text-only at read time. Omit the link — the title carries the meaning. (Setting one is
harmless but pointless.)

² A removed Member's Circle link resolves to **text-only** for them immediately (NTF-1 drops it),
and would relight if they later rejoin. Setting the circle link is fine and intentional.

Notes per the existing handlers:
- **Paid By**: `createTransaction` already computes `paidByMember` and `recordedByMemberId`
  ([transactions.ts:547-554](../../packages/convex/convex/transactions.ts:547)); reuse them. The
  member-level guard `paidByMember._id !== recordedByMemberId` is the "another Member" condition —
  notify `paidByMember.userId`.
- **Txn archive/restore**: permitted by recorder **or** Owner (`canArchive`). When the recorder
  acts on their own Transaction, the actor-skip suppresses the notification; only an Owner (or other
  moderator) acting on someone else's Transaction notifies the recorder.
- **Category archive/restore**: same shape — `canArchive` is creator or Owner; the actor-skip means
  only a non-creator (the Owner) triggers a notification to `creatorUserId`.
- **Circle archive/restore fan-out**: iterate active Members and call `notifyUser` per Member;
  the actor-skip drops the acting Owner. A solo Circle therefore emits nothing.

## Why this way

- **Single writer (`notifyUser`)** — notification row shape, `type` set, title/link conventions, and
  the **actor-skip rule** live in one tested place, exactly like `recordEvent` owns the audit write.
  No `db.insert("notifications")` anywhere else.
- **Created at the action site, server-side, same transaction** (ADR 0015) — the mutation that
  performs the action emits the notification atomically, so they can't drift or partially apply.
- **Reuse the domain link builders** — the three canonical shapes are a contract with NTF-1's parser
  ([`notification-links.ts`](../../packages/domain/src/notification-links.ts)); hand-formatting a
  link would let the writer and reader diverge silently.
- **Frozen title/body, re-resolved link** — title/body are written once (ADR 0018, like history);
  the `link` is re-checked for accessibility on every read by NTF-1, so access changes (removal,
  archive, deletion) are handled at read time, not at write time.
- **Only User-involving events, never the actor** — no generic Circle-activity feed and no
  self-notifications (PRD 86: no activity spam).

## How to test

Convex tests (`notify.test.ts` + assertions in the existing per-slice test files, real logic via
`convex-test`; **no mocks of our own modules** — perform the real mutation and read the resulting
rows):

- **Per event type:** performing each action above creates **exactly the right notification(s)** for
  the right User(s), with the correct `type`, an ID-free `title`, and the canonical `link` built from
  the domain builders. Assert the recipient is the *involved* party, not the actor.
- **Actor-skip / no over-notification:**
  - Paid By = self (or omitted) on create → **no** notification.
  - Recorder archives/restores their **own** Transaction → no notification; an Owner archiving
    someone else's → recorder notified.
  - Creator archives/restores their **own** Category → no notification; Owner doing it → creator
    notified.
  - Circle archive/restore notifies every active Member **except** the acting Owner; a solo Circle
    → zero notifications.
- **Revoke edge:** revoking an Invitation whose email **has** an account notifies that User; an
  email with **no** account creates **no** notification (no crash).
- **Excluded events:** assert (or document via the absence of a wire) that Invitation **expiry** and
  self-**join** create no notification — they have no trigger.
- **Link shape:** the stored `link` round-trips through NTF-1's `parseNotificationLinkPath`
  (cross-slice: write via NTF-2, read via NTF-1 — accessible target keeps the link; after the
  recipient loses access it renders text-only).
- **Single write per action:** one action emits one notification per recipient (no duplicates).

## Done when

- Every v1 user-involving event in the matrix emits the correct notification via the single
  `notifyUser` writer at its action site; the actor is never self-notified; expiry and self-join emit
  nothing; links are built only from the domain builders; comprehensive per-event Convex tests are
  green; lint/typecheck/test gates pass.

## Out of scope

The center / read-state UI (NTF-1, done); emails (EML-*); Invitation-expiry detection and any
expiry notification (no trigger exists in v1); a generic Circle-activity feed.
