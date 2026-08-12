# EML-2 · Invitation email

| | |
|---|---|
| **Status** | Shipped |
| **Labels** | `area:email`, `backend`, `ui`, `security` |
| **Depends on** | MEM-2 (shipped — PR #177), EML-1 (shipped — PR #176) |
| **Unlocks** | MEM-4 (resend send path wired here, rate-limit enforcement in MEM-4) |
| **PRD stories** | 85, 16 |
| **ADRs** | 0008, 0015, 0016 |
| **Glossary** | Invitation, Invitation Link, Email Notification |

## Intent

Deliver the **Invitation Link** by email the moment an Owner creates an invitation (MEM-2) so
the invited person receives a direct `/invite/:token` link without the Owner having to copy and
paste it manually. The token exists only in the email body — the DB stores only its hash (ADR
0016). When MEM-4 ships, the resend flow calls the same action with the rotated plaintext token.
Rate-limit enforcement (`≤3 resend/day/Circle+email`, `≤100 invitation emails/User/day`) is
MEM-4's concern; EML-2 sends unconditionally and lets MEM-4 enforce the caps when it lands.

## Current state (verified — read before starting)

Already shipped; do NOT recreate:

- **`emailPool`** (`packages/convex/convex/email.ts`): `new Workpool(components.emailWorkpool, { maxParallelism: 5, retryActionsByDefault: true, defaultRetryBehavior: { maxAttempts: 5, initialBackoffMs: 30_000, base: 2 } })`. ONE shared pool for ALL transactional email (welcome + invitation + feedback). Resend free-plan ceiling is 20 concurrent across ALL pools — keep the sum under it.
- **`sendEmail({ to, subject, html, idempotencyKey? })`** (`email.ts`): posts to Resend via `fetch`; returns `false` when `RESEND_API_KEY`/`RESEND_FROM_EMAIL` unset (no-op); THROWS on non-2xx or fetch reject so the Workpool retries; sets `Idempotency-Key` header (dedupes 24h at Resend).
- **Welcome email pattern** (`email.ts`) — the exact shape EML-2 mirrors:
  - `welcomePayload` — `internalQuery`, reads the user row, returns `{ alreadySent, email, displayName }`.
  - `sendWelcomeEmail` — `internalAction`: runs the payload query, if `!alreadySent` calls `sendEmail` with `idempotencyKey: \`welcome:${userId}\``, then `runMutation(markWelcomed)`.
  - `onWelcomeRunComplete` — `internalMutation` via `vOnCompleteValidator`; logs terminal failure (`result.kind === "failed"`), no-ops on success/canceled.
  - Enqueued from `auth.ts` `onCreate`: `emailPool.enqueueAction(ctx, internal.email.sendWelcomeEmail, { userId }, { onComplete: internal.email.onWelcomeRunComplete, context: { userId } })`.
  - `welcomeHtml(displayName)` / `escapeHtml()` — pure builders; NO financial content (PRD 84); all interpolated values HTML-escaped.
- **`SITE_URL`** env var (`auth.ts` line 74: `const siteUrl = process.env.SITE_URL ?? "http://127.0.0.1:5173"`): the app origin; invitation links are built against this.
- **`createInvitation` mutation** (`packages/convex/convex/invitations.ts`, MEM-2): generates token + hash, inserts the invitation row (`{ circleId, emailLower, tokenHash, status: "pending", invitedByUserId, resendCount: 0, createdAt, expiresAt: now + 7d }`), records `"member invited"` event, and currently `return { token }` (the plaintext) back to the inviting Owner for manual link delivery. **EML-2 removes this return** (see §Implement step 5).
- **`invitationToken.ts`**: `generateInvitationToken()` / `hashInvitationToken(token)` — plaintext is transient; only `tokenHash` is persisted.
- **MSW Resend handler** (`packages/mocks/src/handlers.ts`): already captures `{ vendor: "resend", url, body, headers }` into `capturedRequests[]` and returns `{ id: "mock-email-id" }` on 200. No changes needed — reuse it in tests.
- **`InviteMemberForm`** (`apps/web-app/app/routes/circle/members.tsx`): currently calls `createInvitation`, destructures `{ token }` from the result, and renders a copyable `/invite/${token}` link. **EML-2 replaces this surface** with a "Invitation sent to \<email>" confirmation (see §Implement step 5).
- **`useCreateInvitation`** (`apps/web-app/app/lib/data/invitations.ts`): thin `useMutation(api.invitations.createInvitation)` hook — comment says "returns the plaintext token for manual link delivery until EML-2 moves sending server-side." EML-2 updates that comment.

Does NOT exist yet — create in this slice:

- `invitationHtml(...)` pure builder in `email.ts`.
- `invitationPayload` internalQuery in `email.ts`.
- `sendInvitationEmail` internalAction in `email.ts`.
- `onInvitationRunComplete` internalMutation in `email.ts`.
- `emailPool.enqueueAction(...)` call inside `createInvitation` (and, when MEM-4 lands, inside `resendInvitation`).
- Web layer change: `createInvitation` stops returning `{ token }`; `InviteMemberForm` shows a confirmation instead of a copyable link.

## Implement

Work in this order so the lower layer is testable before the upper layer touches it.

### 1. `invitationHtml` builder (`packages/convex/convex/email.ts`)

Pure HTML builder — mirror `welcomeHtml`. Escape ALL interpolated values with the existing `escapeHtml`. No financial content (PRD 84).

```ts
export const INVITATION_SUBJECT = "You're invited to join a Circle on PocketCircle";

export function invitationHtml(args: {
  inviteLink: string;
  circleName: string;
  ownerDisplayName: string;
  ownerImage: string | undefined;
  recipientEmail: string;
}) {
  const { inviteLink, circleName, ownerDisplayName, recipientEmail } = args;
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${INVITATION_SUBJECT}</title></head>
<body>
  <p>Hi ${escapeHtml(recipientEmail)},</p>
  <p>${escapeHtml(ownerDisplayName)} has invited you to join the <strong>${escapeHtml(circleName)}</strong> Circle on PocketCircle.</p>
  <p><a href="${escapeHtml(inviteLink)}">Accept the invitation</a></p>
  <p>This link expires in 7 days and can only be used once.</p>
  <p>— The PocketCircle team</p>
</body>
</html>`;
}
```

`ownerImage` is accepted (for future rich templates) but need not appear in the v1 body.

### 2. `invitationPayload` internalQuery + `sendInvitationEmail` internalAction (`email.ts`)

**Resolving the plaintext-token-through-workpool tension — chosen approach: pass the plaintext
token as an enqueue arg.**

Workpool job rows are persisted by the `emailWorkpool` Convex component until the job runs and
is acknowledged. This means `enqueueAction` args are transiently stored. Passing the plaintext
token there is acceptable because:

- Workpool rows are ephemeral: deleted once the job succeeds (or exhausts retries).
- The token is single-use and 7-day expiry; if the DB were compromised during that window the
  attacker still needs to use the link before expiry, and the hash in `invitations.tokenHash`
  can be used to revoke (MEM-4).
- The alternative — storing the token in the invitation row for the action to read later — would
  persist plaintext indefinitely, directly violating ADR 0016.
- The other alternative — calling `sendEmail` inline inside the `createInvitation` mutation
  — is impossible: mutations cannot perform network I/O in Convex.

So: the plaintext token is passed as an arg to `emailPool.enqueueAction`. The Workpool holds it
transiently (not as a permanent DB column), and the action consumes it immediately when it runs.

```ts
export const invitationPayload = internalQuery({
  args: {
    invitationId: v.id("invitations"),
  },
  handler: async (ctx, { invitationId }) => {
    const invite = await ctx.db.get(invitationId);
    if (!invite || invite.status !== "pending") {
      return null; // already accepted/revoked/expired; skip send
    }
    const circle = await ctx.db.get(invite.circleId);
    const owner = await ctx.db.get(invite.invitedByUserId);
    if (!circle || !owner) {
      return null;
    }
    return {
      recipientEmail: invite.emailLower,
      circleName: circle.name,
      ownerDisplayName: owner.displayName,
      ownerImage: owner.image,
    };
  },
});

