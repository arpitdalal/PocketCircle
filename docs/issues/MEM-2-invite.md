# MEM-2 · Invite by email

| | |
|---|---|
| **Status** | Done · [PR #177](https://github.com/arpitdalal/PocketCircle/pull/177) |
| **Labels** | `area:membership`, `backend`, `ui`, `security` |
| **Depends on** | MEM-1 |
| **Unlocks** | MEM-3, MEM-4, MEM-8, MEM-9, EML-2 |
| **PRD stories** | 12, 16 |
| **ADRs** | 0015, 0016, 0018 |
| **Glossary** | Invitation, Invitation Link, Owner |

## Intent

An Owner invites a person by **email** to join a *regular* Circle (never a Personal Circle —
it's always solo). The invite produces a single-use **Invitation Link** that **expires after
7 days** (PRD 16). The token is opaque and **stored only as a hash** (`invitations.tokenHash`)
— the plaintext lives solely in the emailed link (ADR 0016 anti-enumeration), so a leaked DB
never yields working links. This slice creates the Invitation + token; sending the email is
EML-2, accepting is MEM-3.

## Current state (verified — read before starting)

Already in place; do NOT recreate:

- **Schema:** the `invitations` table exists in `packages/convex/convex/schema.ts` with exactly
  the fields this slice needs — `circleId`, `emailLower`, `tokenHash`, `status`
  (`pending|accepted|revoked|expired`), `invitedByUserId`, `resendCount`, `createdAt`,
  `expiresAt` — and indexes `by_circle`, `by_circle_and_email`, `by_token_hash`. No schema change
  is required for MEM-2.
- **Member List:** `packages/convex/convex/members.ts` (`listMembers`, `toMemberView`) and the web
  surface `apps/web-app/app/routes/circle/members.tsx` + hook `apps/web-app/app/lib/data/members.ts`
  (`useMembers`) are shipped (MEM-1). This slice adds the invite form to that existing page.
- **Invite landing scaffold:** `apps/web-app/app/routes/invite.tsx` (route `/invite/:token`, in the
  public layout) is a scaffold — MEM-3 builds the accept flow. MEM-2 only needs to produce a link
  pointing at it; do not implement acceptance here.
- **Guard + history + coded-error plumbing** all exist — see the patterns to copy below.

Does NOT exist yet — you create it in this slice:

- Any token generation / hashing utility.
- An email-input Zod schema in `packages/domain`.
- `packages/convex/convex/invitations.ts` (the mutation module).
- The new coded `MUTATION_ERRORS` entries this slice throws (catalog currently has only
  `circle.archived` and `category.nameDuplicate`).

## Implement

### 1. Domain — email input schema (`packages/domain/src/validation.ts`)

Add a server-and-client-shared parse, mirroring the existing `parseProfileUpdate` shape so both
the form and the mutation use one rule (ADR 0010). Export it from the barrel automatically via the
existing `export * from "./validation.js"`.

```ts
export const inviteEmailSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
});
export type InviteEmailInput = z.infer<typeof inviteEmailSchema>;
```

`.toLowerCase()` makes the parsed value the canonical `emailLower`. Keep the ORIGINAL (untrimmed-case)
email only if you need a display copy in the history event — store/compare on the lowercased value
everywhere else. (There is no email helper in the domain today; this is the first.)

### 2. Domain — coded errors (`packages/domain/src/mutation-errors.ts`)

Add entries to the `defineMutationErrorCatalog({...})` call (the catalog is the single source of
truth; the union type is derived from it). These surface to the inviting Owner — a legitimate,
authenticated member — so coded `ConvexError`s are correct (they survive Convex production
redaction; plain `Error`s become "Server Error"). Suggested entries:

```ts
inviteForbidden: defineMutationError("invite.forbidden", "Only the Circle owner can invite members"),
inviteSetupIncomplete: defineMutationError("invite.setupIncomplete", "Finish setting up this Circle before inviting members"),
invitePersonalCircle: defineMutationError("invite.personalCircle", "Personal Circles can't have other members"),
inviteAlreadyMember: defineMutationError("invite.alreadyMember", "That person is already a member of this Circle"),
inviteAlreadyPending: defineMutationError("invite.alreadyPending", "There's already a pending invitation for that email"),
```

The archived-Circle case is already covered by `assertWritable()` → `circle.archived`; reuse it,
do not add a new code for it. Update `packages/domain/src/mutation-errors.test.ts` to cover the new
codes (the existing test asserts catalog/codes behavior — extend it).

### 3. Convex — token util (`packages/convex/convex/invitationToken.ts`, new)

The token is a bearer credential. Generate an opaque random token, store ONLY its hash. Both create
(MEM-2) and accept (MEM-3) must hash identically, so this is a shared module. The Convex default
runtime implements the Web Crypto API (`crypto.getRandomValues`, `crypto.subtle.digest`) — no Node,
no npm crypto dep. convex-test's edge runtime provides the same, so it's testable.

```ts
/** Opaque, URL-safe invitation token (the bearer credential; only its hash is stored). */
export function generateInvitationToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // base64url, no padding — safe in a URL path segment.
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** SHA-256 hex of the token — the value persisted in `invitations.tokenHash`. */
export async function hashInvitationToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
```

Add a unit test (`invitationToken.test.ts`) asserting: tokens are unique across calls, the hash is
deterministic for a given token, and the hash ≠ the token.

### 4. Convex — `createInvitation` mutation (`packages/convex/convex/invitations.ts`, new)

`args: { circleId: v.id("circles"), email: v.string() }`. Follow the canonical mutating-handler
shape from `guard.ts` and the `createCategoryForMember` precedent (coded-error throw via
`new ConvexError(mutationErrorData(MUTATION_ERRORS.x))`). Exact order — each check before any write:

1. `const access = await requireCircleAccess(ctx, args.circleId)` — folds in auth + missing≡inaccessible.
2. `if (!access.isOwner) throw new ConvexError(mutationErrorData(MUTATION_ERRORS.inviteForbidden))`.
3. `access.assertWritable()` — archived Circle ⇒ `circle.archived`.
4. `if (access.circle.kind === "personal") throw … invitePersonalCircle`.
5. `if (access.circle.setupCompletedAt === null) throw … inviteSetupIncomplete`.
6. `const { email } = inviteEmailSchema.parse({ email: args.email })` — `email` is now the
   normalized `emailLower`.
7. **Already an active member?** Resolve the email → User via the `users` `by_email` index, then
   check `members` `by_circle_and_user` for an `active` row → throw `inviteAlreadyMember`. (A
   Removed Member's email is re-invitable — that's the "removed ⇒ allowed" case below.)
8. **Already pending?** Query `invitations` `by_circle_and_email` (`circleId` + `emailLower`); if any
   row has `status === "pending"` AND `expiresAt > Date.now()` → throw `inviteAlreadyPending`
   (resend is MEM-4, never a second row). An expired/revoked/accepted prior row does NOT block a
   fresh invite.
9. `const token = generateInvitationToken(); const tokenHash = await hashInvitationToken(token);`
10. Insert: `{ circleId, emailLower: email, tokenHash, status: "pending", invitedByUserId:
    access.user._id, resendCount: 0, createdAt: now, expiresAt: now + 7 * 24 * 60 * 60 * 1000 }`.
11. `await recordEvent(ctx, { entity: circleEntity(access.circle._id), actor: access.membership,
    action: "member invited", changes: [{ field: "email", to: email }] })` — the entity is the
    Circle (membership/invite events live on Circle history, per ADR 0018); the only display value
    is the email string — **no raw IDs** in `changes`.
12. `return { token }` — the plaintext, returned to the inviting Owner only.

**On the token-return decision (resolves the original slice's ambiguity):** until EML-2 automates
sending, the inviting Owner needs the link to deliver it manually, so `createInvitation` returns the
plaintext `token` to that Owner. This is acceptable — the Owner is the trusted initiator of the
invite. When EML-2 lands, the send moves server-side (a scheduled action consuming the token) and the
mutation should stop returning the plaintext to the client. Note this explicitly in the PR so EML-2
knows to flip it. The token is NEVER persisted in plaintext regardless (assert `tokenHash !== token`).

### 5. Web — mutation hook (`apps/web-app/app/lib/data/invitations.ts`, new)

Mirror `useCreateCategory` (`apps/web-app/app/lib/data/categories.ts`): a thin
`export function useCreateInvitation() { return useMutation(api.invitations.createInvitation); }`
so the route imports the hook, not `api` directly. Re-export it from the `data.ts` barrel
(`apps/web-app/app/lib/data.ts`) alongside the existing `export * from "./data/members.js"`.
No query/`MOCKS` fork is needed (this slice adds no new read; the form is mutation-only). If you
surface a link in mock mode, gate on `MOCKS` and synthesize a fake token client-side.

### 6. Web — invite form on the Members page (`apps/web-app/app/routes/circle/members.tsx`)

Add an Owner-only invite form ABOVE or beside the existing `MemberList`. The page already loads
`useMembers(circle.id)`; derive the caller's owner status from it — the member with
`isSelf === true && role === "owner"` — and render the form only then (UI courtesy; the server is the
real gate, ADR 0015). Requirements:

- Email `<input type="email">` with an associated `<label>`; reuse the shared form primitives in
  `apps/web-app/app/lib/form.tsx` (same as the other forms) for field + error wiring.
- Validate with `inviteEmailSchema` on submit; show field errors via `role="alert"`.
- Disable the submit button while in-flight; guard double-submit.
- On success, surface the Invitation Link (`/invite/${token}` against the app origin) in a
  copyable, accessible element with a success message — this is the interim manual-delivery surface
  until EML-2. On a coded error, map it to copy via the existing
  `mutationErrorMessageForUser(error, fallback)` (`apps/web-app/app/lib/mutation-user-message.ts`).
- Handle loading/empty/error of the surrounding members read exactly as the page already does.

## Why this way

- **Hash the token, never store plaintext** — the link is a bearer credential; the DB must not be
  able to mint one. Acceptance (MEM-3) hashes the incoming token and looks up by `by_token_hash`.
- **One shared token module** so MEM-3 hashes with the identical algorithm — a drift here silently
  breaks every accept.
- **Personal Circles reject invites** at the server, structurally (`kind` check) — the always-solo
  invariant is enforced, not just hidden.
- **Incomplete Circles reject invites** at the server — setup gates `/members` in the UI, but the
  mutation must also enforce that no non-owner can join an incomplete Circle.
- **Create ≠ resend:** a pending, unexpired invite for the same email must not spawn a second row;
  resend (MEM-4) mutates the existing one and rotates the token.
- **Coded `ConvexError`s, not plain throws,** for the owner-facing validation failures — they cross
  the production redaction boundary as stable codes the form maps to copy (the `category.nameDuplicate`
  precedent, GH #147). The anti-enumeration "Circle not found" path stays a plain `Error` (it must
  not confirm existence).

## How to test

Backend tests live in `packages/convex/convex/invitations.test.ts` (convex-test; mock the `./auth.js`
seam with `vi.mock` exactly as `members.test.ts` / `guard.test.ts` do — Better Auth can't run under
convex-test). Reuse `packages/convex/convex/test/seed.ts` helpers for User/Circle/Member setup.

- **Happy:** Owner invites a new email → exactly one `pending` Invitation with a hashed token
  (`tokenHash !== returnedToken`), `expiresAt === createdAt + 7d` (assert the 7-day delta precisely),
  `resendCount === 0`, `invitedByUserId` = Owner. A `"member invited"` event is recorded on the
  **Circle** entity with `changes: [{ field: "email", to: <emailLower> }]` and no raw IDs.
- **Permissions:** non-owner Member → `invite.forbidden`; Removed Member → `Circle not found`
  (resolves to no access); non-member User → `Circle not found`; unauthenticated → `Circle not found`.
- **Personal Circle:** Owner invites on their Personal Circle → `invite.personalCircle`.
- **Incomplete regular Circle:** invite before `setupCompletedAt` is set → `invite.setupIncomplete`;
  succeeds once setup is complete.
- **Duplicates:** inviting an existing **active** Member's email → `invite.alreadyMember`; inviting an
  email that already has a **pending, unexpired** invite → `invite.alreadyPending` (and assert no
  second row was written); inviting the email of a **Removed** Member → succeeds (re-invite allowed);
  inviting an email whose only prior invite is expired/revoked/accepted → succeeds (new row).
- **Lifecycle:** invite on an archived Circle → `circle.archived`.
- **Email normalization:** `"  Ada@Example.COM "` and `"ada@example.com"` collide on `emailLower`
  (the second is rejected as already-pending); the stored `emailLower` is the normalized form.
- **Token util:** unique per call, hash deterministic, hash ≠ token (in `invitationToken.test.ts`).

Web tests in `apps/web-app/app/routes/circle/members.test.tsx` (extend the existing file; shared
render wiring is `apps/web-app/app/test/convex-react.tsx`):

- Owner sees the invite form; a non-owner Member does not (courtesy-hide).
- Invalid email shows a `role="alert"` error and does not call the mutation.
- Successful invite renders the copyable `/invite/<token>` link + success message; the submit button
  is disabled while in-flight.
- A coded mutation error (e.g. `invite.alreadyPending`) renders the mapped user copy via
  `mutationErrorMessageForUser`.

## Done when

- An Owner can create a hashed, 7-day, single-use Invitation for a regular Circle; non-owners,
  Personal Circles, incomplete Circles, archived Circles, and active-member / pending-email duplicates
  are each rejected with the right coded error; a Removed Member's email is re-invitable; the
  `"member invited"` event is recorded on Circle history; the token is never persisted in plaintext;
  the Owner can copy the Invitation Link from the Members page; tests green; all gates pass
  (`pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`).

## Out of scope

Sending the email (EML-2); accept / rejoin (MEM-3); resend / revoke / list invitations (MEM-4).
Wiring the returned token into an automated send (EML-2 — and flipping off the client token return
at that point).
