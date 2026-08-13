# MEM-7 · Transfer ownership

| | |
|---|---|
| **Status** | Done · [PR #188](https://github.com/arpitdalal/PocketCircle/pull/188) |
| **Labels** | `area:membership`, `backend`, `ui` |
| **Depends on** | MEM-1 (SHIPPED) |
| **Unlocks** | MEM-5 (owner-must-transfer-first path before removing self), MEM-6 (owner-must-transfer-first path before leaving) |
| **PRD stories** | 19 |
| **ADRs** | 0015, 0016, 0018 |
| **Glossary** | Owner, Member, Personal Circle |

## Intent

A Circle has **exactly one Owner** at all times (PRD 19, glossary). The only way the Owner
role moves is an explicit transfer — the current Owner picks an active Member and hands over
ownership. After transfer the old Owner becomes a regular Member (and may then leave via
MEM-6, or be removed via MEM-5). This slice also unblocks the "must transfer before you can
leave/be-removed" logic in MEM-5 and MEM-6.

## Current state (verified — read before starting)

Already in place; do NOT recreate:

- **MEM-1 SHIPPED:** `packages/convex/convex/members.ts` exports `listMembers` (query) and
  `toMemberView` (helper). `apps/web-app/app/routes/circle/members.tsx` (`CircleMembers`)
  and `apps/web-app/app/lib/data/members.ts` (`useMembers`, `Member` type) are live.
- **Guard:** `packages/convex/convex/guard.ts` — `requireCircleAccess` → `AuthorizedCircle`
  with `{ user, membership, circle, isOwner, isWritable, assertWritable() }`. `isOwner` is
  derived from `membership.role === "owner"`. `getActiveMembership` queries the
  `by_circle_and_user` unique index and returns null unless `status === "active"`.
- **History:** `packages/convex/convex/history.ts` — `recordEvent(ctx, { entity, actor,
  action, changes })`. Entity must be wrapped via `circleEntity(id)`. Actor is a
  `Doc<"members">` row. Changes are frozen human strings; no raw IDs.
- **Coded errors:** `packages/domain/src/mutation-errors.ts` — `defineMutationErrorCatalog`
  + `MUTATION_ERRORS`, `mutationErrorData`, `mutationErrorDataSchema`,
  `mutationErrorMessageForCode`. Existing codes: `circle.archived`, `category.nameDuplicate`,
  `invite.forbidden`, `invite.setupIncomplete`, `invite.personalCircle`,
  `invite.alreadyMember`, `invite.alreadyPending`. MEM-7 adds `transfer.*` codes here.
- **Web mutation pattern:** `apps/web-app/app/lib/data/invitations.ts`
  (`useCreateInvitation`) — thin `useMutation(api.invitations.createInvitation)` re-exported
  from the `data.ts` barrel. Mirror this for `useTransferOwnership`.
- **UI primitives available:** `Combobox` / `ComboboxTrigger` / `ComboboxPopup` from
  `~/components/ui/combobox.js` (Base UI combobox) for the member picker.
  Confirmation can use an inline two-step in the same form (no separate Dialog/AlertDialog
  primitive exists in `components/ui/` today — do not add a new one for this slice; see
  "Why this way"). `Button`, `Field`, `FieldLabel`, `FieldError` from existing ui modules.

**The single-owner invariant: two fields, one mutation (the crux of this slice).**
`circles.ownerUserId` is a denormalized pointer read by these code paths — verified:

1. `model.ts` `getPersonalCircleForOwner` (line 89): queries
   `.withIndex("by_owner_and_kind", q => q.eq("ownerUserId", ownerId).eq("kind", "personal"))` —
   locates a user's Personal Circle during Personal Circle reconciliation and bootstrap.
2. `model.ts` `createUserWithPersonalCircle` (line 62): writes `ownerUserId: userId` on Circle
   insert — the bootstrap invariant.
3. `circles.ts` `createCircle` mutation (line 125): writes `ownerUserId: user._id` on insert.
4. `schema.ts` indexes `by_owner`, `by_owner_and_kind`, `by_owner_and_status` (lines 69-71):
   any future query over "circles I own" uses these indexes — they key on `ownerUserId`.
5. `test/seed.ts` line 80: `seedPersonalCircleOwner` finds the personal circle via
   `by_owner_and_kind` on `ownerUserId` — test infra depends on this being correct.

`guard.ts` derives `isOwner` from `membership.role === "owner"` (line 111) — NOT from
`ownerUserId`. So these two are independent pointers to the same fact. If they drift, the
member list shows one owner while circle-level queries (Personal Circle lookup, future
"Circles I own" filter) show another — a silent split-brain. `transferOwnership` MUST update
both atomically.

Does NOT exist yet — create in this slice:

- `transferOwnership` mutation in `packages/convex/convex/members.ts`.
- New coded errors in `packages/domain/src/mutation-errors.ts`.
- `useTransferOwnership` hook in `apps/web-app/app/lib/data/members.ts` + barrel export.
- Owner-only transfer UI section on `apps/web-app/app/routes/circle/members.tsx`.
- Mock fixture shape updated in `apps/web-app/app/lib/fixtures.ts` (if MOCK_MEMBERS needs
  adjusting for the new UI path).

## Implement

### 1. Domain — coded errors (`packages/domain/src/mutation-errors.ts`)

Add to the `defineMutationErrorCatalog({...})` call — these are owner-facing validation
failures that must survive Convex production redaction (same reason `invite.*` codes exist):

```ts
transferForbidden: defineMutationError(
  "transfer.forbidden",
  "Only the Circle owner can transfer ownership",
),
transferPersonalCircle: defineMutationError(
  "transfer.personalCircle",
  "Ownership of a Personal Circle can't be transferred",
),
transferToSelf: defineMutationError(
  "transfer.toSelf",
  "You're already the owner of this Circle",
),
transferTargetNotMember: defineMutationError(
  "transfer.targetNotMember",
  "That person isn't an active member of this Circle",
),
```

Anti-enumeration rule (ADR 0016): a `toMemberId` that belongs to a DIFFERENT circle
or doesn't exist at all must NOT be distinguishable from "target not found" — use a generic
plain `Error("Member not found")` in that case (same indistinguishable result as Circle not
found). Only use a coded `ConvexError` when the target IS in THIS circle but the transfer is
invalid for a business reason (e.g. already removed, already owner). See step 2 below for
the exact branching.

Update `packages/domain/src/mutation-errors.test.ts` to cover the new codes (extend the
existing catalog/code behavior test — do not add a parallel file).

### 2. Convex — `transferOwnership` mutation (`packages/convex/convex/members.ts`)

Add alongside `listMembers`. Args: `{ circleId: v.id("circles"), toMemberId: v.id("members") }`.
Exact check order — each check before any write:

1. `const access = await requireCircleAccess(ctx, args.circleId)` — folds auth +
   missing≡inaccessible. Non-member, unauthenticated, and missing Circle all → "Circle not found".
2. `if (!access.isOwner) throw new ConvexError(mutationErrorData(MUTATION_ERRORS.transferForbidden))`.
3. `access.assertWritable()` — archived Circle → `circle.archived` (existing coded error).
4. `if (access.circle.kind === "personal") throw new ConvexError(mutationErrorData(MUTATION_ERRORS.transferPersonalCircle))`.
5. Load target: `const targetMember = await ctx.db.get(args.toMemberId)`.
   - If `!targetMember || targetMember.circleId !== args.circleId`:
     `throw new Error("Member not found")` — anti-enumeration: a foreign/missing id
     is indistinguishable from not found.
   - If `targetMember.status !== "active"`:
     `throw new ConvexError(mutationErrorData(MUTATION_ERRORS.transferTargetNotMember))` —
     target IS in this circle but removed; the caller can see the member list so leaking
     existence is safe; the coded error lets the form show "that person isn't an active member."
   - If `targetMember.role === "owner"` (i.e. `targetMember._id === access.membership._id`):
     `throw new ConvexError(mutationErrorData(MUTATION_ERRORS.transferToSelf))`.
6. **Three atomic patches in one handler** (no intermediate commit, no separate mutations):
   ```ts
   // a) target becomes Owner
   await ctx.db.patch(args.toMemberId, { role: "owner" });
   // b) caller becomes regular Member
   await ctx.db.patch(access.membership._id, { role: "member" });
   // c) denormalized pointer on the Circle row updated
   await ctx.db.patch(args.circleId, { ownerUserId: targetMember.userId });
   ```
7. `await recordEvent(ctx, { entity: circleEntity(access.circle._id), actor: access.membership,
   action: "ownership transferred", changes: [{ field: "owner", from: access.membership.displayName,
   to: targetMember.displayName }] })` — frozen display names, no raw IDs (ADR 0018).

`access.membership.displayName` is the old owner's materialized name at time of event.
`targetMember.displayName` is the new owner's materialized name — both already materialized
on the member row (MEM-1 schema).

### 3. Web — data hook (`apps/web-app/app/lib/data/members.ts`)

Add alongside `useMembers`:

```ts
export function useTransferOwnership() {
  return useMutation(api.members.transferOwnership);
}
```

Re-export from `apps/web-app/app/lib/data.ts` barrel via the existing
`export * from "./data/members.js"` (no change needed to the barrel itself — wildcard picks
it up).

### 4. Web — Owner-only transfer UI (`apps/web-app/app/routes/circle/members.tsx`)

Add a `TransferOwnershipForm` component, rendered below the invite form when
`isOwner && circle.kind === "regular"`. It must:

- Filter `members` to `role === "member" && status === "active"` for the picker — the
  set of transfer targets. If none exist (circle is solo-owner), render nothing.
- Use `Combobox` from `~/components/ui/combobox.js` to pick a target member. The
  selected option's `id` (`Member["id"]`) is `toMemberId` passed to the mutation.
- Two-step confirm: after picking a member, show a confirmation section (inline in the
  same form — no separate Dialog) naming the target: "Transfer ownership to [Name]?" with
  a destructive-styled Confirm button and a Cancel button that clears selection.
- On confirm: call `transferOwnership({ circleId, toMemberId: selectedMember.id })` —
  `toMemberId` is `Member["id"]` which is `Id<"members">`.
- Disable the Confirm button while in-flight; guard double-submit.
- On success: clear the selection and show a transient `role="status"` success message
  ("Ownership transferred to [Name]."). The component then re-renders without the form
  (the caller is no longer `isOwner`).
- On error: map via `mutationErrorMessageForUser(error, fallback)` in a `role="alert"` para.
- Accessibility: picker has an associated `<label>`; confirm button has enough context
  (e.g. `aria-label` or visible label naming the target) that a screen reader user knows
  what they are confirming.

## Why this way

**Three writes, one handler, no observable intermediate state.** Convex mutations are
serialized — no concurrent read can observe a partial state between the three `ctx.db.patch`
calls within a single handler. This is the ONLY way to keep the single-owner invariant: any
split into separate mutations would create a window where 0 or 2 member rows have
`role === "owner"`, or where `circles.ownerUserId` disagrees with the `role` column.

**Both fields must update because they serve different readers.** `membership.role === "owner"`
is how `guard.ts` derives `isOwner` (line 111) — the auth gate for every owner-only mutation.
`circles.ownerUserId` is how `getPersonalCircleForOwner` (model.ts line 89) finds a User's
Personal Circle, and how the `by_owner_and_kind` / `by_owner_and_status` schema indexes
(schema.ts lines 70-71) support future "circles I own" queries. Updating only the member row
would break Personal Circle lookups for the new owner (or corrupt the index); updating only
`ownerUserId` would break every permission check. They must stay in lockstep.

**Personal Circle is structurally blocked** — `kind === "personal"` check happens before
any mutation write, same pattern as `invite.personalCircle` (MEM-2). The Personal Circle is
always solo; its owner is fixed at bootstrap and must never change.

**Anti-enumeration on foreign `toMemberId`** — a member ID from a different circle must not
confirm whether THAT member or THAT circle exists. Generic `throw new Error("Member not found")`
(plain, not `ConvexError`) matches the "Circle not found" precedent in `requireCircleAccess`.
A removed member ID from THIS circle uses a coded error because the caller can see the full
member list and leaking existence is already permitted; the coded path gives them useful copy.

**No new Dialog primitive** — the app has no AlertDialog/Modal component today. Adding a new
primitive for this one use case violates "no bespoke hand-written alternatives" (CLAUDE.md).
An inline two-step confirm (pick → show confirm section → submit or cancel) achieves the same
safety with zero new components and is keyboard-operable via the existing Button/form flow.

## How to test

### Backend (`packages/convex/convex/members.test.ts`) — extend the existing file

Use `seedCircle` + `addMember` from `packages/convex/convex/test/seed.ts`.
Same `vi.mock("./auth.js")` + `import.meta.glob` header as the existing file.

**Happy path:**
- Owner transfers to an active `role:"member"` of the same circle →
  `targetMember.role === "owner"`, old owner's member row `role === "member"`,
  `circles.ownerUserId === targetMember.userId`; assert all three in one query pass.
- History: `histories` table has one event on `circleEntity(circleId)` with
  `action === "ownership transferred"`, `actor.displayName === <old owner name>`,
  `changes: [{ field: "owner", from: <old owner name>, to: <new owner name> }]` — no raw IDs.

**Invariant:**
- After any transfer, assert exactly ONE member row with `role === "owner"` on the circle
  (query all members, filter by role).
- `circles.ownerUserId` matches that single `role === "owner"` member's `userId`.
- These two asserts must hold in the same test that checks the happy path.

**Permission matrix:**
- Non-owner Member calls `transferOwnership` → `transfer.forbidden`.
- Removed Member calls `transferOwnership` → "Circle not found" (no access — plain error).
- Unauthenticated → "Circle not found".
- Non-member User → "Circle not found".

**Target validation:**
- `toMemberId` belongs to a DIFFERENT circle → "Member not found" (plain error, not coded).
- `toMemberId` doesn't exist → "Member not found" (plain error).
- `toMemberId` is a Removed Member of THIS circle → `transfer.targetNotMember` (coded).
- `toMemberId` is the caller (owner's own member id) → `transfer.toSelf` (coded).

**Lifecycle / state edges:**
- Archived Circle → `circle.archived` (assertWritable throws).
- Personal Circle → `transfer.personalCircle`.

**Cross-slice follow-on (assert behavior, not mock future mutations):**
- After transfer: re-query `listMembers` — new owner appears first (role:"owner" sort),
  old owner appears as a regular member row.
- After transfer: call a mutation that requires `isOwner` (e.g. rename) with the NEW owner
  as caller → succeeds. Same call with the OLD owner → fails (non-owner).

### Web (`apps/web-app/app/routes/circle/members.test.tsx`) — extend existing file

Reuse `setup`, `configureConvex`, `makeMemberView`, `renderInCircle` from
`~/test/convex-react.js` (the existing shared test helper).

- Owner on a regular circle with at least one member → transfer form renders.
- Owner on a regular circle with NO other members (solo) → transfer form not rendered.
- Non-owner on a regular circle → transfer form not rendered.
- Owner on a Personal Circle → transfer form not rendered.
- Picking a target → confirm section appears naming the target; Confirm button present.
- Cancel clears selection and hides confirm section (no mutation called).
- Confirm calls `transferOwnership({ circleId, toMemberId })` with correct args; button
  disabled while in-flight.
- On success: success `role="status"` message with the target name; form cleared.
- On coded error (`transfer.targetNotMember`): `role="alert"` para with mapped copy;
  no double-submit.

### E2E (`e2e/members.spec.ts`) — extend existing file

- Full transfer flow: sign in as Owner, open Members page, pick an active member, confirm,
  assert owner badge moves to the new owner and the old owner shows no badge.
- After transfer: sign in as the new owner, assert owner-only actions (e.g. invite form)
  are visible; sign in as old owner, assert invite form is absent.

## Done when

- Owner can atomically transfer ownership to an active member of the same regular Circle;
  BOTH `members.role` (target: `"owner"`, caller: `"member"`) AND `circles.ownerUserId`
  (target's userId) are updated in the same handler with no observable intermediate state.
- Personal Circle, archived Circle, non-owner caller, removed target, foreign/missing
  `toMemberId`, and self-transfer are all rejected with the correct error (coded for
  owner-facing business violations; plain for anti-enumeration cases).
- History event recorded: `action: "ownership transferred"`, `from`/`to` by display name,
  no raw IDs.
- `useTransferOwnership` exported from `data/members.ts` and re-exported via `data.ts` barrel.
- Owner-only transfer UI on Members page: member picker + inline confirm; accessible;
  success/error feedback; no double-submit.
- `transfer.*` coded errors in `mutation-errors.ts`; `mutation-errors.test.ts` extended.
- Tests green (backend `members.test.ts`, web `members.test.tsx`, e2e `members.spec.ts`).
- All gates pass: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`.

## Out of scope

Leaving a Circle (MEM-6); removing a Member (MEM-5). The "must transfer before you can
leave/remove-self" enforcement is MEM-5/MEM-6's responsibility — MEM-7 only provides the
transfer mechanism those slices can direct the owner to use.