export const sendInvitationEmail = internalAction({
  args: {
    invitationId: v.id("invitations"),
    token: v.string(), // plaintext — transient workpool arg, never persisted as a column
  },
  handler: async (ctx, { invitationId, token }) => {
    const p = await ctx.runQuery(internal.email.invitationPayload, { invitationId });
    if (!p) {
      return; // invitation no longer sendable (stale/revoked); drop silently
    }
    const siteUrl = process.env.SITE_URL ?? "http://127.0.0.1:5173";
    const inviteLink = `${siteUrl}/invite/${token}`;
    await sendEmail({
      to: p.recipientEmail,
      subject: INVITATION_SUBJECT,
      html: invitationHtml({
        inviteLink,
        circleName: p.circleName,
        ownerDisplayName: p.ownerDisplayName,
        ownerImage: p.ownerImage,
        recipientEmail: p.recipientEmail,
      }),
      idempotencyKey: `invite:${invitationId}`,
    });
  },
});
```

No `markSent` mutation is needed — unlike the welcome email (which guards against double-send
via `welcomeSentAt`), the invitation's own `status` field serves that purpose: `invitationPayload`
returns `null` if `status !== "pending"`, which silently drops the send on a stale job.

### 3. `onInvitationRunComplete` internalMutation (`email.ts`)

Mirror `onWelcomeRunComplete` exactly:

```ts
export const onInvitationRunComplete = internalMutation({
  args: vOnCompleteValidator(v.object({ invitationId: v.id("invitations") })),
  handler: async (_ctx, { context, result }) => {
    if (result.kind === "failed") {
      console.error("Invitation email exhausted all retries", context.invitationId, result.error);
      // TODO(OBS-1): Sentry.captureMessage here.
    }
  },
});
```

### 4. Enqueue from `createInvitation` (`packages/convex/convex/invitations.ts`)

After `ctx.db.insert(...)` and `recordEvent(...)`, enqueue the send. The `invitationId` returned
by `ctx.db.insert` is used as context; the `token` plaintext is passed as an arg.

```ts
const invitationId = await ctx.db.insert("invitations", { ... });

