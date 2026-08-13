# MEM-3 · Accept Invitation + rejoin

| | |
|---|---|
| **Status** | Done · [PR #185](https://github.com/arpitdalal/PocketCircle/pull/185) |
| **Labels** | `area:membership`, `backend`, `ui`, `security` |
| **Depends on** | MEM-2 (SHIPPED — PR #177) |
| **PRD stories** | 13, 44 |
| **ADRs** | 0015, 0016, 0018, 0024 |
| **Glossary** | Invitation, Invitation Link, Google Account Email, Removed Member |

## Intent

The acceptance gate, and a security-critical one: an Invitation can be accepted **only by a
Google-authenticated User whose current Google Account Email matches the Invitation email**
(PRD 13) — invitations cannot be claimed by the wrong person. Acceptance must also handle
**rejoin**: if the accepting User was previously a Removed Member, reactivate their *existing*
member row (one row per (Circle, User) — never a duplicate) so their historical Transactions
reconnect to their current identity (PRD 44). Failed attempts must not leak whether a Circle
or invite exists (anti-enumeration, ADR 0016).

The `/invite/:token` public route exists as a scaffold only — it renders the raw token and
nothing else. This slice builds the actual accept UI there.

---

## Current state (verified — read before starting)

Already shipped (MEM-2, PR #177) — do NOT recreate:

- **`packages/convex/convex/invitationToken.ts`** — `generateInvitationToken()` +
  `hashInvitationToken(token)` (Web Crypto SHA-256 hex). Accept MUST use the same
  `hashInvitationToken` import; hashing is already correct.
- **`packages/convex/convex/invitations.ts`** — contains only `createInvitation` (mutation). It
  returns `{ token }` plaintext (interim manual delivery; EML-2 will move sending server-side and
  should drop this return — not this slice's concern).
- **`packages/convex/convex/schema.ts` `invitations` table** — fields: `circleId`, `emailLower`,
  `tokenHash`, `status` (`pending|accepted|revoked|expired`), `invitedByUserId`, `resendCount`,
  `createdAt`, `expiresAt`. Indexes: `by_circle`, `by_circle_and_email`, `by_token_hash`.
- **`packages/convex/convex/schema.ts` `members` table** — `by_circle_and_user` index
  (`.unique()` — one row per (circle, user)); fields include `status` (`active|removed`),
  `displayName`, `image`, `joinedAt`, `removedAt` (optional).
- **`packages/convex/convex/auth.ts`** — exports `requireCurrentUser(ctx)` (throws plain
  `Error("Not authenticated")` if not signed in) and `getCurrentUserOrNull(ctx)`. `users.email`
  is the live Google Account Email; `auth.ts` `onUpdate` trigger calls `syncUserEmail` to keep it
  current (ADR 0024).
- **`packages/convex/convex/guard.ts`** — `requireCircleAccess` / `resolveCircleAccess` /
  `getActiveMembership`. Note: `requireCircleAccess` needs an EXISTING `circleId` — accept starts
  from a token, not a `circleId`, so load the Circle directly via `ctx.db.get(invitation.circleId)`
  after resolving the invitation; do NOT call `requireCircleAccess` here.
- **`packages/convex/convex/history.ts`** — `recordEvent(ctx, { entity, actor, action, changes })`.
  `circleEntity(id)`. Membership events live on the CIRCLE entity. `changes` = frozen human strings;
  no raw IDs.
- **`apps/web-app/app/routes/invite.tsx`** — scaffold only (`/invite/:token`, public layout). Renders
  the token string and placeholder text. MEM-3 replaces the body entirely.
- **`apps/web-app/app/lib/data/invitations.ts`** — currently exports only `useCreateInvitation()`.
  This slice adds `useAcceptInvitation()` and `useInvitationPreview()` to the same file.
- **`apps/web-app/app/lib/data.ts`** — barrel; already re-exports `./data/invitations.js`.
- **`apps/web-app/app/lib/fixtures.ts`** — existing fixture helpers. Add `MOCK_INVITATION_PREVIEW`
  here.
- **`apps/web-app/app/test/convex-react.tsx`** — shared render wiring for web tests.
- **`apps/web-app/app/lib/mutation-user-message.ts`** — `mutationErrorMessageForUser(error, fallback)`.

Does NOT exist yet — create in this slice:

- `acceptInvitation` mutation in `packages/convex/convex/invitations.ts`.
- `getInvitationPreview` query in `packages/convex/convex/invitations.ts`.
- `useAcceptInvitation()` hook in `apps/web-app/app/lib/data/invitations.ts`.
- `useInvitationPreview()` hook (with MOCKS fork) in `apps/web-app/app/lib/data/invitations.ts`.
- `MOCK_INVITATION_PREVIEW` fixture in `apps/web-app/app/lib/fixtures.ts`.
- The full accept UI in `apps/web-app/app/routes/invite.tsx` (replacing the scaffold body).

---

## Implement

### 1. Backend — `acceptInvitation` mutation (`packages/convex/convex/invitations.ts`)

`args: { token: v.string() }`. Handler order (ALL checks before ANY write):

1. `const user = await requireCurrentUser(ctx)` — throws plain `Error` if not signed in;
   this is a Circle-less mutation so `requireCircleAccess` is NOT used here (guard.ts boundary
   note).
2. `const tokenHash = await hashInvitationToken(args.token)` — same fn as create, shared module.
3. `const invitation = await ctx.db.query("invitations").withIndex("by_token_hash", q => q.eq("tokenHash", tokenHash)).unique()`.
4. Generic invalid check (all branches produce identical output — ADR 0016):
   - `invitation === null` → throw generic `Error("Invitation invalid")`.
   - `invitation.expiresAt <= Date.now()` → throw generic.
   - `invitation.status !== "pending"` → throw generic (covers accepted/revoked/expired).
5. Email match: `invitation.emailLower !== user.email.toLowerCase()` → throw generic `Error("Invitation invalid")`. The user's LIVE `users.email` is the source of truth (ADR 0024; `onUpdate` syncs it).
6. Load Circle: `const circle = await ctx.db.get(invitation.circleId)`. If `circle === null` or
   `circle.setupCompletedAt === null` → throw generic `Error("Invitation invalid")`. (An invitation
   to an incomplete or deleted Circle is not distinguishable from a bad token — ADR 0016.)
7. **Upsert membership** via `by_circle_and_user` — single index lookup, no N+1:
   ```
   const existingMembership = await ctx.db
     .query("members")
     .withIndex("by_circle_and_user", q => q.eq("circleId", circle._id).eq("userId", user._id))
     .unique();
   ```
   - If `existingMembership?.status === "removed"` (**REJOIN**): `ctx.db.patch(existingMembership._id, { status: "active", displayName: user.displayName, image: user.image ?? undefined, removedAt: undefined })`. Preserve the original `joinedAt` — it marks the first join; use the existing row id so old Transactions' `recordedByMemberId`/`paidByMemberId` reconnect automatically (PRD 44).
   - Else insert a fresh active row: `ctx.db.insert("members", { circleId: circle._id, userId: user._id, role: "member", status: "active", displayName: user.displayName, image: user.image ?? undefined, joinedAt: Date.now() })`.
   - Hold the resulting member doc (patch → re-read with `ctx.db.get`; insert → use the returned id to load) as `membership`.
8. Mark invitation used: `ctx.db.patch(invitation._id, { status: "accepted" })`. Single-use enforced.
9. `recordEvent(ctx, { entity: circleEntity(circle._id), actor: membership, action: "member joined", changes: [{ field: "member", to: membership.displayName }] })`.
10. Return `{ circleId: circle._id }` so the web client can redirect to the Circle after accept.

### 2. Backend — `getInvitationPreview` query (`packages/convex/convex/invitations.ts`)

`args: { token: v.string() }`. Public query (no auth required — the landing page is pre-login).

1. Hash: `const tokenHash = await hashInvitationToken(args.token)`.
2. Look up invitation by `by_token_hash`. If missing, expired (`expiresAt <= Date.now()`), or
   `status !== "pending"` → `return null`. (No throw — it's a query; `null` is the "generic invalid"
   signal, ADR 0016.)
3. Load Circle. If `circle === null` or `circle.setupCompletedAt === null` → `return null`.
4. Load the Owner user: `ctx.db.get(circle.ownerUserId)` (the Circle's `ownerUserId` field).
5. Return only what the landing screen needs:
   ```ts
   {
     circleName: circle.name,
     ownerDisplayName: ownerUser.displayName,
     ownerImage: ownerUser.image ?? null,
     invitedEmail: invitation.emailLower,
   }
   ```
   Nothing else (no circleId, no invitation id, no token, no status). ADR 0016: returning the
   full Circle object would leak Circle existence to unauthenticated callers.

### 3. Web — data hooks (`apps/web-app/app/lib/data/invitations.ts`)

Add alongside the existing `useCreateInvitation`:

```ts
export function useAcceptInvitation() {
  return useMutation(api.invitations.acceptInvitation);
}

export type InvitationPreview = NonNullable<FunctionReturnType<typeof api.invitations.getInvitationPreview>>;

export function useInvitationPreview(token: string | undefined): InvitationPreview | null | undefined {
  const queried = useQuery(
    api.invitations.getInvitationPreview,
    MOCKS || !token ? "skip" : { token },
  );
  return MOCKS ? MOCK_INVITATION_PREVIEW : queried;
}
```

Import `MOCK_INVITATION_PREVIEW` from `../fixtures.js`. `FunctionReturnType` from `convex/server`
(ADR 0003 — derive, never hand-write). The barrel `apps/web-app/app/lib/data.ts` already
re-exports this file; no change needed there.

### 4. Web — mock fixture (`apps/web-app/app/lib/fixtures.ts`)

```ts
export const MOCK_INVITATION_PREVIEW: InvitationPreview = {
  circleName: "Mock Shared Circle",
  ownerDisplayName: "Alex",
  ownerImage: undefined,
  invitedEmail: "you@example.com",
};
```

Type it against the derived `InvitationPreview` type (imported from `~/lib/data.js`) so a
shape change to `getInvitationPreview` fails typecheck here (ADR 0003).

### 5. Web — `/invite/:token` UI (`apps/web-app/app/routes/invite.tsx`)

Replace the scaffold body. States to handle:

- **Loading** — preview is `undefined`; show a subtle spinner or skeleton.
- **Invalid / not found** — preview is `null`; show a generic "This invitation is no longer valid"
  message. Never reveal WHY (expired vs wrong-email vs used). `role="alert"`.
- **Valid (not signed in)** — show Circle name, Owner avatar + name, invited-email. Show a
  "Sign in to accept" CTA that routes to login (Google OAuth). The email-match check is
  server-side only; the UI does NOT do a client-side email comparison.
- **Valid (signed in)** — same preview + "Accept invitation" button. On click: call
  `useAcceptInvitation()({ token })`. Button disabled while in-flight (guard double-submit).
  On success: redirect to the Circle (`/circles/<circleId>` using the returned `circleId`).
  On error: map via `mutationErrorMessageForUser(error, "Something went wrong")`, display with
  `role="alert"`. Even a generic-invalid accept error shows only a neutral message — never
  distinguish cases to the client.
- **Auth check**: use the existing auth session hook to detect signed-in state. The route is in
  the public layout (no auth gate); auth-state branching is done inside the route component.

Form primitives: `apps/web-app/app/components/ui/button.tsx` and related. No new form fields
needed — accept is a single button.

---

## Why this way

- **Email match is server-side, off live `users.email`** (ADR 0024): Google is the one-time
  identity seed; `onUpdate` keeps `users.email` current. The client NEVER claims an email;
  the server compares `invitation.emailLower` to `user.email.toLowerCase()`.
- **`requireCurrentUser`, not `requireCircleAccess`**: accept is Circle-less at entry (we only
  have a token). Guard.ts explicitly documents this boundary — `requireCircleAccess` is for
  operations on a KNOWN existing Circle. Resolve the invitation first, then load the Circle
  directly.
- **Rejoin reactivates the same row**: `recordedByMemberId`/`paidByMemberId` on old Transactions
  hold `members._id`; reusing the same row id means those references reconnect without any
  backfill (PRD 44). Never insert a second row — the `by_circle_and_user` unique-backed lookup
  catches it.
- **Single-use**: patching to `accepted` immediately means a concurrent second accept attempt
  will find `status !== "pending"` and get the generic invalid signal.
- **Setup-complete before join**: `setupCompletedAt === null` → generic invalid. A stale invite
  to an incomplete Circle cannot add a non-owner member.
- **Generic failures everywhere** (ADR 0016): missing token, wrong email, expired, used/revoked,
  and incomplete Circle all return the identical observable signal. An attacker cannot enumerate
  Circles or emails via the accept endpoint.
- **`getInvitationPreview` returns minimal fields**: only what the landing screen renders.
  Returning a full Circle object would confirm to an unauthenticated caller that a Circle with
  that id exists (ADR 0016).
- **EML-2 note**: `createInvitation` currently returns `{ token }` plaintext so the inviting
  Owner can share the link manually. When EML-2 lands it moves sending server-side and removes
  that return. MEM-3 reads the token from the URL — unaffected by that flip.

---

## Open question — throttle on failed accept attempts

The PRD mentions rate-limiting failed attempts. **No rate-limiter component is installed**
(verified: `convex.config.ts` registers only `betterAuth` + `workpool`; `@convex-dev/rate-limiter`
is NOT present). Options:

1. **Defer (recommended for v1)**: the natural throttle is already strong — `by_token_hash`
   lookups cost one indexed read, tokens are 32 bytes of entropy (2^256 hash space), and
   single-use accept means a valid token is consumed on first success. Brute-force is not a
   meaningful threat. Document this explicitly in the PR; revisit in MEM-4 or a dedicated
   rate-limit slice if the PRD escalates it.
2. **Hand-roll a failed-attempt counter**: add a `failedAcceptAttempts` field to the invitation
   row and a `lastFailedAt` timestamp; reject if `failedAcceptAttempts >= N` within a window.
   Adds DB writes on every failure path, complicates the generic-invalid guarantee (the write
   must still happen even when we return generic), and requires careful expiry. Not worth it
   unless the PRD sets an explicit cap.
3. **Install `@convex-dev/rate-limiter`**: cleanest abstraction, but adds a dependency and a
   Convex component. Overkill for v1 given the token entropy argument above.

**Recommended**: option 1 (defer). Call it out in the PR. If the product owner wants an explicit
cap before ship, option 2 is the in-repo path; option 3 if a rate-limiter component is added
for other slices (MEM-4, EML-1, FBK-1).

---

## How to test

Backend tests in `packages/convex/convex/invitations.test.ts` (extend the existing file;
mock `./auth.js` via `vi.mock` exactly as `members.test.ts` / `guard.test.ts` do — Better Auth
cannot run under convex-test). Seed helpers from `packages/convex/convex/test/seed.ts`.

**`acceptInvitation` — backend:**

- **Happy (new member)**: signed-in User whose email matches → active member row inserted,
  `invitation.status === "accepted"`, `"member joined"` event on the Circle entity with
  `changes: [{ field: "member", to: <displayName> }]`, no raw IDs; link no longer acceptable
  (reuse → generic invalid).
- **Rejoin**: User previously Removed from the Circle accepts a fresh invite → the **same**
  member row id is preserved (assert `membership._id` unchanged), `status` flipped to `active`,
  `displayName`/`image` refreshed from the current User, `removedAt` cleared; old Transactions
  whose `recordedByMemberId` or `paidByMemberId` referenced that member id still resolve
  correctly (no `null`/dangling ref).
- **Email mismatch**: signed-in User with a different email → generic invalid error; no member
  row written; invitation still `pending`.
- **Expired**: `expiresAt <= Date.now()` → generic invalid; no write.
- **Already accepted**: invite with `status === "accepted"` → generic invalid; no second member row.
- **Revoked**: `status === "revoked"` → generic invalid.
- **Incomplete Circle**: `setupCompletedAt === null` → generic invalid; no member row.
- **Unauthenticated**: `requireCurrentUser` throws → propagates (not a generic-invalid; the
  function never reaches the token check).
- **Anti-enumeration**: missing token, wrong email, expired, used/revoked, and incomplete Circle
  all produce the SAME generic error message and identical observable side effects (no row written
  in any case).
- **Invariants**: run accept twice concurrently (simulated); assert exactly one member row per
  (Circle, User) — no duplicate insert.
- **History**: assert `"member joined"` event has no raw IDs in `changes`.

**`getInvitationPreview` — backend:**

- **Happy**: returns `{ circleName, ownerDisplayName, ownerImage, invitedEmail }` for a pending,
  unexpired invitation in a setup-complete Circle.
- **Missing token**: returns `null`.
- **Expired**: returns `null`.
- **Non-pending status**: accepted/revoked → returns `null`.
- **Incomplete Circle**: `setupCompletedAt === null` → returns `null`.
- **Minimal surface**: assert the returned object has EXACTLY the four fields above — no circleId,
  no tokenHash, no invitation id, no status.

Web tests in `apps/web-app/app/routes/invite.test.tsx` (new file; shared render wiring from
`apps/web-app/app/test/convex-react.tsx`):

- **Loading state**: preview `undefined` → spinner/skeleton visible; Accept button absent.
- **Invalid state**: preview `null` → generic "no longer valid" message with `role="alert"`;
  Accept button absent.
- **Valid, not signed in**: preview populated, no auth session → "Sign in to accept" CTA;
  Accept button absent.
- **Valid, signed in**: preview populated, auth present → Accept button enabled; clicking calls
  `acceptInvitation`; button disabled while in-flight; success → redirect to Circle.
- **Accept error**: mutation rejects → `mutationErrorMessageForUser`-mapped message displayed
  with `role="alert"`; Accept button re-enables.
- **Mock parity**: `MOCK_INVITATION_PREVIEW` shape matches the derived `InvitationPreview`
  type (typecheck enforces; also render once under MOCKS and assert the preview fields display).

E2E test `e2e/invite-accept.spec.ts` (Playwright vs real self-hosted backend, ADR 0019):

- Owner invites an email; second test user signs in with that email and visits the link → accepted,
  redirected to the Circle, appears in the member list.
- Rejoin: remove the member, re-invite, same user accepts → member list shows them again (same
  row — verify via member id or history "member joined" event count).
- Wrong-email user signs in and visits the link → generic error shown; first user unaffected.

---

## Done when

- Only the matching Google Account Email can accept; links are single-use; rejoin reactivates
  the SAME member row (old Transactions reconnect); incomplete/missing Circles cannot be joined;
  all failure branches return the identical generic signal; `"member joined"` event recorded with
  no raw IDs; throttle decision documented in the PR (deferred or option chosen); the preview
  reveals only the four minimal fields; comprehensive tests green; all gates pass
  (`pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`).

## Out of scope

Creating/resending/revoking invitations (MEM-2, MEM-4); the invitation email (EML-2);
installing a rate-limiter component (belongs with MEM-4 or a dedicated platform slice if
needed). EML-2 will flip `createInvitation` to stop returning the plaintext token — MEM-3 is
unaffected; it reads the token from the URL only.
