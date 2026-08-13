# MEM-4 · Manage Invitations: list / resend / revoke

| | |
|---|---|
| **Status** | Done · [PR #183](https://github.com/arpitdalal/PocketCircle/pull/183) |
| **Labels** | `area:membership`, `backend`, `ui`, `security` |
| **Depends on** | MEM-2 (shipped, PR #177) |
| **Unlocks** | MEM-8 (archive bulk-revoke calls `revokeInvitation` directly) |
| **PRD stories** | 14, 15, 17 |
| **ADRs** | 0015, 0016, 0018 |
| **Glossary** | Invitation, Invitation Link, Owner |
| **Cross-slice** | EML-2 consumes the rotated token from `resendInvitation` (same producer/consumer relationship as `createInvitation`→EML-2) |

## Current state (verified — read before starting)

Already in place; do NOT recreate:

- **`packages/convex/convex/invitations.ts`** — `createInvitation` mutation only. The entire
  module is one export. MEM-4 adds three more exports to this same file.
- **`packages/convex/convex/invitationToken.ts`** — `generateInvitationToken()` and
  `hashInvitationToken(token)` both exist and are the shared token utilities used by MEM-2
  and MEM-3. Reuse them for resend's token rotation; do not duplicate.
- **`packages/convex/convex/schema.ts` `invitations` table** — fields: `circleId`,
  `emailLower`, `tokenHash`, `status` (`pending|accepted|revoked|expired`),
  `invitedByUserId`, `resendCount`, `createdAt`, `expiresAt`. Indexes: `by_circle`,
  `by_circle_and_email`, `by_token_hash`. **No `by_invitedByUserId` index exists today** —
  MEM-4 must add one (see rate-limit design below).
- **`packages/domain/src/mutation-errors.ts`** — catalog has: `circle.archived`,
  `category.nameDuplicate`, `invite.forbidden`, `invite.setupIncomplete`,
  `invite.personalCircle`, `invite.alreadyMember`, `invite.alreadyPending`. MEM-4 adds
  `invite.resendCapReached` and `invite.dailyCapReached`.
- **`apps/web-app/app/routes/circle/members.tsx`** — `CircleMembers` (default export),
  `InviteMemberForm` (Owner-only, shows after invite). MEM-4 adds
  `PendingInvitationsList` (Owner-only) below the invite form and above `MemberList`.
- **`apps/web-app/app/lib/data/invitations.ts`** — `useCreateInvitation()` hook only.
  MEM-4 adds `usePendingInvitations(circleId)`, `useResendInvitation()`, and
  `useRevokeInvitation()` to this same file.
- **`apps/web-app/app/lib/data.ts`** — already re-exports `./data/invitations.js`; no
  barrel change needed.
- **`apps/web-app/app/lib/fixtures.ts`** — no `MOCK_PENDING_INVITATIONS` fixture exists
  yet; MEM-4 creates it, typed against the derived `PendingInvitation` view type.
- **`packages/convex/convex/test/seed.ts`** — `seedCircle`, `addMember`, `makeUser`
  exist. No `seedInvitation` helper exists; MEM-4 adds one.

Does NOT exist yet — you create in this slice:

- `listPendingInvitations` query in `invitations.ts`.
- `resendInvitation` and `revokeInvitation` mutations in `invitations.ts`.
- `invite.resendCapReached` and `invite.dailyCapReached` coded errors in `mutation-errors.ts`
  + `mutation-errors.test.ts` coverage.
- `by_invitedByUserId` index on `invitations` in `schema.ts` (justified by daily-cap query).
- `resendTimestamps` field on `invitations` table — a `v.array(v.number())` tracking the
  epoch-ms of each resend within the current day window (justified below).
- `usePendingInvitations`, `useResendInvitation`, `useRevokeInvitation` hooks in
  `apps/web-app/app/lib/data/invitations.ts`.
- `PendingInvitation` type (derived via `FunctionReturnType`) in `data/invitations.ts`.
- `MOCK_PENDING_INVITATIONS` fixture in `fixtures.ts`.
- `seedInvitation` helper in `packages/convex/convex/test/seed.ts`.
- `PendingInvitationsList` component in `members.tsx`.

## Intent

Membership management is **private to the Owner** (PRD 14). The Owner can **resend** a pending
Invitation — rotating to a fresh single-use link that invalidates all older ones (PRD 15) — and
**revoke** it entirely (PRD 17). Resend is rate-limited: **≤3 resends/day per Circle+email**
and **≤100 invitation emails/User/day** overall (PRD rate-limits).

The resend cap protects against accidental spam (the Owner hitting Resend repeatedly), while the
daily-cap protects the email provider (EML-2's Resend account) against a runaway script.

## Implement

Build layers bottom-up in this order: schema → backend → domain errors → query/mutation hooks → fixtures → UI.

### 1. Schema (`packages/convex/convex/schema.ts`)

Two changes, both justified:

**a. New field `resendTimestamps: v.array(v.number())` on `invitations` table.**

`resendCount` is a LIFETIME counter and cannot enforce a per-day cap without knowing WHEN each
resend happened. The simplest correct approach is an append-only array of epoch-ms timestamps,
one entry per resend event. At resend time: filter `resendTimestamps` to entries within the last
24 h; if that count ≥ 3, throw `invite.resendCapReached`. Then append `Date.now()` to the array.
This avoids an extra table, avoids a rolling-window query, and keeps the full audit trail on the
row. The array is bounded (cap is 3/day; lifetime resends are practically small; Convex document
limits are not a concern here).

**b. New index `by_invitedByUserId` on `invitations` table.**

The `≤100 invitation emails/User/day` cap requires counting all invitations (creates AND resends)
attributed to a User in the last 24 h. There is no existing index on `invitedByUserId`. Add:

```ts
.index("by_invitedByUserId", ["invitedByUserId"])
```

README §4 explicitly permits adding an index when a query needs one. This is the justified
schema change. At create time `createInvitation` must ALSO enforce the daily cap (add this check
there); at resend time `resendInvitation` enforces it before rotating the token. Both queries
use `by_invitedByUserId` + in-memory filter on `createdAt > Date.now() - 24h` (bounded by the
100-item cap: the query collects at most 101 rows before stopping — use `.take(101)` to avoid
scanning the whole index).

The `resendCount` field STAYS (it is the lifetime count displayed to the Owner in the UI).
`resendTimestamps` is ADDED alongside it.

### 2. Domain errors (`packages/domain/src/mutation-errors.ts`)

Add to the `defineMutationErrorCatalog({...})` call:

```ts
inviteResendCapReached: defineMutationError(
  "invite.resendCapReached",
  "This invitation has been resent too many times today. Try again tomorrow.",
),
inviteDailyCapReached: defineMutationError(
  "invite.dailyCapReached",
  "You've sent too many invitation emails today. Try again tomorrow.",
),
```

Extend `packages/domain/src/mutation-errors.test.ts` to cover both new codes (same assertion
style as existing tests: assert catalog inclusion, code value, and message).

### 3. Backend — `invitations.ts` additions

**`listPendingInvitations` (query)**

```ts
args: { circleId: v.id("circles") }
```

Handler:

1. `const access = await resolveCircleAccess(ctx, args.circleId)` — never throws.
2. `if (!access || !access.isOwner) return null` — non-owner Members get `null` (not an empty
   array — `null` signals "no permission", aligning with ADR 0016 missing≡inaccessible for
   queries). Non-members also get `null` from `resolveCircleAccess`.
3. Query `invitations` `by_circle` where `status === "pending"` and `expiresAt > now`. Use
   `.withIndex("by_circle", (q) => q.eq("circleId", args.circleId))` then `.collect()` — pending
   invitations per Circle are naturally bounded (one row per email, only the single non-expired
   pending row per email at any given time; revoked/accepted rows do not appear). Justify this
   bound explicitly in a code comment. Do NOT expose `tokenHash` or any internal id in the
   returned shape.
4. Return `{ id, email: emailLower, createdAt, expiresAt, resendCount }[]` — derive the
   `PendingInvitation` view type in `data/invitations.ts` via `FunctionReturnType`.

**`resendInvitation` (mutation)**

```ts
args: { invitationId: v.id("invitations") }
```

Handler (exact order — all checks before any write):

1. Load the invitation: `const invitation = await ctx.db.get(args.invitationId)`. If null,
   throw `new Error("Invitation not found")` (plain — anti-enumeration, ADR 0016).
2. `const access = await requireCircleAccess(ctx, invitation.circleId)` — if the Circle is
   inaccessible, the plain Error from step 1 is replaced by `requireCircleAccess`'s own plain
   "Circle not found" throw. Either way a non-member can't tell what exists.
3. `if (!access.isOwner) throw new ConvexError(mutationErrorData(MUTATION_ERRORS.inviteForbidden))`.
4. `access.assertWritable()` — archived Circle → `circle.archived`.
5. `if (invitation.circleId !== access.circle._id) throw new Error("Invitation not found")` —
   confirms the loaded invitation actually belongs to this Circle (defense-in-depth; the
   `requireCircleAccess` above only proves the caller can access the Circle, not that the
   invitation ID they passed belongs to it).
6. `if (invitation.status !== "pending" || invitation.expiresAt <= Date.now()) throw new Error("Invitation not found")` —
   a revoked/accepted/expired invitation cannot be resent; same generic throw to avoid leaking
   state (a revoked invitation "not found" to the Owner prevents enumeration of whether an
   email was ever invited).
7. `if (invitation.circleId's circle.setupCompletedAt === null) throw new ConvexError(... inviteSetupIncomplete)` —
   same setup guard as `createInvitation`. Use `access.circle.setupCompletedAt`.
8. **Per-email resend cap:** filter `invitation.resendTimestamps` (field added in step 1) to
   entries `> Date.now() - 24 * 60 * 60 * 1000`. If `>= 3`, throw
   `new ConvexError(mutationErrorData(MUTATION_ERRORS.inviteResendCapReached))`.
9. **Daily User cap:** `const recentByUser = await ctx.db.query("invitations").withIndex("by_invitedByUserId", q => q.eq("invitedByUserId", access.user._id)).take(101)`. Count those with
   `createdAt > Date.now() - 24h` OR any entry in `resendTimestamps > Date.now() - 24h`
   (i.e. an invitation created or resent by this User in the last 24 h). If count >= 100,
   throw `new ConvexError(mutationErrorData(MUTATION_ERRORS.inviteDailyCapReached))`.
   Using `.take(101)` bounds the read — collect stops at 101 rows, never scans the full index.
10. Generate new token: `const token = generateInvitationToken(); const tokenHash = await hashInvitationToken(token)`.
11. Patch: `await ctx.db.patch(args.invitationId, { tokenHash, expiresAt: Date.now() + INVITE_TTL_MS, resendCount: invitation.resendCount + 1, resendTimestamps: [...(invitation.resendTimestamps ?? []), Date.now()] })`.
12. `await recordEvent(ctx, { entity: circleEntity(access.circle._id), actor: access.membership, action: "invitation resent", changes: [{ field: "email", to: invitation.emailLower }] })`.
13. `return { token }` — plaintext token for EML-2 (same producer pattern as `createInvitation`;
    when EML-2 ships and moves the send server-side, stop returning the token to the client).

**`revokeInvitation` (mutation)**

```ts
args: { invitationId: v.id("invitations") }
```

Handler:

1. Load invitation — same generic throw on null as resend.
2. `requireCircleAccess(ctx, invitation.circleId)` — isOwner + assertWritable() (same as resend
   steps 2–5, including the Circle-ownership confirmation).
3. `if (invitation.status !== "pending") throw new Error("Invitation not found")` — cannot
   revoke an already-accepted or already-revoked invitation.
4. `await ctx.db.patch(args.invitationId, { status: "revoked" })`.
5. `await recordEvent(ctx, { entity: circleEntity(access.circle._id), actor: access.membership, action: "invitation revoked", changes: [{ field: "email", from: invitation.emailLower }] })`.
6. Return nothing (void).

**Seed helper (`packages/convex/convex/test/seed.ts`)**

Add `seedInvitation(ctx, circleId, invitedByUserId, opts)` that inserts an invitation row
directly via `ctx.db.insert`. `opts`: `{ email, status?, expiresAt?, resendCount?, resendTimestamps? }`.
Default `status: "pending"`, `expiresAt: Date.now() + 7d`, `resendCount: 0`,
`resendTimestamps: []`, `tokenHash: await hashInvitationToken(generateInvitationToken())`.
Returns the invitation `_id`. Tests call this instead of going through `createInvitation` so
they can set up arbitrary states (expired, revoked, specific timestamps) directly.

### 4. Web — data hooks (`apps/web-app/app/lib/data/invitations.ts`)

Add to the existing file (do NOT replace `useCreateInvitation`):

```ts
import type { FunctionReturnType } from "convex/server";
import { useQuery, useMutation } from "convex/react";
import { MOCKS } from "../env.js";
import { MOCK_PENDING_INVITATIONS } from "../fixtures.js";
import type { Circle } from "./circles.js";

/** Derived view type — cannot drift from `listPendingInvitations` return shape (ADR 0003). */
export type PendingInvitation = NonNullable<
  FunctionReturnType<typeof api.invitations.listPendingInvitations>
>[number];

/** Owner-only pending invitations for a Circle. null = no permission / inaccessible.
 *  undefined = loading. Mock mode returns MOCK_PENDING_INVITATIONS. */
export function usePendingInvitations(
  circleId: Circle["id"],
): PendingInvitation[] | null | undefined {
  const queried = useQuery(
    api.invitations.listPendingInvitations,
    MOCKS ? "skip" : { circleId },
  );
  return MOCKS ? MOCK_PENDING_INVITATIONS : queried;
}

export function useResendInvitation() {
  return useMutation(api.invitations.resendInvitation);
}

export function useRevokeInvitation() {
  return useMutation(api.invitations.revokeInvitation);
}
```

### 5. Fixtures (`apps/web-app/app/lib/fixtures.ts`)

Add `MOCK_PENDING_INVITATIONS: PendingInvitation[]` with at least two entries (one recent, one
near-expiry) so the component test exercises the list. Import `PendingInvitation` from
`./data.js` (already re-exports `data/invitations.js`). Use branded mock ids as in
`MOCK_MEMBERS`.

### 6. Web — `PendingInvitationsList` on members page (`apps/web-app/app/routes/circle/members.tsx`)

Add `PendingInvitationsList` component below `InviteMemberForm` and above `MemberList`.
Only render it when `canInvite` (Owner of a regular Circle — same guard as the invite form).

`PendingInvitationsList` receives `circleId: Circle["id"]`. It calls
`usePendingInvitations(circleId)`, `useResendInvitation()`, and `useRevokeInvitation()` internally.

UI requirements:
- **Loading state** — skeleton (reuse `SkeletonRegion` + `RowsSkeleton`).
- **null / empty** — show nothing or a "No pending invitations" message (null means no permission,
  which the `canInvite` guard above already prevents rendering this component for non-owners, so
  null in practice means a late-null edge; handle gracefully, same pattern as `MemberList`).
- **Non-empty** — list with one row per invitation showing: `emailLower`, relative expiry (e.g.
  "Expires in 5 days"), `resendCount`. Two action buttons per row: **Resend** and **Revoke**.
- **Resend action** — calls `resendInvitation({ invitationId: id })`. On success, surface the
  new Invitation Link in the same copyable/accessible element pattern as `InviteMemberForm`. On
  coded error, map via `mutationErrorMessageForUser`. Disable while in-flight; guard double-submit.
- **Revoke action** — calls `revokeInvitation({ invitationId: id })`. On success the row
  disappears (the query result updates live via Convex reactivity). Show a transient accessible
  confirmation (e.g. `role="status"`). On coded error, map via `mutationErrorMessageForUser`.
- Handle all error states with `role="alert"`.

## Why this way

**Owner-only enforced at the server (ADR 0015).** `resolveCircleAccess` returning `null` for
non-owners in the query, and `requireCircleAccess` + `isOwner` check in mutations, are the real
gate. The UI hiding the component is a courtesy on top.

**Resend rotates the hash, not the row.** `by_token_hash` lookup in MEM-3's accept handler will
simply miss when given an old token — the row now has a new `tokenHash`. This is how "only the
latest unexpired link accepts" works without tracking old tokens or invalidating them explicitly.

**Invitation rate limits count email *events*, not invitation rows (ADR 0026 / MNT-3 #190).**
> ⚠️ **Superseded — do not copy.** This slice originally shipped two row-scoped counters: a
> `resendTimestamps: number[]` array on the invitation row for the per-email resend cap, and a
> `.take(101)` scan over a `by_invitedByUserId` index for the 100/User/day cap. **Both were wrong:**
> - The `.take(101)` scan reads a User's *oldest* invitations (the index has no time component),
>   so once a sender has ≥101 lifetime invitations the in-window count is ~0 and the daily cap
>   silently stops firing. A `cap + 1` early-exit is only valid when window-filtering happens at
>   the index *before* the limit — here it happened afterward, in JS.
> - One invitation row is up to 4 sends (1 create + 3 resends), so counting by row can never count
>   email events; and the `resendTimestamps`-on-the-row resend cap resets on revoke → re-create.
>
> The correct model is a dedicated append-only `invitationEmailEvents` table — one row per send,
> indexed for range queries — with every cap enforced as a real `(field == x) && sentAt > now-24h`
> range-count inside the same mutation as the invitation write. See **ADR 0026** and **MNT-3 (#190)**
> for the full schema, the three caps (User 100/day; resend 3/day per `(circle,email)`; create
> 2/day per `(circle,email)`), and the rejected alternatives (`@convex-dev/rate-limiter`, Redis).

**No rate-limiter component is used (confirmed in `convex.config.ts`).** `betterAuth` and
`emailWorkpool` are the only components. The caps are enforced against the `invitationEmailEvents`
table via range queries (ADR 0026); the `@convex-dev/rate-limiter` component was considered and
deferred (it would be the first tested component in this suite and carries a convex-test
registration risk).

**Anti-enumeration (ADR 0016).** A non-existent invitation, a revoked/accepted invitation, and
one belonging to a different Circle all throw the identical generic plain `Error("Invitation not
found")`. The Owner-facing `ConvexError` coded paths (cap reached, setup incomplete, etc.) are
only reachable after identity + ownership + writability are confirmed — they do not leak
invitation existence.

**Resend returns plaintext token (same as create) until EML-2.** Once EML-2 lands, stop
returning `token` to the client in both `createInvitation` and `resendInvitation`.

**`setupCompletedAt` guard on resend.** The same guard as create and accept — a stale pending
invitation cannot be refreshed before the Circle's setup is done.

**`revokeInvitation` is a first-class mutation, not a state toggle.** MEM-8 (archive) reuses
this mutation's logic to bulk-revoke all pending invitations on archive. When implementing MEM-8,
call `revokeInvitation` (or extract the core patch+recordEvent into a shared helper in
`invitations.ts`) — do not re-derive the revoke logic there.

## How to test

Backend tests in `packages/convex/convex/invitations.test.ts` (extend the existing suite;
`vi.mock("./auth.js")` already hoisted; use `seedCircle`, `addMember`, `makeUser` from
`packages/convex/convex/test/seed.ts`; add `seedInvitation` in this slice and use it here).

**`listPendingInvitations`**
- Owner sees pending, non-expired invitations for their Circle; shape includes `{id, email, createdAt, expiresAt, resendCount}` and NO `tokenHash`.
- Non-owner active Member → `null`.
- Non-member User → `null`.
- Unauthenticated → `null`.
- Expired invitations (`expiresAt <= now`) do not appear.
- Revoked / accepted invitations do not appear.
- Multiple pending invitations all appear (seed 3, assert 3).

**`resendInvitation`**
- Happy path: returns new `{ token }`, `tokenHash` on the row changes, `expiresAt` advances by 7 d,
  `resendCount` increments by 1, `resendTimestamps` gets one new entry.
- Old token can no longer be accepted (verify via MEM-3's `acceptInvitation` with the old token
  → generic invalid; new token → accepted). If MEM-3 is not yet shipped, assert the old hash is
  gone from the row instead.
- Archived Circle → `circle.archived`.
- Non-owner Member → `invite.forbidden`.
- Non-member User → generic plain throw (no coded error).
- Invitation belonging to a different Circle → generic "Invitation not found" (plain Error).
- Revoked invitation → generic "Invitation not found".
- Expired invitation → generic "Invitation not found".
- Setup incomplete (`setupCompletedAt === null`) → `invite.setupIncomplete`.
- **Per-email resend cap:** seed an invitation with `resendTimestamps` containing 3 entries all
  within the last 24 h → `invite.resendCapReached`. Seed with 3 entries all > 24 h ago → succeeds
  (window resets). Seed with 2 within 24 h + 1 outside → succeeds (only in-window count matters).
- **Daily User cap:** seed 100 invitations (or invitations with resendTimestamps) attributed to
  the Owner within the last 24 h → `invite.dailyCapReached` on the 101st. Seed 99 within window
  + 1 outside → succeeds.
- History event: action `"invitation resent"`, entity = Circle, actor = Owner membership,
  `changes: [{ field: "email", to: emailLower }]`, no raw IDs.
- Circle History redacts that `email` change for non-Owners at read time (ADR 0028); keep storing
  it here for the current Owner's audit.
- `resendCount` across multiple resends: after 2 resends `resendCount === 2` (starts at 0 on
  create).

**`revokeInvitation`**
- Happy path: invitation `status` becomes `"revoked"`.
- Subsequent `acceptInvitation` (MEM-3) with the invitation's token → generic invalid.
- Archived Circle → `circle.archived`.
- Non-owner Member → `invite.forbidden`.
- Non-member → generic plain throw.
- Already-revoked invitation → generic "Invitation not found".
- Already-accepted invitation → generic "Invitation not found".
- Invitation from different Circle → generic "Invitation not found".
- History event: action `"invitation revoked"`, `changes: [{ field: "email", from: emailLower }]`.
- Circle History redacts that `email` change for non-Owners at read time (ADR 0028); keep storing
  it here for the current Owner's audit.

**Domain errors (`packages/domain/src/mutation-errors.test.ts`)**
- `invite.resendCapReached` and `invite.dailyCapReached` appear in the catalog.
- Their code strings are the canonical literal values.

Web tests in `apps/web-app/app/routes/circle/members.test.tsx` (extend the existing file;
shared render wiring in `apps/web-app/app/test/convex-react.tsx`):

- Owner sees `PendingInvitationsList` with fixture rows; non-owner does not.
- Resend button calls mutation; success shows copyable link; in-flight button disabled.
- Revoke button calls mutation; row disappears (mock the reactive update).
- Coded error `invite.resendCapReached` renders user copy via `mutationErrorMessageForUser`.
- Coded error `invite.dailyCapReached` renders user copy.
- Loading state renders skeleton.
- Empty list (no pending invitations) renders gracefully.
- **Mock parity:** `MOCK_PENDING_INVITATIONS` satisfies `PendingInvitation[]` typecheck (enforced
  by `fixtures.ts` import typing — a shape change to `listPendingInvitations` breaks typecheck here).

## Done when

- `listPendingInvitations` returns Owner-only pending invitations, never `tokenHash`, never for
  non-owners or non-members.
- `resendInvitation` rotates token (old link invalid, new link valid), refreshes expiry, bumps
  `resendCount`, appends `resendTimestamps`, enforces ≤3 resends/day per Circle+email and ≤100
  invitation emails/User/day, blocks setup-incomplete and archived Circles, records event.
- `revokeInvitation` sets status revoked, blocks archived Circles and non-owners, records event.
- `invite.resendCapReached` and `invite.dailyCapReached` coded errors exist in the catalog and are
  mapped to user copy by `mutationErrorMessageForUser`.
- `by_invitedByUserId` index and `resendTimestamps` field added to schema.
- Owner-only `PendingInvitationsList` on the Members page with resend/revoke actions.
- Query and mutation data hooks (`usePendingInvitations`, `useResendInvitation`,
  `useRevokeInvitation`) with MOCKS fork + fixture.
- `seedInvitation` helper in `test/seed.ts`.
- Comprehensive tests green; all gates pass (`pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`).

## Out of scope

Sending the invitation email (EML-2 — it consumes the token returned by `createInvitation` and
`resendInvitation`). Flipping off the client token return when EML-2 ships (that PR touches both
`createInvitation` and `resendInvitation`). Archive-driven bulk revoke (MEM-8 — it calls
`revokeInvitation` logic). Accepting an invitation (MEM-3).