await recordEvent(ctx, { ... });

await emailPool.enqueueAction(
  ctx,
  internal.email.sendInvitationEmail,
  { invitationId, token },
  {
    onComplete: internal.email.onInvitationRunComplete,
    context: { invitationId },
  },
);
```

Import `emailPool` from `./email.js` and `internal` from `./_generated/api.js` (both already
imported by `auth.ts`; add to `invitations.ts`).

**Idempotency key strategy:**

- On **create**: `invite:${invitationId}` — one key per invitation row. Resend dedupes same-key
  sends for 24h, so a Workpool retry of the same send won't re-deliver.
- On **resend** (MEM-4, cross-slice): the token is rotated and a fresh `resendCount` is
  incremented. Use `invite:${invitationId}:${resendCount}` so the new token's email is NOT
  deduped against the prior send. If you used the same key `invite:${invitationId}`, Resend
  would silently drop the resend email for 24h (the old link, now invalid, would be the only
  delivery).
- DO NOT scope by user (`invite:${userId}`): one user can be legitimately invited to many
  Circles in the same 24h window — a user-scoped key would collapse distinct, valid invitations
  into a single delivery.

MEM-4 must pass `idempotencyKey: \`invite:${invitationId}:${resendCount}\`` when it calls the
action (or pass `resendCount` as an arg and let `sendInvitationEmail` build the key).

### 5. Flip `createInvitation` return + update `InviteMemberForm`

**Decision: once sending is server-side, stop returning `{ token }` to the client.**

