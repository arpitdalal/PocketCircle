# CAT-3 · Inline Category create in Transaction form

| | |
|---|---|
| **Status** | Done |
| **Labels** | `area:categories`, `ui` |
| **Depends on** | CAT-1, TXN-1 |
| **Unlocks** | — |
| **PRD stories** | 53 |
| **ADRs** | 0003, 0015 |
| **Glossary** | Category |

## Intent

Entry must not be interrupted: a Member adding a Transaction who needs a Category that
doesn't exist yet should create it **without leaving the form** (PRD 53). This is a UI
composition slice — it reuses CAT-1's `createCategory` mutation; it does not introduce a new
backend path. The newly created Category must immediately become selectable and selected in
the open form, with the form's current Transaction type pinning the new Category's type
(Expense form ⇒ Expense Category).

## Current codebase state (read these first)

The codebase moved on since this slice was written. Orient on these exact files before
touching anything — do not assume the old "inline form on the Monthly Ledger" shape.

- **The Transaction form is `apps/web-app/app/components/transaction-form/transaction-form.tsx`.**
  It is the single create+edit unit. Create is now its **own route**
  (`apps/web-app/app/routes/circle/transaction-new.tsx`, `/circles/:circleRef/transactions/new`,
  issue #96) — NOT an inline ledger form behind a `new` query param (that earlier shape is
  gone; ignore any stale comment that still says so). You do not touch the route for this
  slice; all work is inside the form's Category section.
- **The Category multi-select lives in its own file:**
  `apps/web-app/app/components/transaction-form/transaction-form-category-section.tsx`
  (`TransactionFormCategorySection`). This is the integration point. It is a base-ui
  `Combobox` (`~/components/ui/combobox.js`) in `multiple` chips mode. The parent passes it:
  - `activeType: TransactionType` — the form's current type (already pins everything below).
  - `categoryById: ReadonlyMap<string, Category>` — **all** active + archived Categories of
    `activeType` (the parent loads with `includeArchived: true`), so you can detect same-name
    collisions client-side without a round-trip.
  - `activeCategories: Category[]` — the selectable (active) subset.
  - `alreadyAttached: ReadonlySet<string>` — ids already on the edited Transaction.
  - It reads the form field via `useTypedAppFormContext`; the selected ids are
    `field.state.value` and you select with `field.handleChange(nextIds)`.
- **Reuse the existing create hook:** `useCreateCategory()` from `~/lib/data.js`
  (`apps/web-app/app/lib/data/categories.ts`) → `useMutation(api.categories.createCategory)`.
  **It returns ONLY the new `Id<"categories">` (a string), not a Category view.** Auto-select
  by pushing that id into `field.handleChange`. The full Category row arrives via the parent's
  live `useCategories(...)` query and flows back down through `categoryById` reactively.
- **The standalone create form** (`apps/web-app/app/components/category-form.tsx`,
  `NewCategoryForm`) is the precedent for inputs/validation/error mapping — read it, mirror its
  choices, but DON'T reuse its full page chrome here. Reuse the exported `ColorPicker` from the
  same file if you surface a color control. Color constants: `DEFAULT_COLOR_ID` (`"blue"`),
  `COLOR_PALETTE`, `colorLabel` from `@pocketcircle/domain`.
- **Client-side input mirror:** `categoryInputSchema` from `@pocketcircle/domain`
  (`{ name, type, color }`, name trimmed 1–`LIMITS.categoryNameMax`=40). The server
  re-validates and owns every invariant (ADR 0015) — this is courtesy only.
- **Server contract** (`packages/convex/convex/categories.ts`, `createCategory`): any Member
  may create (no owner check); `assertWritable` blocks an archived Circle; **uniqueness is per
  (Circle, type), case-insensitive, and spans archived names** (an archived "Gas" blocks a new
  "gas"). On collision it throws `Error("A category with this name already exists for this type")`.

## Implement

**Web only**, entirely inside `TransactionFormCategorySection` (thread `circleId` /
`circle.id` down from `transaction-form.tsx`, which already has `circle`).

- **Surface a "Create <name>" affordance in the combobox** keyed off the typed input text.
  When the user has typed a name (the combobox input/query value) that matches no **active**
  Category, offer "Create <name>". The natural home is the popup's empty/footer region
  (`ComboboxEmpty` shows "No matching categories." today) — render the create action there
  and/or as a trailing item so it's reachable both when the list is empty and when it has
  partial matches. base-ui `Combobox` does not expose typed text as a selectable item by
  default, so you must read the input value (controlled input value / `onValueChange` on the
  chips input) and render the create affordance yourself — don't try to inject a synthetic
  combobox item.
- **The empty-Category case must still let you create.** Today when there are zero active
  Categories of the type, the section renders a dead-end message
  ("No <type> categories yet. Create one first…") and `showPicker` is false, so the combobox
  isn't even shown. That blocks PRD 53. Change this so the combobox (and its create
  affordance) is reachable even with zero active Categories — typing a name and creating it is
  exactly how a Member unblocks recording the first Transaction.
