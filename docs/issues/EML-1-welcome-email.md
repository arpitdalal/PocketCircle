# EML-1 · Resend integration + Welcome email

| | |
|---|---|
| **Status** | Todo |
| **Labels** | `area:email`, `backend`, `security` |
| **Depends on** | F0 |
| **Unlocks** | EML-2, FBK-1 |
| **PRD stories** | 84, 86 |
| **ADRs** | 0008, 0015 |
| **Glossary** | Email Notification |

## Intent

Stand up the **Resend** transactional-email path (ADR 0008) and ship the first email: a
**Welcome email after first sign-in** (PRD 84), sent **once per User** (PRD rate-limit). This is
the shared email-sending seam every later email (Invitation EML-2, Feedback FBK-1, Account
Deletion USR-3) composes over. v1 sends **no activity emails** (PRD 86), so the
sender must not become a general notification channel.

## Current state (verified — read before starting)

This slice introduces several "firsts" for the repo. Knowing what already exists vs. what you must
build is the difference between a clean PR and a stuck one.

Already in place; do NOT recreate:

- **The Resend MSW handler already exists.** `packages/mocks/src/handlers.ts` intercepts
  `POST https://api.resend.com/emails`, returns `{ id: "mock-email-id" }`, and pushes the request
  into the exported `capturedRequests` array (with `resetCapturedRequests()`). The original slice
  said "add an MSW handler" — that's done; you **reuse** this one and assert against
  `capturedRequests` (filter `vendor === "resend"`). Do not add a second handler.
- **MSW is wired into the WEB test suite only.** `apps/web-app/vitest.setup.ts` calls
  `server.listen()` / `resetHandlers()` / `close()` from `@pocketcircle/mocks/server`. The web app
  already depends on `@pocketcircle/mocks`.

Does NOT exist yet — you build it in this slice:

- **No Convex action, scheduler call, internal function, or `internalMutation`/`internalAction`
  anywhere in `packages/convex/convex`.** EML-1 is the first. (`internal` IS available from
  `./_generated/api.js` — `auth.ts` already imports it.)
- **The `users` table has no `welcomeSentAt` field** — you add it (schema change).
- **The convex test suite does NOT wire MSW.** `packages/convex/vitest.config.ts` runs under
  `edge-runtime` with no `setupFiles`, and `packages/convex/package.json` does not depend on
  `@pocketcircle/mocks`. This matters a lot for how you test the actual network send — see
  **Testing strategy & the main risk** below.
- **No `RESEND_API_KEY` / from-address env var** is referenced anywhere.

## Implement

### 1. Schema — once-per-User marker (`packages/convex/convex/schema.ts`)

Add to the `users` table: `welcomeSentAt: v.optional(v.number())`. Absent ⇒ not yet sent. Gating on a
persisted marker (not "is this the first session") is what makes Welcome idempotent against re-auth.
`createUserWithPersonalCircle` in `model.ts` does not need to set it (absent is the correct initial
state); only the send path sets it.

### 2. Convex — the `sendEmail` seam as an action (`packages/convex/convex/email.ts`, new)

Use a Convex **action** (network I/O is forbidden in queries/mutations). Call Resend with **`fetch`**,
NOT the Resend SDK — `fetch` runs in Convex's default runtime (no `"use node"` needed) and is what the
MSW handler intercepts (`POST https://api.resend.com/emails`). Read the API key and from-address from
env vars only (`process.env.RESEND_API_KEY`, `process.env.RESEND_FROM_EMAIL`) — never hard-code.

Shape (single vendor-wiring home so EML-2/FBK-1 only pass a template):

```ts
// No "use node" pragma — this stays in Convex's default runtime so MSW intercepts the fetch.
export async function sendEmail(args: { to: string; subject: string; html: string }): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!key || !from) {
    // No silent failure (README §4): surface, don't swallow. Don't throw into the
    // triggering flow — a missing key must not break User bootstrap.
    console.error("Resend env not configured; skipping email send");
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: args.to, subject: args.subject, html: args.html }),
  });
  if (!res.ok) {
    console.error("Resend send failed", res.status, await res.text().catch(() => ""));
    // swallow-after-logging is correct HERE: the email is best-effort and must not
    // roll back the User/Circle bootstrap. (Upgrade to Sentry capture when OBS-1 lands.)
  }
}
```

Then the public-ish internal action that the trigger schedules:

```ts
export const sendWelcomeEmail = internalAction({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    // Re-check + claim the marker via an internal mutation so concurrent triggers
    // can't double-send (action ctx can't touch the DB directly).
    const claimed = await ctx.runMutation(internal.email.claimWelcome, { userId });
    if (!claimed) return;                         // already sent
    await sendEmail({ to: claimed.email, subject: "Welcome to PocketCircle", html: welcomeHtml(claimed.displayName) });
  },
});
```

```ts
// Idempotent claim: returns the user payload to send to ONCE, else null.
export const claimWelcome = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);
    if (!user || user.welcomeSentAt !== undefined) return null;
    await ctx.db.patch(userId, { welcomeSentAt: Date.now() });
    return { email: user.email, displayName: user.displayName };
  },
});
```

Keep the Welcome HTML/subject builder (`welcomeHtml(name)`) a pure function — easy to unit-test and
to assert "no financial content." Put any future template alongside it; the single sender stays the
only place that knows about Resend.

### 3. Trigger the Welcome on first User creation

The Better Auth `onCreate` trigger (`auth.ts`) runs in a mutation context and calls
`createUserWithPersonalCircle` (`model.ts`). Schedule the action from there — a mutation cannot call
an action synchronously, but it can enqueue one:

```ts
await ctx.scheduler.runAfter(0, internal.email.sendWelcomeEmail, { userId });
```

Schedule it in the `onCreate` trigger in `auth.ts` (it already receives the app `MutationCtx` and the
`userId` — `createUserWithPersonalCircle` returns it). Keep `model.ts` free of the scheduler so it
stays a pure bootstrap helper **and** so the shared test seeds don't all enqueue a welcome send: the
test seam (`seedPersonalCircleOwner`, used by every suite) calls `createUserWithPersonalCircle`
directly, so putting the schedule in the model helper would fire a welcome action on every seeded
user. Scheduling in the trigger keeps that side effect on the production sign-up path only.

**Testability note (important):** this scheduling line runs ONLY in production sign-up. The Better
Auth trigger cannot execute under convex-test — every convex suite bootstraps users through the
`model.ts` helper with `./auth.js` `vi.mock`'d (see `users.test.ts` / `seed.ts`), never through
`onCreate`. So do **not** try to unit-test the welcome by "seed a user, then
`finishInProgressScheduledFunctions`" — the seed schedules nothing. Instead unit-test the welcome
behavior by invoking the internal functions **directly** (`t.action(internal.email.sendWelcomeEmail,
{ userId })`, `t.mutation(internal.email.claimWelcome, { userId })` — convex-test accepts `internal`
refs), and let **E2E** cover the trigger→schedule wire-up via a real sign-up. The
`E2E_TEST_AUTH` sign-up path also exercises it end-to-end; the action's missing-env guard makes the
send a harmless no-op there, and a failing send must never break sign-up.

### 4. Mocks — reuse, don't add

The handler exists (see Current state). For assertions, import from `@pocketcircle/mocks`:
`import { capturedRequests, resetCapturedRequests } from "@pocketcircle/mocks";` and filter
`vendor === "resend"`.

### 5. Env — document the required vars