The plaintext token must never reach the client after EML-2 because:
- The email is the delivery channel; the Owner seeing the token in the UI is no longer needed.
- Returning a bearer credential to the client is a needless exposure (ADR 0016).

Changes required:

**`packages/convex/convex/invitations.ts`**: change `return { token }` to `return { invitationId }` (the ID is safe public info; the client can show it as a reference if needed) or just remove the return entirely (return `void`/`undefined`). Returning `void` is cleanest — the UI only needs to show a success confirmation.

**`apps/web-app/app/lib/data/invitations.ts`**: update the JSDoc comment — the hook still wraps `useMutation(api.invitations.createInvitation)` but the return type no longer includes `token`. Since `FunctionReturnType` is derived automatically, the type updates for free.

**`apps/web-app/app/routes/circle/members.tsx` — `InviteMemberForm`**: remove the `inviteLink` state, the `setInviteLink(...)` call, and the copyable-link UI block. Replace with a simple confirmation:

```tsx
// Replace inviteLink state + display block with:
const [successEmail, setSuccessEmail] = useState<string | null>(null);

// On success:
setSuccessEmail(parsed.data.email);
setEmail("");

// Render (instead of the inviteLink block):
{successEmail ? (
  <p role="status" className="text-sm text-green-700">
    Invitation sent to {successEmail}.
  </p>
) : null}
```

Also remove the `MOCKS ? { token: "mock-invite-token" } : await createInvitation(...)` ternary — `createInvitation` now returns void in both paths, so the MOCKS fork is no longer needed (the mutation hook is called directly; MOCKS behavior is handled by the `convex/react` double in tests).

**`apps/web-app/app/routes/circle/members.test.tsx`**: update the success test — instead of asserting `findByRole("status")` with an "Invitation link" input, assert `findByRole("status")` with text matching `/invitation sent to ada@example\.com/i`. Remove the assertion on `getByLabelText("Invitation link")`.

## Why this way

- **Token only in the email link** (ADR 0016): the mutation mints the plaintext, passes it to the
  Workpool action arg (transient — not a DB column), and the action delivers it in the link. The
  DB holds only `tokenHash`. A leaked DB yields no working links.
- **Workpool arg for the token** (over inline send or a DB column): mutations can't do network I/O;
  storing plaintext in a DB column violates ADR 0016; the Workpool arg is the only correct seam.
  The job row is ephemeral — it disappears after success or retry exhaustion.
- **No `markSent` mutation**: the invitation's own `status` field (`pending` → `accepted`/`revoked`/
  `expired`) is the guard. If the action runs after the invitation was revoked, `invitationPayload`
  returns `null` and the send is silently dropped — correct behavior.
- **Per-invitation idempotency key** (not per-user): one user can be invited to many Circles in a
  24h window — distinct emails that must not collapse. A resend uses a counter-suffixed key
  (`invite:${invitationId}:${resendCount}`) so the new token reaches Resend instead of being
  deduped against the prior send.
- **Removes the client token return**: now that delivery is server-side, returning a bearer
  credential to the browser is an unnecessary exposure. The UI switches from "copy link" to a
  "sent to \<email>" confirmation.
- **Reuses `emailPool` / `sendEmail`**: no new vendor wiring, no new pool. The Resend MSW handler
  already captures invitation emails alongside welcome emails.
- **`SITE_URL` env var** (`process.env.SITE_URL ?? "http://127.0.0.1:5173"`) — the same value used
  in `auth.ts` for `siteUrl` / `crossDomain`. No new env var needed.

## How to test

Backend tests add to **`packages/convex/convex/email.test.ts`** (for the new builder/action/handler)
and **`packages/convex/convex/invitations.test.ts`** (for the enqueue-on-create integration).
Use `seedCircle` + `addMember` + `completeSetup` helpers already in those files.
Reuse `capturedRequests` / `resetCapturedRequests` / `server.use(http.post(...))` from
`@pocketcircle/mocks` exactly as `email.test.ts` does.

