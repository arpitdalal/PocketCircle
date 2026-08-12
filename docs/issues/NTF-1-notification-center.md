# NTF-1 · Notification Center

| | |
|---|---|
| **Status** | Done |
| **Labels** | `area:notifications`, `backend`, `ui` |
| **Depends on** | F0 |
| **Unlocks** | NTF-2 |
| **PRD stories** | 81, 82, 83 |
| **ADRs** | 0015, 0016, 0017, 0018 |
| **Glossary** | Notification Center |

## Intent

The in-app, **user-specific** notification list (glossary). Notifications belong to one User,
have per-User **unread/read** state (PRD 82), can be marked read individually or **in bounded
batches** (PRD 82), and **cannot be deleted** in v1. They **link to the relevant object only when
the User still has access**; otherwise they show **text only**, and archived-but-accessible
objects open in their **archived context** (PRD 83). This slice builds the **read/center surface
+ read-state mutations** over the *already-defined* `notifications` table; the events that *create*
notifications are NTF-2.

This slice has no way to create real notifications on its own — NTF-2 is the writer. So NTF-1 is
exercised by (a) Convex tests that `db.insert` notification rows directly and (b) mock-mode
fixtures in the web UI. End-to-end coverage of real notifications waits for NTF-2.

## Current state (read before implementing)

- **The table already exists** — `notifications` in
  [`schema.ts`](../../packages/convex/convex/schema.ts). **Do not redefine or add columns.**
  Fields: `userId: Id<"users">`, `type: string`, `title: string`, `body?: string`,
  `link?: string` (canonical in-app path), `read: boolean`, `createdAt: number`.
  Indexes: `by_user` (`[userId]`) and `by_user_and_read` (`[userId, read]`).
- **There is no stored entity reference** — only the `link` string. Accessibility is therefore
  re-resolved by **parsing the stored link** at read time (see below). This is the committed
  design: NTF-2 stores the canonical `link` string; NTF-1 access-checks it on read.
- **Auth/guard primitives** ([`auth.ts`](../../packages/convex/convex/auth.ts),
  [`guard.ts`](../../packages/convex/convex/guard.ts)): `requireCurrentUser` (the throw for
  circle-less, own-data ops — the right one here, mirroring `listMyCircles`),
  `resolveCircleAccess` (non-throwing; `null` ≡ missing/non-member/removed/unauthenticated — the
  anti-enumeration collapse). `ctx.db.normalizeId(table, str)` validates a raw id segment to an
  `Id | null` (see `getCircle`/`getCurrentUserOrNull` for the pattern).
- **Ref parsing** ([`packages/domain/src/ref.ts`](../../packages/domain/src/ref.ts)): `parseRef`
  extracts the trailing `…-<id>` segment from a canonical ref; the backend already imports
  `buildRef` from `@pocketcircle/domain`, so the package is available server-side.
- **Web shell**: the header in
  [`protected-layout.tsx`](../../apps/web-app/app/routes/layouts/protected-layout.tsx) renders
  `<AccountMenu>` — the Notification Center bell sits next to it (app-wide, **not** Circle-scoped).
- **Patterns to mirror**: bounded read hook + `MOCKS` fork + `FunctionReturnType` type derivation
  in [`lib/data/notifications.ts`](../../apps/web-app/app/lib/data/notifications.ts); fixtures in
  [`lib/fixtures.ts`](../../apps/web-app/app/lib/fixtures.ts); web test wiring in
  [`app/test/convex-react.tsx`](../../apps/web-app/app/test/convex-react.tsx).

## Implement

### Convex — `packages/convex/convex/notifications.ts`

- **`listNotifications`** (bounded query, not cursor-paginated): `requireCurrentUser` → **unread
  only** via `by_user_and_read` (`read = false`), newest-first (`.order("desc")`), **`.take(20)`**
  (`NOTIFICATION_BATCH_SIZE`) → map each row to a client view through `toNotificationView` backed
  by a per-request **`createNotificationLinkResolver(ctx, user)`** that memoizes circle access
  per `circleId` (see *Link accessibility resolution*). Read notifications are **not** returned —
  the dropdown is an inbox to clear, not a history feed.
  - If the row has no `link`, the view link is `undefined` (text only).
  - Else resolve the link to keep-or-drop. Keep the stored link string when accessible; set the
    view link to `undefined` when not. **Never** throw, never surface why — a dropped link is
    indistinguishable from a never-linked one (anti-enumeration, ADR 0016).
  - Derive `read`, `type`, `title`, `body` straight from the row. The view shape is what the web
    `FunctionReturnType` derives from — keep it minimal and ID-free in user-facing strings.
