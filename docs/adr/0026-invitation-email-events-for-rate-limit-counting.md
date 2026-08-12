# Invitation email-send events as a dedicated table for rate-limit counting

PocketCircle's invitation rate limits (PRD: 100 invitation emails / User / day, plus a per-address resend cap) were counted by scanning the `invitations` table — `createdAt` on the row plus a `resendTimestamps` array — which cannot faithfully count *email events* over a (user, time) or (circle, email, time) window. We model each email send as its own append-only row in a dedicated `invitationEmailEvents` table indexed for range queries, and enforce every invitation rate limit as a real range-count over it inside the same mutation that writes the invitation. We rejected counting on the `invitations` table (the original bug), the `@convex-dev/rate-limiter` component, and Redis.

## Context

Two defects made the per-User daily cap silently stop firing (issue MNT-3 / #190):

1. **Ordering starved the window.** The cap read `invitations.by_invitedByUserId` (indexed on `["invitedByUserId"]` only) with `.take(101)`, so it grabbed a User's 101 *oldest* invitations by `_creationTime`. Once a sender had ≥101 lifetime invitations, every examined row was ancient, the in-window count was ~0, and the cap stopped firing — exactly during a runaway script. A `cap + 1` early-exit is only valid when window-filtering happens *before* the limit at the index; here it happened after, in JS.

2. **Rows ≠ email events.** One invitation row represents up to 4 sends (1 create + 3 resends appended to `resendTimestamps`). Counting by row cannot count email events even with correct ordering.

Root cause: email-send events were not modeled as time-indexed, range-queryable records.

A related per-`(circle, email)` resend cap had the same class of bug: it read `resendTimestamps` *on the invitation row*, so **revoke → re-create the invite for the same email → resend ×3** reset the counter (a fresh row starts with an empty array).

## Decision

Model the send event, not the invitation state. Add:

```ts
invitationEmailEvents: defineTable({
  invitedByUserId: v.id("users"),
  circleId: v.id("circles"),
  emailLower: v.string(),
  kind: v.union(v.literal("create"), v.literal("resend")),
  sentAt: v.number(),
})
  .index("by_user_and_sentAt", ["invitedByUserId", "sentAt"])
  .index("by_circle_email_and_sentAt", ["circleId", "emailLower", "sentAt"])
```

One row is inserted per email send, **inside the mutation** (`createInvitation`, `resendInvitation`), co-located with the `emailPool.enqueueAction` call — so the event commits transactionally with the invitation write and rolls back with it. The events therefore count *enqueued* sends, which is the correct conservative basis for a spam cap (a later-failed or no-op'd send still counted).

All three invitation rate limits are range-counts over this one table — `invitations` remains the invitation *state* table and is no longer read for rate limiting:

| Cap | Filter | Limit |
|---|---|---|
| User daily | `invitedByUserId == u`, all kinds, `sentAt > now-24h` | 100 |
| Resend / address | `(circleId, emailLower)`, `kind == "resend"`, 24h | 3 |
| Create / address | `(circleId, emailLower)`, `kind == "create"`, 24h | 2 |

The user-daily cap range-counts on `by_user_and_sentAt` (correct ordering, valid early-exit). The two per-address caps range-read the tiny `(circle, email, 24h)` partition on `by_circle_email_and_sentAt` and filter `kind` in JS — safe precisely because that partition is a handful of rows, unlike the user-wide cap.

The `invitations.by_invitedByUserId` index and the `countRecentInvitationEmails` / `assertUnderDailyInvitationCap` helpers are removed.

## Considered options

- **Counting on the `invitations` table (status quo).** The bug itself. Resends are not rows, so it can never count email events; the row-scoped resend check is bypassable by revoke→recreate. Rejected.
- **`@convex-dev/rate-limiter` component.** Purpose-built, transactional, arbitrary-key (would fold the resend cap and future caps for free). Rejected for now: it would be the first registered component any test in this suite exercises (better-auth is mocked, workpool isn't exercised by a tested mutation), breaking every currently-green invitations test until a shared `registerComponent` harness exists; and it carries an unverified packaging risk (whether the published package ships globbable `src/component/**` for `import.meta.glob` convex-test registration). The event table kills the same bug class with the existing `convexTest(schema, modules)` harness and zero new infrastructure — lowest-risk proper fix. The component remains a reasonable future consolidation if more caps appear.
- **`@convex-dev/aggregate` counter.** Most scalable, heaviest infra. Overkill at this volume.
- **Redis.** Splits the cap invariant across two systems that cannot commit atomically with the Convex mutation (drift / double-count on retry; can't be called from a mutation). Wrong consistency model. Rejected.

## Consequences

- Every invitation rate limit is now correct regardless of a sender's lifetime invitation count, counts email *events* (creates + resends), and is enforced in the same transaction as the invitation write.
- The table doubles as an append-only audit log of invitation email sends (useful for EML-2 / abuse forensics).
- **`invitationEmailEvents` grows unbounded but never degrades correctness** — every cap query seeks the index to a 24h window, so cost is independent of table size. Pruning (a `crons.ts` daily delete of rows older than ~48h; no `crons.ts` exists yet) is storage hygiene only and is deferred.
- The create-per-address cap (2/day) hard-bounds the revoke→recreate vector: total emails to one address/24h ≤ 2 creates + 3 resends = 5, all attributable to an authenticated Owner. A new `inviteAddressCapReached` mutation error backs it; the existing `inviteDailyCapReached` / `inviteResendCapReached` contracts are unchanged (the limiter re-throws our own `ConvexError(mutationErrorData(...))`, preserving the web copy and `toMatchObject({ data })` tests).
