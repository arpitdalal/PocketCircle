# MEM-6 · Leave Circle

| | |
|---|---|
| **Status** | Todo |
| **Labels** | `area:membership`, `backend`, `ui` |
| **Depends on** | MEM-1 (shipped) |
| **Cross-ref** | MEM-5 (removeMember twin), MEM-7 (transfer prerequisite for owners), MEM-3 (rejoin reactivates same row) |
| **PRD stories** | 18 |
| **ADRs** | 0015, 0016, 0017, 0018 |
| **Glossary** | Member, Removed Member, Personal Circle, Owner |

## Intent

A Member can remove themselves from a regular Circle (PRD 18). Leaving is the self-service
twin of MEM-5 `removeMember`: same frozen-identity, same status-flip-not-delete, same rejoin
reconnection (MEM-3 reactivates the same row with the same id). Two structural guards: a
**Personal Circle cannot be left** (always solo, glossary), and **the Owner cannot leave**
without transferring ownership first (MEM-7) — otherwise the Circle is orphaned.

## Current state (verified — read before starting)

Already in place; do NOT recreate:

- **MEM-1 shipped:** `packages/convex/convex/members.ts` exports `listMembers` query +
  `toMemberView`. `apps/web-app/app/routes/circle/members.tsx` renders the Member List with
  the Owner-only invite form (MEM-2). `apps/web-app/app/lib/data/members.ts` exports
  `useMembers`. The data barrel is `apps/web-app/app/lib/data.ts` (re-exports everything
  under `./data/*.js`).
- **Guard:** `packages/convex/convex/guard.ts` exports `requireCircleAccess` →
  `AuthorizedCircle { user, membership, circle, isOwner, isWritable, assertWritable() }`.
  `resolveCircleAccess` returns `null` for a removed/non-member — so leaving immediately
  flips the caller's live query to `null` reactively (ADR 0017), not just on reload.
- **History:** `packages/convex/convex/history.ts` `recordEvent(ctx, { entity: circleEntity(circle._id), actor: access.membership, action, changes })`. No raw IDs in `changes`.
- **Schema members table** (`packages/convex/convex/schema.ts`): `status "active"|"removed"`;
  `removedAt?: number`; `displayName`/`image` materialized (frozen when removed); index
  `by_circle_and_user` (.unique() — one row per (circle, user) forever). No schema change needed.
- **Frozen identity mechanism:** `setUserDisplayName` in `packages/convex/convex/model.ts`
  mirrors display name onto active member rows and **skips removed rows** — leaving keeps the
  name frozen automatically. (Note: the real function is `setUserDisplayName`, NOT
  `propagateUserProfile` — that name does not exist.)
- **`listMyCircles`:** `packages/convex/convex/circles.ts` — the `listMyCircles` query (line 55)
  filters memberships to `status === "active"` before collecting circles. After leaving, the
  circle drops out reactively because the status flip immediately removes it from the active
  membership scan.
- **Mutation-error catalog:** `packages/domain/src/mutation-errors.ts` — `defineMutationErrorCatalog({...})`. Currently has `circleArchived`, `categoryNameDuplicate`, `inviteForbidden`, `inviteSetupIncomplete`, `invitePersonalCircle`, `inviteAlreadyMember`, `inviteAlreadyPending`. New coded errors for leave guards go here.
- **Web mutation hook pattern:** `apps/web-app/app/lib/data/invitations.ts` `useCreateInvitation()` — mirror this for `useLeaveCircle`.
- **`mutationErrorMessageForUser`:** `apps/web-app/app/lib/mutation-user-message.ts` maps coded errors to user copy.
- **Test doubles for web:** `apps/web-app/app/test/convex/invitations.ts` — mirror this for the `leaveCircle` mutation double wired into `apps/web-app/app/test/convex/core.ts`.
- **No confirmation dialog primitive exists** in `apps/web-app/app/components/ui/` yet. Build a simple inline confirm step (e.g. "Leave Circle?" / "Cancel" / "Leave" buttons) or a `<dialog>`/button pair — do not add a radix `AlertDialog` dependency just for this. Keep it accessible: the confirmation state should be clearly indicated and keyboard-operable.
- **Safe fallback route after leaving:** `href("/")` — the Home route (`routes/home.tsx`). After leaving, the Circle drops from `listMyCircles` and the member can no longer access it; navigating to `"/"` shows "Your circles" without the left one.