### `invitationHtml` (email.test.ts)

- Contains circle name, owner display name, recipient email, the invite link, "expires in 7 days".
- Does NOT match `FINANCIAL_PATTERN` (same regex as welcome test).
- Escapes HTML-special chars in all interpolated values (circle named `"<script>"` → escaped in output).

### `invitationPayload` (email.test.ts)

- Happy: returns `{ recipientEmail, circleName, ownerDisplayName, ownerImage }` for a pending invitation.
- Returns `null` for a non-pending invitation (`status: "accepted"` / `"revoked"` / `"expired"`).
- Returns `null` when the invitation row doesn't exist.
- Returns `null` when the circle or owner row is missing (defensive guard).

### `sendInvitationEmail` (email.test.ts)

- Posts to Resend exactly once with correct `to` (invited email), `subject` (`INVITATION_SUBJECT`),
  `Idempotency-Key: invite:${invitationId}`, and HTML containing the `/invite/<token>` link (assert
  the link contains the token passed as arg; assert `SITE_URL` is used when set).
- Does NOT send when `invitationPayload` returns `null` (stale/revoked invitation).
- Does NOT send when `RESEND_API_KEY`/`RESEND_FROM_EMAIL` unset (sendEmail no-op path).
- Rejects on Resend 5xx; does NOT corrupt the invitation row (assert `status` unchanged after failure).
- Uses `SITE_URL` env var for the link origin (stub `SITE_URL=https://app.example.com` and assert
  link starts with `https://app.example.com/invite/`).
- **Per-invitation idempotency**: seed two invitations for the same user (different Circles) and call
  `sendInvitationEmail` for each — assert two distinct `Idempotency-Key` headers and two Resend
  requests (not deduped into one).

### `onInvitationRunComplete` (email.test.ts)

- `result.kind === "failed"` → `console.error` called with invitationId + error string.
- `result.kind === "success"` → no `console.error`.

### Enqueue-on-create integration (invitations.test.ts)

- After `createInvitation` succeeds, `capturedRequests` contains exactly one Resend request with
  `to` = the invited email and the HTML link containing a token (assert link structure, not exact
  token value — the plaintext isn't returned to the client anymore).
- Stub `RESEND_API_KEY` + `RESEND_FROM_EMAIL` for this test (same pattern as email.test.ts).
- `createInvitation` that throws (e.g. `invite.alreadyPending`) → zero Resend requests.

### Web layer (`apps/web-app/app/routes/circle/members.test.tsx`)

Update the existing success test:
- On successful invite, `findByRole("status")` contains "Invitation sent to ada@example.com".
- No `getByLabelText("Invitation link")` input is present.
- Submit button is disabled while in-flight, re-enabled after.
- `createInvitation` mock returns `undefined` (void) — remove the `{ token: "..." }` mock return.

All existing negative/permission tests remain unchanged.

## Done when

- `createInvitation` enqueues an invitation email via `emailPool`; the invited person's email
  receives a `/invite/:token` link (link built against `SITE_URL`); the plaintext token is not
  returned to the client and not persisted in a DB column.
- `invitationHtml` has no financial content; all interpolated values are HTML-escaped.
- Per-invitation idempotency key (`invite:${invitationId}`) dedupes retries but not distinct invitations.
- `onInvitationRunComplete` logs terminal failures (TODO Sentry OBS-1).
- `InviteMemberForm` shows "Invitation sent to \<email>" on success (no copyable link).
- Tests green; all gates pass (`pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`).

## Out of scope

- Resend on re-invite (MEM-4 calls `sendInvitationEmail` with `idempotencyKey: \`invite:${invitationId}:${resendCount}\``).
- Rate-limit enforcement (≤3 resend/day, ≤100/User/day) — MEM-4 enforces before calling send.
- Accepting invitations (MEM-3); revoking (MEM-4); rich email template with owner avatar image (future).
- The email seam itself (EML-1, shipped).