- **Pre-check against the already-loaded set before mutating** (`categoryById` holds active +
  archived of `activeType`):
  - Exact (case-insensitive) match on an **active** Category → don't mutate; just select it.
  - Exact match on an **archived** Category → the name is reserved and the server would reject;
    don't mutate. Show the reserved-name state ("A category named '<name>' already exists but is
    archived") — an archived Category can't be added to a new Transaction, so there's no active
    one to offer here. (Restore lives in CAT-2 / the Categories list, out of scope.)
  - Otherwise → create.
- **Create:** validate with `categoryInputSchema.safeParse({ name, type: activeType, color })`,
  then `await createCategory({ circleId, name, type: activeType, color })`. Type is `activeType`
  — never a user choice in this inline flow (PRD 48; an inline Category can't be the wrong type).
  Color: default to `DEFAULT_COLOR_ID`; offering a `ColorPicker` to change it is nice-to-have,
  not required — keep the inline UI minimal.
- **Auto-select on success:** the mutation resolves to the new id; push it into the selection
  (`field.handleChange([...field.state.value, newId])`) and clear the typed input. The new row
  appears in `categoryById` via the parent's live query; until it does, the chip label falls
  back to the raw id (`categoryById.get(id)?.name ?? id`). To avoid a flash of the raw id (and
  to make the component test render the name without a reactive double — see How to test),
  hold a small local map of just-created `{ id → name/type/color/status:"active" }` and merge it
  into the lookup used for chip labels until the live query supersedes it.
- **Error path (server-side collision)** — a race can still reject after the pre-check passed
  (someone else created the name meanwhile). Catch it; map `/already exists/i` to the friendly
  copy (mirror `NewCategoryForm`); everything else → `mutationErrorMessageForUser(...)`. Surface
  it inline near the affordance, not as a form-level submit error.

## Why this way

- No new mutation — reuse `createCategory` so all CAT-1 invariants (uniqueness incl. archived,
  color, type, permissions, history) hold for free. Duplicating create logic in the UI would be
  the drift this architecture avoids.
- Type is pinned by `activeType`, not chosen, so an inline Category can never be created for the
  wrong type (PRD 48).
- The pre-check against the already-loaded active+archived set (the parent loads
  `includeArchived: true`) lets the UI distinguish "select the existing active one" from "the
  name is reserved by an archived one" without a round-trip, and keeps the common
  already-exists case from hitting the server at all.

## How to test

Web tests share `apps/web-app/app/test/convex-react.tsx`; the Transaction-form behavior suite
is `transaction-form.test.tsx` (mount the form directly, no route — it's the reusable unit).
The ONLY doubled thing is Convex's reactive client; real `~/lib/data.js` hooks, real TanStack
Form, real validation all run (ADR 0006/0020). Use `configureConvex({ categories, members,
createTransaction, createCategory })`, `makeCategoryView(...)`, and the `pickTransactionFormCategory`
picker helper. `createCategory` is a `vi.fn()` you own; have it resolve to an id via
`testId<Category["id"]>(...)`.

- **Harness note (don't get stuck):** the categories double is **static** — it does not
  reactively insert the row your `createCategory` spy "created". The local just-created merge
  (above) is what makes the new chip render its name in the test; assert on that, plus that the
  spy was called with `{ circleId, name, type: activeType, color }` and the id is now selected.
- **Component/integration:** inline-create adds a Category and auto-selects it; `type` sent
  equals the form's current type; switching the form type (edit's Type Change) before
  inline-create uses the new type. Inline-create works from the **zero active Categories** state
  (the previously dead-ended empty case).
- **Pre-check paths:** typing an existing **active** name selects it with NO `createCategory`
  call; typing an existing **archived** name shows the reserved-name message and does NOT call
  `createCategory` (no duplicate).
- **Error path:** a `createCategory` spy that rejects with the uniqueness error (e.g.
  `vi.fn().mockRejectedValue(new ConvexError("A category with this name already exists for this type"))`)
  surfaces the friendly inline message; no duplicate selected.
- **Permissions / read-only:** inline create against an archived Circle is blocked server-side
  (`assertWritable`); the create route already ejects an archived Circle, so cover the
  rejection-handling at the component level via a rejecting spy.
- **E2E** (`pnpm test:e2e:local`): add a Transaction, inline-create a Category, save —
  Transaction persists with the new Category attached.

## Done when

- A Member can create-and-select a Category without leaving the Transaction form (including from
  the zero-Categories state), type is pinned to the form's current type, an existing active name
  selects instead of duplicating, an archived name is surfaced as reserved, server collisions are
  handled inline, all reusing `createCategory`; tests green; gates pass.

## Out of scope

Any change to the `createCategory` mutation itself (CAT-1). Restoring an archived Category
(CAT-2 / Categories list). The dedicated `category-new.tsx` route and `transaction-new.tsx`
route (#96) — this slice only adds the inline affordance inside the shared form's Category
section.