- **`getUnreadCount`** (query) for the badge: `requireCurrentUser` → count unread via
  `by_user_and_read` (`eq("userId", …).eq("read", false)`). Unread is unbounded, so **cap** the
  scan (`.take(CAP + 1)` with `CAP = 99`) and return `{ count, hasMore }` so the UI renders
  `99+`. No link resolution here — it's a count only.
- **`markNotificationRead`** (mutation): `requireCurrentUser` → `db.get(notificationId)` → assert
  the row exists **and `row.userId === user._id`** before flipping `read: true`. A missing row or
  another User's row collapses to the same generic failure (own-data only; ADR 0015/0016). No-op
  if already read.
- **`markAllRead`** (mutation): `requireCurrentUser` → the **same unread slice** as
  `listNotifications` — `by_user_and_read`, newest-first, `.take(20)` — and patch each to
  `read: true`. Does **not** scan all unread rows; clearing a large backlog is repeated
  mark-all-read (or individual clicks), with Convex reactivity surfacing the next batch after each
  mark-all.

#### Link accessibility resolution (the hard part — get this right)

Stored links are canonical in-app paths in exactly these shapes (the contract NTF-2 must emit):

- Circle: `/circles/<circleRef>`
- Transaction: `/circles/<circleRef>/transactions/<txnRef>`
- Category: `/circles/<circleRef>/categories/<categoryRef>`

Resolution (`resolveNotificationLink` for single links; `createNotificationLinkResolver` for a
list page):

1. Split the path; require the leading `["", "circles", <circleRef>, …]` shape. Anything that
   doesn't match → `undefined` (drop). Ref id segments are **shape-parsed** with
   `parseNotificationLinkPath(link, () => true)`; **`ctx.db.normalizeId`** is the authoritative
   id validator (no redundant regex gate before normalize).
2. `circleId = normalizeId("circles", parsed.circleId)`; `undefined` if it fails.
3. Circle access via **`resolveCircleAccessForUser(ctx, circleId, user)`** inside a memoized
   lookup (one membership/circle read per distinct `circleId` per list request). `null`
   (non-member, removed, missing) → drop the link. An **archived Circle the User still belongs
   to** resolves non-null (read-only) → **keep** the link; the destination route renders archived
   context (CS-4).
4. Circle-only link → keep when access is non-null.
5. Transaction/Category link → also `db.get` the object, confirm it exists **and**
   `object.circleId === circleId`. **Do not** filter on the object's `status` — an
   archived-but-present object stays linked. Removed-member case is already covered by step 3
   returning `null`.

Why **`resolveCircleAccessForUser`** + memoization rather than calling `resolveCircleAccess` per
row: a batch of notifications sharing a Circle must not re-read auth and membership ~20×.
`resolveCircleAccess` remains the single entry for one-off callers; list rendering uses the
ForUser variant with a per-request cache.

Why reuse circle access + a direct `db.get` rather than throwing
`requireTransactionAccess`/`requireCategoryAccess`: we need a **boolean accessibility**, not the
entity-level capabilities those compose, and a notification render must **never throw**.

