# FBK-1 · Feedback

| | |
|---|---|
| **Status** | Done |
| **Labels** | `area:feedback`, `backend`, `ui`, `security` |
| **Depends on** | EML-1 (implemented email seam), SET-1 (implemented version + opt-out UI), OBS-2 for the optional analytics event |
| **PRD stories** | 89, 90, 184, 218 |
| **ADRs** | 0003, 0006, 0008, 0010, 0013, 0015, 0017 |
| **Glossary** | Feedback |

## Intent

In-app **Feedback** lets a signed-in User report a bug or request a feature/currency (PRD 89).
It captures `type`, a required free-text `message`, optional current Circle context, and auto
support metadata: User email, Display Name, app version, and timestamp. It sends one support email
through the existing Resend seam and creates **no Circle data**. Feedback free text must never go
to product analytics, Sentry extra, history, notifications, or any Circle-scoped table.

Server-side rate limit: **20 submissions/User/day**. The rate-limit state may be an app-level event
ledger, but it must store only safe metadata needed for enforcement. Do **not** store feedback
message text in Convex.

## Current state to reuse

- **Email seam already exists:** [`packages/convex/convex/email.ts`](../../packages/convex/convex/email.ts)
  exports `sendEmail(args)` and `emailPool`. It uses `fetch` to Resend, env
  `RESEND_API_KEY` / `RESEND_FROM_EMAIL`, optional `EMAIL_DEV_LOG=1`, and supports
  `idempotencyKey`. Reuse it; do not add another Resend wrapper or SDK.
- **Workpool is already registered for Convex tests:** use
  [`packages/convex/test/registerEmailWorkpool.ts`](../../packages/convex/test/registerEmailWorkpool.ts)
  if a test drains queued feedback email work.
- **MSW Resend handler already exists:** [`packages/mocks/src/handlers.ts`](../../packages/mocks/src/handlers.ts)
  captures `vendor: "resend"` into `capturedRequests`. Reuse it; do not add another handler.
- **Current User view already has support metadata:** `users.getCurrentUser` includes `email`,
  `displayName`, `analyticsOptOut`, and the web session maps them in
  [`apps/web-app/app/lib/session.ts`](../../apps/web-app/app/lib/session.ts).
- **App version is already build-injected:** `__APP_VERSION__` is declared in
  [`apps/web-app/app/env.d.ts`](../../apps/web-app/app/env.d.ts) and injected from
  [`apps/web-app/vite.config.ts`](../../apps/web-app/vite.config.ts). Pass this from web to the
  mutation; the backend cannot read Vite globals.
- **Settings is a good entry point:** [`apps/web-app/app/routes/settings.tsx`](../../apps/web-app/app/routes/settings.tsx)
  already has Profile, Privacy, and About sections plus `SnackbarProvider` usage. Add Feedback
  there unless you have a concrete UX reason to add a separate route.
- **Mutation error UX exists:** add a coded `feedback.dailyCapReached` to
  [`packages/domain/src/mutation-errors.ts`](../../packages/domain/src/mutation-errors.ts) and map it
  with [`apps/web-app/app/lib/mutation-user-message.ts`](../../apps/web-app/app/lib/mutation-user-message.ts).
- **Shared web Convex test doubles exist:** extend `apps/web-app/app/test/convex/users.ts` and the
  barrel [`apps/web-app/app/test/convex-react.tsx`](../../apps/web-app/app/test/convex-react.tsx);
  do not hand-roll route-local Convex mocks.

## Implement

### 1. Domain validation + template

In `packages/domain/src/validation.ts` add:

- `FEEDBACK_TYPES = ["bug", "feature", "currency"] as const`.
- `feedbackInputSchema` with `type: z.enum(FEEDBACK_TYPES)` and
  `message: z.string().trim().min(1, "Message is required").max(4000, ...)`.
- `parseFeedbackInput(input)` if the web form needs the same friendly parse shape as
  `parseProfileUpdate`.

In `packages/domain/src/email-templates.ts` add `feedbackEmail(args)`:

- Inputs: `type`, `message`, `userEmail`, `displayName`, `appVersion`, optional `circleName`,
  optional `circleRef`, `submittedAtIso`.
- Subject: include coarse type only, e.g. `PocketCircle feedback: bug`.
- HTML-escape every value using the existing `escapeHtml`.
- Keep it pure and unit-test it.

Export new symbols through `packages/domain/src/index.ts`.

### 2. Convex schema for rate limiting only

Add table to `packages/convex/convex/schema.ts`:

```ts
feedbackEmailEvents: defineTable({
  userId: v.id("users"),
  type: v.union(v.literal("bug"), v.literal("feature"), v.literal("currency")),
  sentAt: v.number(),
}).index("by_user_and_sentAt", ["userId", "sentAt"]),
```

Do not store `message`, email body, Circle id, Circle name, or app version here. This table is
only the server-side rate-limit ledger. It is not Circle data and has no Circle index.

### 3. Convex feedback function

Create `packages/convex/convex/feedback.ts`.

Use a public `mutation`, not an action, for the client entry point:

1. `const user = await requireCurrentUser(ctx)`.
2. Validate args with Convex validators at the boundary, then parse with `parseFeedbackSubmission`
   (type, message, appVersion).
