# MEM-5 · Remove Member

| | |
|---|---|
| **Status** | Done · [PR #186](https://github.com/arpitdalal/PocketCircle/pull/186) |
| **Labels** | `area:membership`, `backend`, `ui` |
| **Depends on** | MEM-1 (SHIPPED) |
| **Cross-ref** | MEM-3 (rejoin reactivates same row; edit rights return), MEM-7 (Owner must transfer before being removable) |
| **PRD stories** | 42, 43, 44 |
| **ADRs** | 0015, 0016, 0018 |
| **Glossary** | Owner, Removed Member, Recorded By |

## Current state (verified — read before starting)

Already in place; do NOT recreate:

- **`packages/convex/convex/members.ts`:** `listMembers` query + `toMemberView(member,
  currentMemberId)` → `MemberView { id, displayName, image, role, status, joinedAt, isSelf }`.
  The query accepts an `includeRemoved` boolean arg. **No mutations exist yet** — `removeMember`
  is added in this slice.
- **`packages/convex/convex/guard.ts`:** `requireCircleAccess` → `AuthorizedCircle { user,
  membership, circle, isOwner, isWritable, assertWritable() }`. `getActiveMembership(ctx,
  circleId, userId)` returns `null` when the membership status is not `"active"`. Edit-rights loss
  after removal is therefore **automatic**: TXN-2 (`requireTransactionAccess`) and CAT-2
  (`requireCategoryAccess`) compare against the caller's RESOLVED active membership — once a member
  is `"removed"`, `getActiveMembership` returns `null`, `resolveCircleAccess` returns `null`, and
  their edit rights vanish with zero extra work in TXN-2/CAT-2.
- **`packages/convex/convex/history.ts`:** `recordEvent(ctx, { entity: circleEntity(circle._id),
  actor: access.membership, action, changes })`. No raw IDs — Members appear by Display Name.
- **`packages/convex/convex/schema.ts` `members` table:** `by_circle_and_user` (.unique(), one row
  per (circle, user)); `by_circle`, `by_circle_and_status`, `by_user` indexes; fields
  `status: "active"|"removed"`, `role: "owner"|"member"`, `displayName`, `image`, `joinedAt`,
  `removedAt?: number`. Removal is a **status flip, never a delete** — MEM-3 rejoin reactivates
  the SAME row (PRD 44).
- **`packages/convex/convex/model.ts` `setUserDisplayName`:** mirrors the owner's Display Name onto
  ACTIVE member rows (`status === "active"`) and **skips removed rows** — so a removed member's
  `displayName`/`image` stay frozen at removal time automatically. Do NOT call or clear anything
  on removal; `setUserDisplayName` already handles the skip.
- **`packages/domain/src/mutation-errors.ts`:** catalog with `circleArchived`,
  `categoryNameDuplicate`, `inviteForbidden`, `inviteSetupIncomplete`, `invitePersonalCircle`,
  `inviteAlreadyMember`, `inviteAlreadyPending`. This slice adds `memberRemoveForbidden`.
- **`apps/web-app/app/routes/circle/members.tsx`:** `CircleMembers` renders `MemberList` (active
  members, Owner-first) and an Owner-only `InviteMemberForm`. This slice adds an Owner-only remove
  action per non-owner member row with a confirmation dialog.
- **Data hook pattern:** `apps/web-app/app/lib/data/invitations.ts` → `useCreateInvitation` (thin
  `useMutation`). This slice adds `useRemoveMember` in `apps/web-app/app/lib/data/members.ts` and
  re-exports it from `apps/web-app/app/lib/data.ts` (already barrels all `data/*`).
- **Dialog primitive:** the app uses `@base-ui/react/dialog` (`Dialog.Root`, `Dialog.Portal`,
  `Dialog.Backdrop`, `Dialog.Popup`, `Dialog.Title`, `Dialog.Description`, `Dialog.Close`) — see
  `apps/web-app/app/components/ui/filter-panel.tsx` for the canonical usage pattern. No
  pre-built confirmation-dialog component exists; build a small inline one on the members page
  using the same `Dialog` import.
- **Test doubles:** `apps/web-app/app/test/convex/members.ts` (`membersDouble`, `MembersState`,
  `makeMemberView`) and `apps/web-app/app/test/convex/core.ts` (`configureConvex`). This slice
  extends `MembersState` with a `removeMember?: Mock` field and wires it in `membersDouble`,
  following the same pattern as `InvitationsState` in `invitations.ts`.

Does NOT exist yet — you create it in this slice:

- `removeMember` mutation in `packages/convex/convex/members.ts`.
- `memberRemoveForbidden` coded error in `packages/domain/src/mutation-errors.ts`.
- Owner-only remove button + confirmation dialog in `apps/web-app/app/routes/circle/members.tsx`.
- `useRemoveMember` hook in `apps/web-app/app/lib/data/members.ts`.
- `MembersState.removeMember` field + wiring in `apps/web-app/app/test/convex/members.ts`.

## Intent

The Owner can remove a Member from a regular Circle. Removal must **preserve history**: the
Member's Transactions stay in the Circle with their **frozen** Display Name + Profile Picture
(PRD 43), and the Removed Member **loses edit rights** on their Transactions/Categories until
they rejoin (PRD 42, 44). Removal is a status flip on the existing member row — never a delete
— so rejoin (MEM-3) can reactivate the same row and reconnect identity.

## Implement

### 1. Domain — coded error (`packages/domain/src/mutation-errors.ts`)

Add one entry to `defineMutationErrorCatalog(...)`. This is the only new error this slice
needs:

```ts
memberRemoveForbidden: defineMutationError(
  "member.removeForbidden",
  "Only the Circle owner can remove members",
),
```

Extend `packages/domain/src/mutation-errors.test.ts` to cover the new code (the existing test
asserts catalog/code behavior — extend it).

### 2. Backend — `removeMember` mutation (`packages/convex/convex/members.ts`)

Add a `mutation` export to the existing file (alongside `listMembers`). Args:
`{ circleId: v.id("circles"), memberId: v.id("members") }`. Follow the canonical mutating-handler
shape from `guard.ts`. Exact order — each check before any write:

1. `const access = await requireCircleAccess(ctx, args.circleId)` — folds in auth + the
   missing≡inaccessible rule (ADR 0016). A non-member caller gets "Circle not found".
2. `if (!access.isOwner) throw new ConvexError(mutationErrorData(MUTATION_ERRORS.memberRemoveForbidden))`.
3. `access.assertWritable()` — archived Circle ⇒ coded `circle.archived`.
4. `if (access.circle.kind === "personal") throw new Error("Circle not found")` — Personal
   Circle is always-solo; treat as inaccessible (ADR 0016 anti-enumeration, same plain-Error path).
5. `const target = await ctx.db.get(args.memberId)` — `null` or a member that belongs to a
   different circle → `throw new Error("Member not found")` (plain Error, anti-enumeration).
   Check: `!target || target.circleId !== args.circleId`.
6. `if (target.role === "owner") throw new Error("Cannot remove the Circle owner — transfer ownership first (MEM-7)")` — plain Error; no coded error needed (the UI never offers the button for the owner row).
7. `if (target.status === "removed") throw new Error("Member is already removed")` — defensive; the
   UI should not surface this case but the mutation must guard it.
8. `const now = Date.now()`.
9. `await ctx.db.patch(args.memberId, { status: "removed", removedAt: now })` — **leave
   `displayName`/`image` untouched.** `setUserDisplayName` already skips removed rows (model.ts),
   so frozen identity is guaranteed with no extra code.
10. `await recordEvent(ctx, { entity: circleEntity(access.circle._id), actor: access.membership,
    action: "member removed", changes: [{ field: "member", from: target.displayName }] })` — no
    raw IDs; the actor is the Owner's membership row; `from` is the removed member's Display Name
    at the moment of removal (their materialized name, frozen).

Edit-rights loss is automatic: `getActiveMembership` stops resolving for the removed User, so
`requireTransactionAccess` / `requireCategoryAccess` both return access without the membership,
and any edit attempt fails with "Circle not found" — zero extra work needed.

### 3. Web — data hook (`apps/web-app/app/lib/data/members.ts`)

Add alongside `useMembers`:

```ts
export function useRemoveMember() {
  return useMutation(api.members.removeMember);
}
```

The barrel `apps/web-app/app/lib/data.ts` already re-exports everything from `data/members.ts` —
no barrel change needed.

### 4. Web — UI (`apps/web-app/app/routes/circle/members.tsx`)

**Remove button:** In `MemberList`, for each non-owner, non-self, active member row, render an
Owner-only "Remove" button (derive `isOwner` from the `members` prop — the member with
`isSelf === true && role === "owner"` — and pass it as a prop to `MemberList`). The button opens
a confirmation dialog.

**Confirmation dialog:** Build an inline `RemoveMemberDialog` component using `@base-ui/react/dialog`
(`Dialog.Root`, `Dialog.Portal`, `Dialog.Backdrop`, `Dialog.Popup`, `Dialog.Title`,
`Dialog.Description`, `Dialog.Close`, two `Button`s for Cancel/Confirm). It takes `{ open,
onOpenChange, memberName, onConfirm, confirming, error }` props. The Popup must have `role="alertdialog"` (destructive confirmation), `aria-labelledby` pointing to `Dialog.Title`, and
`aria-describedby` pointing to `Dialog.Description`. Error shows as `role="alert"`. Disable the
Confirm button while `confirming === true`.

**Wiring in the member row:**

```tsx
// Rough sketch — adapt to the existing row JSX:
const [removingId, setRemovingId] = useState<Member["id"] | null>(null);
const [removeError, setRemoveError] = useState<string | null>(null);
const [removing, setRemoving] = useState(false);
const removeMember = useRemoveMember();

async function handleRemoveConfirm() {
  if (!removingId) return;
  setRemoving(true);
  setRemoveError(null);
  try {
    await removeMember({ circleId, memberId: removingId });
    setRemovingId(null);
  } catch (caught) {
    setRemoveError(
      mutationErrorMessageForUser(caught, "Couldn't remove the member. Please try again."),
    );
  } finally {
    setRemoving(false);
  }
}
```

On success the live `listMembers` query drops the row automatically (the member's status flips to
`"removed"` and the default `includeRemoved: false` filter removes them). No manual state clear
of the list.

**Accessibility:** The remove button has `aria-label={`Remove ${member.displayName}`}`. The dialog
Confirm button is labeled "Remove member". On error in the dialog, `role="alert"`.

Pass `circleId` down to `MemberList` (the page already has it from `useCircle()`).

### 5. Web — test double (`apps/web-app/app/test/convex/members.ts`)

Extend `MembersState`:

```ts
export interface MembersState {
  members?: Member[] | null;
  removeMember?: Mock;
}
```

Wire in `membersDouble`:

```ts
mutations: {
  [getFunctionName(api.members.removeMember)]: removeMember,
},
```

## Why this way

- **Status flip, not delete,** preserves the one-row-per-(Circle, User) invariant that makes
  rejoin and frozen identity work (ADR 0018). Never delete the row.
- **Frozen identity without extra code:** `setUserDisplayName` in `model.ts` already skips rows
  where `membership.status !== "active"`. Removal leaves `displayName`/`image` alone — they
  freeze by omission. Do NOT clear them on removal.
- **Edit-rights loss is automatic via `getActiveMembership`:** once `status` flips to `"removed"`,
  `resolveCircleAccess` returns `null` for that user, and all entity-level permission checks
  (TXN-2, CAT-2) flow through `resolveCircleAccess` → no special case needed there.
- **Owner can't be removed while Owner** — they must transfer first (MEM-7). Plain `Error`, not a
  coded `ConvexError`: the UI never surfaces the button on the owner row, so only a direct API
  call reaches this path. Anti-enumeration doesn't apply here (it's the owner's own Circle).
- **Personal Circle guard stays a plain Error** (same "Circle not found" surface as the
  missing/inaccessible path) — the always-solo invariant is enforced structurally.
- **Coded `ConvexError` only for `memberRemoveForbidden`** (non-owner attempting removal) — this
  is a legitimate authenticated user whose form action must surface copy; the pattern mirrors
  `inviteForbidden`.
- **`Dialog` from `@base-ui/react/dialog`** is the only dialog primitive in the app; no separate
  confirm-dialog component exists. Build an inline one on the members page — don't install a new
  dependency.

## How to test

Backend tests in `packages/convex/convex/members.test.ts` (convex-test; mock `./auth.js` via
`vi.mock` exactly as `invitations.test.ts` / `guard.test.ts` do — Better Auth can't run under
convex-test). Seed via `packages/convex/convex/test/seed.ts`.

**Permissions:**
- Owner removes a non-owner active member → succeeds; row has `status:"removed"`,
  `removedAt` set, `displayName`/`image` unchanged.
- Non-owner member calls `removeMember` → `member.removeForbidden` (coded ConvexError).
- Removed Member calls `removeMember` (their `getActiveMembership` returns null) → "Circle not
  found" (plain Error; same as non-member).
- Owner calls `removeMember` with `memberId` from a different circle → "Member not found" (plain
  Error; anti-enumeration ADR 0016).
- Owner tries to remove the Owner's own membership id → "Cannot remove the Circle owner" (plain
  Error).
