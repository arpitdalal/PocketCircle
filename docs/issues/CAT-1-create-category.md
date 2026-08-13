# CAT-1 · Create Category

| | |
|---|---|
| **Status** | Done · [PR #23](https://github.com/arpitdalal/PocketCircle/pull/23) |
| **Labels** | `area:categories`, `backend`, `ui` |
| **Depends on** | F0 (foundation) |
| **Unlocks** | TXN-1, CAT-2, CAT-3, CS-1 |
| **PRD stories** | 47, 48, 49, 59, 60, 61 |
| **ADRs** | 0003, 0010, 0015, 0016, 0018 |
| **Glossary** | Category, Category Color |

## Intent

A Category is a **type-specific** label living in exactly one Circle, used to classify
Transactions. This slice is the root of the whole Transaction tree — TXN-1 can't ship until
a Member can create the Categories a Transaction requires (≥1). Get the invariants right
here once and every downstream slice inherits them.

The hard, easy-to-get-wrong rule: **names are unique per (Circle, type), case-insensitively,
and that uniqueness includes archived names** (PRD 49, 54). "Gas" the Expense category and
"gas" the Expense category are the same; "Gas" Expense and "Gas" Income are different. We
store a `nameLower` column precisely so this check is an index lookup, not a scan. Colors are
required but are a *cue, not identity* — collisions are allowed (PRD 60), and there are no
icons (PRD 61).

Any current Member (not just the Owner) may create Categories, including in a Personal Circle
and including a Member whose Categories will outlive their membership.

## Implement

- **Domain** (`packages/domain/src/validation.ts`): `categoryInputSchema` already exists —
  confirm it validates name (trimmed, non-empty, max length per `LIMITS`), `type` ∈
  `TRANSACTION_TYPES`, and `color` ∈ palette (`isValidColorId`). Extend if a constraint is
  missing; add tests in `validation`-adjacent domain test.
- **Convex** new `packages/convex/convex/categories.ts`:
  - `createCategory` mutation: args `{ circleId, name, type, color }`. Flow:
    `requireCircleAccess` → `assertWritable()` → parse with `categoryInputSchema` →
    compute `nameLower` → uniqueness check via `by_circle_type_name`
    (`circleId`+`type`+`nameLower`) against **all** statuses → insert with
    `creatorUserId: access.user._id`, `status: "active"` → `recordEvent(categoryEntity(id),
    actor: access.membership, action: "created", changes: [{field:"name", to:name},
    {field:"color", to:<color label>}, {field:"type", to:type}])`.
  - `listCategories` query: args `{ circleId, type?, includeArchived? }`. `resolveCircleAccess`
    → return `null` if no access (anti-enumeration) → else categories for the type, active
    by default. Shape a `toCategoryView` (id, name, type, color, status, creatorMemberRef…)
    and **derive the view type** from this query in `data.ts`.
- **Web** (`apps/web-app/app/lib/data.ts`): `Category` type via `FunctionReturnType<typeof
  api.categories.listCategories>` element; `useCategories(circleId, type)` hook with MOCKS
  fork + fixtures. UI: a "New Category" affordance on the categories route
  (`routes/circle/categories.tsx`) — name field, type segmented control, color picker from
  the palette. Show inline the unique-name error from the server.

## Why this way

- **Uniqueness includes archived names** so historical meaning isn't split across two
  identically-labeled Categories (PRD 54). Don't filter the uniqueness query by status.
- **Case-insensitive** ⇒ compare on `nameLower`, never on `name`. Store both.
- The `by_circle_type_name` index exists for exactly this lookup; use it rather than
  collecting + filtering.
- Record the create event now (ADR 0018) even though Category History view is CAT-2 —
  CAT-2's view needs this data to exist.

## How to test

On top of the global bar (§5 of the index):

- **Happy:** create Expense + Income categories; both persist with correct `nameLower`,
  status `active`, creator set; create event recorded with formatted color label, no raw IDs.
- **Uniqueness edges:** duplicate exact name same type → rejected; case-only difference
  (`Gas`/`gas`) same type → rejected; same name different type → allowed; same name where an
  **archived** category already holds it → rejected (depends on CAT-2 to archive; add this
  test when CAT-2 lands or seed an archived row directly via `t.run`).
- **Input edges:** empty/whitespace name → rejected; name over `LIMITS` max → rejected;
  invalid `type` → rejected; invalid/missing color → rejected.
- **Permissions:** Owner ✓, non-owner Member ✓ (Members may create), Removed Member ✗,
  non-member ✗, unauthenticated ✗; against an archived Circle ✗ (`assertWritable`).
- **Anti-enumeration:** `listCategories` on an inaccessible Circle returns `null`, same as
  missing.
- **Mock parity:** `useCategories` fixtures conform to the derived `Category` type.

## Done when

- A Member can create type-specific Categories with required color; duplicate/case/archived
  collisions are blocked server-side; create events recorded; categories list renders in
  mock mode and live; all test classes above green; gates pass.

## Out of scope

Edit/archive/restore (CAT-2), inline-in-form create (CAT-3), starter Categories (CS-1).
</content>