`RESEND_API_KEY` and `RESEND_FROM_EMAIL` are platform/deployment env vars (Convex deployment env,
like `GOOGLE_CLIENT_ID` in `auth.ts`'s header comment). Document them in a header comment in
`email.ts` AND wherever deployment env is listed (mirror the `auth.ts` "Required deployment env vars"
comment). No key in code, no committed `.env`.

## Testing strategy & the main risk (read this)

**The risk:** the *business logic* worth testing (welcome-once idempotency) lives in a mutation, but
the *network send* lives in an action that does `fetch`. The convex test suite (`edge-runtime`,
convex-test) has **no MSW wired today**, and MSW(node) intercepting a `fetch` issued from inside a
convex-test action under `@edge-runtime/vm` is **not proven in this repo**. Don't assume it works —
design the tests so the valuable coverage doesn't depend on it.

**Key lever that de-risks this:** in the convex test environment `RESEND_API_KEY` /
`RESEND_FROM_EMAIL` are unset, so `sendEmail`'s missing-env guard returns BEFORE the `fetch`. That
means the idempotency tests can drive the real action end-to-end with **zero network and zero MSW** —
the only test that needs an actual fetch is the payload-shape assertion, which you opt into by
`vi.stubEnv`-ing the two vars.

Split the coverage. All convex tests live in `packages/convex/convex/email.test.ts` (convex-test;
`vi.mock("./auth.js")` + `import.meta.glob` hoisted/local, exactly like `users.test.ts`; seed users
with `seedPersonalCircleOwner`):

1. **Idempotency (the real logic) — invoke the internal functions directly, NO MSW, NO network.**
   - `claimWelcome`: `t.mutation(internal.email.claimWelcome, { userId })` → first call returns the
     `{ email, displayName }` payload and patches `welcomeSentAt`; a second call returns `null` and
     does not re-patch (assert the timestamp is unchanged).
   - `sendWelcomeEmail`: `t.action(internal.email.sendWelcomeEmail, { userId })` twice → after the
     first, `welcomeSentAt` is set; the second is a no-op (still set once, marker unchanged). Force the
     no-op deterministically with `vi.stubEnv("RESEND_API_KEY", "")` (don't rely on the ambient shell
     being unset — a dev with the key exported would otherwise hit a real `fetch`), so this asserts the
     claim/idempotency path with no vendor dependency at all.
2. **Template purity — `email.test.ts` (or domain if you put the builder there).** `welcomeHtml(name)`
   contains the name, the expected subject/copy, and **no financial content** (assert no
   amount/currency strings) — a pure-function assertion, zero mocks.
3. **The Resend payload shape over the wire (the only network test).** First try wiring MSW into the
   convex suite: add `@pocketcircle/mocks` as a devDependency of `packages/convex`, add a
   `vitest.setup.ts` doing `server.listen()/resetHandlers()/close()` (copy the lifecycle from
   `apps/web-app/vitest.setup.ts`), and set `setupFiles` in `packages/convex/vitest.config.ts`. In the
   test, `vi.stubEnv("RESEND_API_KEY", "test")` + `vi.stubEnv("RESEND_FROM_EMAIL", "no-reply@…")` so
   the guard passes, run `t.action(internal.email.sendWelcomeEmail, { userId })`, then assert
   `capturedRequests.filter(r => r.vendor === "resend")` got the expected body (`to`, `from`,
   `subject`, no financial content); `resetCapturedRequests()` between tests. **If the action's
   `fetch` is not intercepted under edge-runtime** (verify FIRST — write this test before the rest and
   confirm it captures), do not fight it: instead unit-test `sendEmail(...)` directly from a node-env
   test where MSW is already proven (a small `*.test.ts` in `apps/web-app`, whose suite wires MSW),
   asserting the same payload. State in the PR which path you used. Tests 1 and 2 (the high-value
   ones) stand regardless.

Also assert:

- **No activity emails:** ordinary Circle activity (create Category/Transaction, etc.) produces zero
  `resend` captured requests.
- **Env safety:** with `RESEND_API_KEY`/`RESEND_FROM_EMAIL` unset, `sendEmail` logs and returns
  without throwing and without a `fetch` — the action still completes and claims the marker (assert no
  `resend` request was captured).
- **Vendor error is handled gracefully:** a non-2xx Resend response is logged and does not break the
  triggering mutation (make the handler return a 500 for one assertion if you have the MSW path).

## Why this way

- **Single `sendEmail` seam** keeps Resend wiring, the env reads, retries, and the mock in one deep
  module — EML-2 and FBK-1 just pass a template, never re-wire the vendor.
- **`fetch`, not the Resend SDK** — stays in Convex's default runtime (no `"use node"`) and is the
  exact request the existing MSW handler matches.
- **Schedule the action from the mutation trigger** — a mutation can't run network I/O or call an
  action inline; `ctx.scheduler.runAfter(0, …)` is the supported hand-off, and a best-effort email
  must never roll back User bootstrap.
- **Once-per-User Welcome is a claimed DB marker** (`welcomeSentAt`), claimed inside a mutation so
  concurrent triggers can't double-send — idempotent against re-sign-in, not "is this the first
  session."
- **Best-effort, no silent failure:** missing env / vendor error is logged (Sentry once OBS-1 lands)
  and swallowed *only* at the email boundary, never propagated into the bootstrap effect.

## Done when

- A reusable `sendEmail`/Resend seam exists (action, `fetch`, env-driven) reusing the existing MSW
  mock; `welcomeSentAt` gates the Welcome to exactly once per User (idempotent across re-auth); the
  Welcome is scheduled off first User creation; no activity emails fire; the payload contains no
  financial content; missing env and vendor errors degrade gracefully without breaking bootstrap;
  `RESEND_API_KEY` + `RESEND_FROM_EMAIL` documented as deployment env vars; tests green; all gates
  pass (`pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`).

## Out of scope

Invitation email (EML-2); Feedback email (FBK-1); in-app notifications (NTF-*). Retry/queueing beyond
Convex's scheduler default; an email-preferences surface.