> **Shared shape contract:** the three canonical link shapes above are a contract between NTF-2
> (writer) and NTF-1 (reader's parser). Encode the builders + parser **once** in
> [`packages/domain/src/notification-links.ts`](../../packages/domain/src/notification-links.ts)
> so the two slices can't drift. NTF-2 reuses the builders.

### Web — Notification Center UI

- **`apps/web-app/app/lib/data/notifications.ts`** (export via the `lib/data.ts` barrel):
  - `Notification` view type **derived** with
    `FunctionReturnType<typeof api.notifications.listNotifications>[number]` — no hand-written
    duplicate type.
  - `useNotifications()` — `useQuery` over `listNotifications` (unread batch, max 20,
    newest-first), with the `MOCKS ? "skip"` fork returning unread rows from
    `MOCK_NOTIFICATIONS`.
  - `useUnreadCount()` — `getUnreadCount` with the `MOCKS` fork.
  - `useMarkNotificationRead()` / `useMarkAllRead()` — `useMutation` wrappers, no-op in mock
    mode.
- **`MOCK_NOTIFICATIONS`** in `lib/fixtures.ts`, typed against the derived `Notification` contract
  (so a view-shape change fails typecheck here, ADR 0006/0003). Include a linked unread one and a
  text-only unread one so the center renders both states offline.
- **`apps/web-app/app/components/notification-center.tsx`**: bell button + unread badge
  (`99+` when capped) + a dropdown list. Each item: `title`, optional `body`, and either a
  React Router `<Link to={notification.link}>` (when present) or plain text (when `undefined`).
  **Batch inbox UX (no “Load more”):**
  - Shows at most **20 unread** notifications (the current batch).
  - **“Mark all read”** sits at the **bottom** of the list (not the header) and marks **only
    that visible batch**; after the mutation, Convex reactively loads the next unread batch (≤20).
  - Clicking one unread item marks it read individually (mutation errors swallowed on navigate —
    defensive invariant for own-data rows).
  - Empty batch: **“You're all caught up”** (read history is not shown in the dropdown).
  Mount in `protected-layout.tsx` beside `<AccountMenu>`. Accessible: button has a label, badge
  count is announced, list is keyboard-navigable.

## Why this way

- **Bounded batch, not cursor pagination**: Notifications are an **inbox to clear**, not a browsable
  history. Unread-only + `.take(20)` at the source keeps every open bounded; backlog clearing is
  “mark this batch → next batch appears” rather than “Load more” through read+unread rows. Still
  index-backed and bounded per README §4 — same constraint, different UX shape than
  Transactions/Categories history feeds.
- **Accessibility resolved at read time, not stored**: access changes (Member removed, Circle
  archived, object hard-deleted), so the link is re-checked on each read — consistent with the
  resolution primitive and anti-enumeration (ADR 0016). The frozen `title`/`body` vs.
  re-resolved `link` split mirrors the history principle of freezing presentation but
  re-resolving references (ADR 0018).
- **Memoized circle access per list request**: rows sharing a Circle must not re-resolve auth and
  membership for every item; `resolveCircleAccessForUser` + `createNotificationLinkResolver` is the
  guard seam for batched reads.
- **Parse the stored link, don't add ref columns**: the committed schema + NTF-2 store a `link`
  string; NTF-1 resolves it. The destination routes already render canonical/archived context and
  re-canonicalize stale slugs on navigation (ADR 0016), so a slightly-stale stored slug is fine.
- **No delete** — only read-state changes (glossary).
- **Own-notifications-only** at the server: every query/mutation gates on
  `row.userId === requireCurrentUser` (ADR 0015) — a User can't read or mark another's.
- **Capped unread count** — the badge can't scan an unbounded unread set per render.

## How to test

Convex tests (`notifications.test.ts`, real logic via `convex-test`; insert rows with `db.insert`
— no mocks of our own modules):

- **Read state:** mark one read; **mark all read clears only the current batch** (≤20) and leaves
  older unread for the next list refresh; `getUnreadCount` updates and caps at `99+`; marking
  another User's notification fails (own-data guard).
- **Batch perf:** a full batch of notifications sharing one Circle resolves circle access once
  (memoized `resolveCircleAccessForUser`).
- **Link resolution:** a notification whose object is accessible keeps the canonical link; after
  the User loses access (Member removed, or Circle archived **and** they're not a Member), the
  same notification resolves **text-only** on the next read; an **archived-but-accessible** object
  keeps its link (archived context handled by the route). A link whose Circle segment doesn't
  match the object's `circleId`, or a malformed link, drops to text-only.
- **Ownership & order:** a User sees only their own **unread** notifications in the list,
  newest-first (read rows are omitted from the dropdown).

Web tests (shared `app/test/convex-react.tsx` wiring — no bespoke per-file scaffolding):

- Center renders linked vs. text-only unread items; clicking an unread item marks it read;
  **“Mark all read” at the bottom** of the list invokes the batch mutation.
- **Mock parity:** the center renders in mock mode from unread rows in `MOCK_NOTIFICATIONS`
  (offline/E2E shell).

(Real-notification **E2E** is deferred to NTF-2, which can create them; NTF-1 has no creation path.)

## Done when

- A User sees their own **unread** notifications in bounded batches (20, newest-first) with live
  read/unread state and access-resolved links (text-only when inaccessible, archived-context when
  archived-but-member); individual read + **batch mark-all at list bottom** (no “Load more”);
  capped unread badge; no deletion; empty inbox copy when caught up; the center renders in mock
  mode; Convex + web tests green; gates pass.

## Out of scope

Creating notifications on events (NTF-2); emails (EML-*). No delete (v1 glossary). No per-Circle
filtering of the center (user-wide list).