Does NOT exist yet — you create in this slice:

- `leaveCircle` mutation in `packages/convex/convex/members.ts`.
- Coded errors `member.ownerMustTransfer` and `leave.personalCircle` in `packages/domain/src/mutation-errors.ts`.
- `useLeaveCircle` hook in `apps/web-app/app/lib/data/members.ts` + barrel re-export in `apps/web-app/app/lib/data.ts`.
- A `leaveCircle` mutation double in `apps/web-app/app/test/convex/members.ts` + wired in `apps/web-app/app/test/convex/core.ts` (`MembersState` + `membersDouble`).
- Leave Circle UI on `apps/web-app/app/routes/circle/members.tsx`.

## Implement

### 1. Domain — coded errors (`packages/domain/src/mutation-errors.ts`)

Add two entries to the `defineMutationErrorCatalog({...})` call. These surface to a legitimate
authenticated member and must cross Convex production redaction — use coded `ConvexError`s, not
plain `Error`s:

```ts
leavePersonalCircle: defineMutationError(
  "leave.personalCircle",
  "You can't leave your Personal Circle",
),
ownerMustTransfer: defineMutationError(
  "member.ownerMustTransfer",
  "Transfer ownership before leaving",
),
```

Extend `packages/domain/src/mutation-errors.test.ts` to cover both new codes (the existing test
asserts catalog/codes behavior — add assertions for these codes).

### 2. Convex — `leaveCircle` mutation (`packages/convex/convex/members.ts`)

Add to the existing `members.ts` file (alongside `listMembers`). Follow the canonical
mutating-handler shape from `guard.ts`:

```
args: { circleId: v.id("circles") }
```

Handler order — each check before any write:

1. `const access = await requireCircleAccess(ctx, args.circleId)` — folds in auth + missing≡inaccessible (ADR 0016). Import `mutation` from `./_generated/server.js`.
2. `if (access.circle.kind === "personal") throw new ConvexError(mutationErrorData(MUTATION_ERRORS.leavePersonalCircle))` — Personal Circle is always solo.
3. `if (access.isOwner) throw new ConvexError(mutationErrorData(MUTATION_ERRORS.ownerMustTransfer))` — owner must transfer first (MEM-7).
4. `access.assertWritable()` — an archived Circle is read-only (`circle.archived`). (An archived Circle's members may still want to leave; leaving is NOT gated on writability for membership exits — reconsider: check the PRD intent. If PRD 18 does not mention archived-circle leave, default safe: skip `assertWritable()` for leave since frozen history identity is already ensured. Document the choice inline.)
5. `const now = Date.now()`.
6. `await ctx.db.patch(access.membership._id, { status: "removed", removedAt: now })` — status flip, never delete. Do NOT touch `displayName`/`image`; they freeze here automatically (`setUserDisplayName` already skips removed rows).
7. `await recordEvent(ctx, { entity: circleEntity(access.circle._id), actor: access.membership, action: "member left", changes: [{ field: "member", from: access.membership.displayName }] })` — `from` holds the display name, no raw IDs.

After this mutation resolves:
- `resolveCircleAccess` returns `null` for the caller (their membership is no longer `active`).
- `listMyCircles` no longer includes this Circle (it filters to `status === "active"`).
- Both effects are reactive — Convex re-runs subscribed queries immediately.

Imports needed (add as needed): `ConvexError`, `v` from `"convex/values"`; `mutation` from `"./_generated/server.js"`; `requireCircleAccess` from `"./guard.js"`; `circleEntity`, `recordEvent` from `"./history.js"`; `MUTATION_ERRORS`, `mutationErrorData` from `"@pocketcircle/domain"`.

### 3. Web — `useLeaveCircle` hook (`apps/web-app/app/lib/data/members.ts`)

Add alongside `useMembers`:

```ts
export function useLeaveCircle() {
  return useMutation(api.members.leaveCircle);
}
```

No `MOCKS` fork needed — this is mutation-only; the mock is handled by the test double.
Re-export from the barrel `apps/web-app/app/lib/data.ts` — already `export * from "./data/members.js"` so nothing to add there.

### 4. Web — test double wiring

In `apps/web-app/app/test/convex/members.ts`:
- Add `leaveCircle?: Mock` to `MembersState`.
- In `membersDouble`, add `[getFunctionName(api.members.leaveCircle)]: leaveCircle` to the `mutations` map.

In `apps/web-app/app/test/convex/core.ts`:
- `MembersState` is already included; the new field flows through automatically since `membersDouble` is already in `ENTITY_DOUBLES`. No change needed to `core.ts` if `MembersState` is a spread type — verify this holds.

### 5. Web — Leave Circle UI (`apps/web-app/app/routes/circle/members.tsx`)

The members page already has `circle` (from `useCircle()`), `members` (from `useMembers()`), and `isOwner` derived. Add a "Leave Circle" section:

**Visibility rules (client-side courtesy; server enforces):**
- Hidden entirely when `circle.kind === "personal"`.
- When the caller is the owner (`isOwner === true`): render a "Transfer ownership first" notice pointing at the MEM-7 surface. MEM-7 does not exist yet — render the message as static text for now, no link.
- When the caller is a non-owner member (`isSelf && !isOwner`): render the Leave button with a confirmation step.

**Leave button flow:**
- Render a "Leave Circle" button (variant: `"destructive"` or `"outline"` with destructive styling — match what's in the codebase).
- On click: show an inline confirmation (e.g. a `"Are you sure?"` message with "Cancel" and "Confirm Leave" buttons). This avoids a dependency on an alert dialog primitive that doesn't exist yet. Keep the confirmation keyboard-accessible.
- On confirm: call `leaveCircle({ circleId: circle.id })`. Disable buttons while in-flight.
- On success: `navigate(href("/"))` — the Home route shows "Your circles" without this one.
- On error: render `role="alert"` with `mutationErrorMessageForUser(caught, "Couldn't leave. Please try again.")`.

Use `useNavigate` from `react-router` (already used in `circle-new.tsx`). Import `href` for the navigation target.

**Implementation location:** add a `LeaveCircle` component at the bottom of `members.tsx`, rendered below `<MemberList>` when applicable.

## Why this way

- **Owner-can't-leave** mirrors the single-Owner invariant (PRD 19 rationale); force MEM-7 first. This is a coded `ConvexError` (owner is a legitimate actor, not an anti-enumeration case).
- **Personal Circle guard** enforces the always-solo invariant structurally; coded error.
- **Reactive revocation:** `resolveCircleAccess` is a live Convex query. The status flip from `leaveCircle` immediately invalidates the caller's subscription — they lose access **without a page reload**. Assert this in tests (re-resolve after leaving, not re-auth).
- **Status flip, never delete** preserves the one-row-per-(Circle,User) invariant and lets MEM-3 rejoin reactivate the same row by its id (ADR 0018).
- **Frozen identity:** do not patch `displayName`/`image` on leave. `setUserDisplayName` already skips removed rows, so the name stays frozen as of the moment they left.
- **`listMyCircles` reactivity:** the query filters to `active` memberships — the flip to `removed` makes the circle disappear from the list reactively, same subscription cycle.

## How to test

Backend: `packages/convex/convex/members.test.ts` — same file as `listMembers` tests. Use the existing `seedCircle` + `addMember` helpers from `packages/convex/convex/test/seed.ts`. Mock `./auth.js` seam with `vi.hoisted` + `vi.mock` exactly as in the existing file.

Web: `apps/web-app/app/routes/circle/members.test.tsx` — extend the existing file. Use `configureConvex({ members: ..., leaveCircle: ... })` and `renderInCircle`.

### Backend (members.test.ts)

**Happy path:**
- Non-owner active member calls `leaveCircle({ circleId })` → own member row now has `status: "removed"` and `removedAt` is set (assert `removedAt` is a recent timestamp). `displayName`/`image` are unchanged (frozen).
- A `"member left"` history event is recorded on the Circle entity with `changes: [{ field: "member", from: <display name> }]`, actor is the leaving member's row, no raw IDs in `changes`.
- After leaving, `listMyCircles` no longer returns this Circle for the leaver (re-run the query with the leaver as the current user after the mutation).
- After leaving, `resolveCircleAccess(ctx, circleId)` with the leaver's user returns `null` — the reactive access flip, not a reload-only effect. Assert this by re-calling `resolveCircleAccess` in the same `t.run` block after patching.

**Guards:**
- Owner calls `leaveCircle` → throws `ConvexError` with code `"member.ownerMustTransfer"`.
- Caller's circle is `kind: "personal"` → throws `ConvexError` with code `"leave.personalCircle"`.
- Non-member user calls `leaveCircle` → throws generic `"Circle not found"` (anti-enumeration, ADR 0016) — NOT a coded error.
- Unauthenticated caller → throws `"Circle not found"` (same plain throw via `requireCircleAccess`).
- Removed member calls `leaveCircle` → `requireCircleAccess` resolves to `null` → throws `"Circle not found"` (they already have no active membership).

**Frozen identity:**
- After leaving, call a hypothetical `setUserDisplayName(ctx, userId, "New Name")` — assert the removed member row's `displayName` is still the old frozen name, not `"New Name"`.

**Rejoin cross-check (cross-ref MEM-3):**
- After leaving, the member row id is the same row. Reactivate it (simulate what MEM-3 will do: patch `status: "active"`, clear `removedAt`). Assert the same `_id` — no duplicate row.

**History (ADR 0018):**
- Assert event `action === "member left"`, `changes[0].field === "member"`, `changes[0].from === <display name>`, no `to`, `actorMemberId === leaving member's _id`. No raw user IDs or circle IDs in `changes`.

### Web (members.test.tsx)

**Leave button visibility:**
- Personal Circle (`circle.kind === "personal"`): Leave section not rendered.
- Owner is calling (`isSelf === true, role === "owner"`): No Leave button; "transfer ownership first" message rendered instead.
- Non-owner member (`isSelf === true, role === "member"`): "Leave Circle" button rendered.
- Non-self member rows: Leave button not rendered per other members' rows.

**Confirmation flow:**
- Non-owner self clicks "Leave Circle": confirmation step appears; "Cancel" dismisses it without calling the mutation.
- Clicking "Confirm Leave" (or equivalent): calls `leaveCircle({ circleId: circle.id })`.
- Buttons are disabled while in-flight.

**Success:**
- `leaveCircle` resolves → navigation to `"/"` occurs (assert `useNavigate` was called with `href("/")`). Either mock `useNavigate` or use `renderWithRouter` + check the route change.

**Error:**
- `leaveCircle` rejects with `ConvexError(mutationErrorData(MUTATION_ERRORS.ownerMustTransfer))` → `role="alert"` renders with `MUTATION_ERRORS.ownerMustTransfer.message`.
- Unexpected error (non-coded) → fallback copy rendered in `role="alert"`.

### E2E (`e2e/members.spec.ts` or new `e2e/leave-circle.spec.ts`)

- Sign in as a non-owner member of a regular Circle.
- Navigate to Members.
- Click "Leave Circle", confirm.
- Assert: redirected to `/` (home). The left Circle no longer appears in the circle switcher / home list.
- Sign in as the owner of a Circle → Members page shows "transfer ownership first" (MEM-7 message), no Leave button.
- Personal Circle owner → Members page shows no Leave section.

## Done when

- A non-owner Member can leave a regular Circle (not Personal; Owner must transfer first):
  - `leaveCircle` mutation is in `members.ts` with both guards throwing coded `ConvexError`s.
  - Status flip to `"removed"` + `removedAt` set; `displayName`/`image` frozen.
  - `"member left"` event recorded on the Circle with display-name `from`, no raw IDs.
  - `listMyCircles` no longer returns the Circle after leaving.
  - `resolveCircleAccess` returns `null` reactively (live revocation, ADR 0017).
  - Web: Leave button hidden on Personal; owner sees transfer-first message; non-owner sees button + confirmation; on success navigates to `href("/")`.
  - `useLeaveCircle` hook in `data/members.ts`; mutation double in `test/convex/members.ts`.
  - All tests green; `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e` pass.

## Out of scope

Owner removal of others (MEM-5); transfer ownership (MEM-7); rejoin mechanics (MEM-3); archiving or deleting the Circle (MEM-8, MEM-9).