- Owner calls on a Personal Circle → "Circle not found" (plain Error).
- Owner calls on an archived Circle → `circle.archived` (coded ConvexError via `assertWritable()`).
- Owner calls with a memberId that doesn't exist (`ctx.db.get` returns null) → "Member not found".
- Owner calls to remove an already-removed member → "Member is already removed" (defensive guard).

**Frozen identity:**
- After removal, `target.displayName` and `target.image` are unchanged on the DB row.
- Run `setUserDisplayName(ctx, removedUserId, "New Name")` after removal — assert the removed
  row's `displayName` is still the original name (not updated). This proves the `model.ts` skip
  holds.

**Edit-rights loss (cross-check TXN-2/CAT-2):**
- Assert that after removal `resolveCircleAccess` returns `null` for the removed user (via
  `getActiveMembership` returning null).
- In TXN-2 and CAT-2 test files: assert a `removeMember` flip causes the removed user's
  subsequent edit/archive mutation to fail with "Circle not found" / "Transaction not found".

**Transactions still render with frozen creator identity:**
- After removal, `listMembers({ circleId, includeRemoved: true })` includes the removed member
  with their frozen `displayName`/`image`. Assert the returned view shape matches the row.

**Rejoin reconnect:**
- After removal, MEM-3 rejoin reactivates the SAME member row (same `_id`); edit rights return.
  Cross-reference MEM-3's test for this invariant; note it here without duplicating the test.