3. If optional `circleId` is provided, resolve with `resolveCircleAccessForUser(ctx, circleId, user)`.
   Inaccessible/missing Circle means omit Circle context; feedback submission should not reveal Circle
   existence.
4. Insert `feedbackEmailEvents` after validation. It records the submission for rate limiting, not
   the free text.
5. Enforce 20/User/day **after** the insert: query `feedbackEmailEvents.by_user_and_sentAt` with
   `gt(sentAt, Date.now() - 24 * 60 * 60 * 1000)` and `.take(21)`. If more than 20 rows are in the
   rolling window, delete the row just inserted and throw
   `new ConvexError(mutationErrorData(MUTATION_ERRORS.feedbackDailyCapReached))`. This keeps the cap
   check, ledger insert, and enqueue aligned so a capped user never schedules `sendFeedbackEmail`.
6. Enqueue an internal action with `emailPool.enqueueAction(...)` only when the cap check passes.

Create internal action `sendFeedbackEmail` in the same module or in `email.ts`. Keep vendor wiring
in `sendEmail`; the action should only build template payload and call `sendEmail`.

Recommended env var: `SUPPORT_EMAIL`. If unset, log and no-op like the existing missing Resend env
path; do not break the user flow. Document it in the module header and deployment notes.

Recommended idempotency key: `feedback:${eventId}` if the mutation stores the event id and passes
it to the action. That makes Workpool retries safe.

### 4. Web data hook

Add a small data module, e.g. `apps/web-app/app/lib/data/feedback.ts`:

- `export function useSubmitFeedback() { return useMutation(api.feedback.submitFeedback); }`
- Export it from `apps/web-app/app/lib/data.ts`.

No query and no mock fixture needed unless you add a read surface. For tests, extend the shared
Convex mock registry with a `submitFeedback?: Mock` mutation slot.

### 5. Web UI

Add a Feedback form in Settings unless deliberately choosing another authenticated surface.

Expected UX:

- Type control: Bug, Feature request, Currency request.
- Required textarea, max 4000, visible character limit or remaining count.
- Read-only support context shown compactly: signed-in email, display name, app version, and current
  Circle name if this form can know one. In global Settings it may say no Circle context.
- Submit disabled while invalid or in-flight; double-submit guarded.
- Success clears message and shows snackbar.
- Cap error shows the shared coded message from `mutationErrorMessageForUser`.
- Unexpected error logs to console and shows a visible `role="alert"` message.

If adding a Circle-scoped entry point later, pass `circleId` from `CircleLayout` context. Do not pass
Circle refs/names as trusted backend context; resolve them server-side from id/access.

### 6. Analytics privacy

OBS-2 is still the real PostHog slice. If it is present when FBK-1 lands, capture only:

```ts
track("feedback_submitted", { type })
```

Never include `message`, `userEmail`, `displayName`, `circleName`, ids, refs, titles, amounts,
notes, search text, or any free text. If OBS-2 is not present, do nothing here; do not build a
temporary analytics seam.

## How to test

### Domain

- `feedbackInputSchema` accepts each allowed type.
- Empty/whitespace message fails.
- Over-4000 message fails.
- `feedbackEmail` escapes HTML in message/user/circle fields.

### Convex

Use `convex-test` with real functions and `registerEmailWorkpool` if draining the queued action.
Do not mock app modules.

- Auth required: unauthenticated call fails.
- Valid feedback inserts one `feedbackEmailEvents` row with only `{ userId, type, sentAt }`.
- Valid feedback enqueues/sends one support email with type, message, email, display name, app
  version, timestamp, and optional Circle context.
- No Circle data is created or mutated: no histories, notifications, transactions, categories,
  members, or circles touched.
- Inaccessible/missing optional Circle context does not leak and still submits without context.
- 20 submissions inside rolling day pass; 21st throws coded `feedback.dailyCapReached`.
- A submission just outside the rolling 24h window no longer counts.
- Missing `SUPPORT_EMAIL` does not throw from the user mutation.

### Web

Use `configureConvex` / shared test doubles; do not mock `~/lib/data`.

- Settings renders Feedback with current user email/name and `__APP_VERSION__`.
- Submit trims message, calls `submitFeedback({ type, message, appVersion: __APP_VERSION__ })`,
  disables while pending, and clears on success.
- Empty message blocks submission.
- Coded daily-cap error renders the shared user message.
- Unexpected rejection renders fallback alert.

### Privacy

- Assert no analytics payload contains feedback message/email/name/Circle context. If OBS-2 is not
  installed, assert FBK-1 does not import/build a temporary analytics client.
- Assert Sentry/reporting paths are not called with feedback message as extra context.

## Done when

- Signed-in User can submit typed feedback from the app.
- Support email is sent through existing Resend `sendEmail`.
- Rate limit 20/User/day is enforced server-side with coded UX.
- Convex stores only safe rate-limit metadata; it never stores feedback free text.
- Feedback creates no Circle-scoped data and writes no history/notification rows.
- Free text is not sent to analytics or Sentry.
- Tests above pass.
- Gates pass: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`.

## Out of scope

- Building PostHog itself (OBS-2).
- Sentry wiring (OBS-1 already done).
- A feedback inbox/admin UI.
- Attachments/screenshots.
- Activity notification emails.