**History:**
- After `removeMember`, exactly one `"member removed"` event is recorded on the Circle entity.
- Actor is the Owner's `membership._id` (via `recordEvent`).
- `changes: [{ field: "member", from: <removed member's displayName> }]` — no raw IDs.

**Live update (convex-test):**
- Call `removeMember`, then re-query `listMembers({ circleId })` (default `includeRemoved: false`)
  — the removed member no longer appears.
- Re-query with `{ circleId, includeRemoved: true }` — removed member appears with `status:
  "removed"`.

Web tests in `apps/web-app/app/routes/circle/members.test.tsx` (extend existing file; shared
render wiring is `apps/web-app/app/test/convex-react.tsx`):

- Owner sees a "Remove" button on non-owner member rows; does NOT see it on the owner row or on
  their own row.
- Non-owner member does NOT see any remove buttons (courtesy-hide; server is the real gate).
- Clicking "Remove" opens the confirmation dialog with the member's name in the description.
- Clicking "Cancel" closes the dialog without calling the mutation.
- Clicking "Confirm" in the dialog calls `removeMember({ circleId, memberId })`, disables the
  Confirm button while in-flight.
- A coded mutation error (e.g. `member.removeForbidden`) renders the mapped user copy via
  `mutationErrorMessageForUser` inside the dialog with `role="alert"`.
- On success the row disappears (live query reflects the updated state — model the query returning
  the filtered list after removal).

**E2E (`e2e/*.spec.ts`):**
- Owner logs in, opens Members page for a regular Circle, removes a non-owner member; confirms
  the row disappears from the list. Non-owner logs in and cannot see remove buttons. Attempt
  removal as non-owner via direct API call returns the coded error. Removed member's Transactions
  still appear with the frozen name.

## Done when

- Owner can remove active non-owner Members from regular Circles.
- Removing the Owner's membership, removing from a Personal Circle, removing an already-removed
  member, and non-owner attempting removal are each rejected with the correct error type.
- Identity (`displayName`/`image`) stays frozen on the member row after removal; a subsequent
  `setUserDisplayName` run does NOT touch the removed row.
- Edit rights (TXN-2, CAT-2) are lost automatically via `getActiveMembership` returning null.
- The removed member's Transactions render with frozen creator identity.
- A `"member removed"` history event is recorded with the Owner as actor + removed member's
  Display Name in `changes`; no raw IDs.
- The Members page live-updates (removed row vanishes from the default list).
- `memberRemoveForbidden` added to the mutation-error catalog and covered in tests.
- Backend `members.test.ts`, web `members.test.tsx`, and at least one E2E spec green.
- All gates pass: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`.

## Out of scope

Leaving voluntarily (MEM-6); ownership transfer (MEM-7); rejoin mechanics (MEM-3); resend/revoke
invitations (MEM-4). The QA-1 concurrency test (Paid-By-removed-mid-edit race) depends on this
slice being shipped first.
