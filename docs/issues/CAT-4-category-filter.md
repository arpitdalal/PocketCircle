# CAT-4 · Category Filter: search + lifecycle status

| | |
|---|---|
| **Status** | Done · [PR #93](https://github.com/arpitdalal/PocketCircle/pull/93) |
| **Labels** | `area:categories`, `backend`, `ui` |
| **Depends on** | CAT-2, RPT-2 |
| **Unlocks** | Paginated/typeahead Category picker in the Transaction form |
| **PRD stories** | — (extends the Categories surface, PRD 47–61; no dedicated story) |
| **ADRs** | 0003, 0006, 0015, 0016 |
| **Glossary** | Category Filter, Archived Category |

## Intent

The Categories page narrows nothing: it lists a whole type's Categories at once behind a
binary "Show archived" toggle, fed by `listCategories` which `.collect()`s every Category of
the type. A Circle with many Members accrues 10s–100s of Categories, so this surface must
gain a **Category Filter** — a name search box and a tri-state lifecycle status (active /
archived / all) — and, per the project's "paginated from day one" rule (README §4), the
management list must paginate **at the source**, not collect-and-slice.

This mirrors the **Ledger Filter** shape (lightweight, in-place narrowing of one list), not
**Transaction Search** (a dedicated route). Default lifecycle scope is **all** — same as the
ledger — so a Member sees their active *and* archived Categories in one picture, archived
rows visually distinguished (the existing muted name + "Archived" badge), and can narrow to
active-only or archived-only. Filter state lives in the **URL**, so a filtered view is
shareable and reproducible (ADR 0016), not trapped in `useState`.

The Category Filter is a view over the type-scoped list; it changes *nothing* about which
Categories can be attached to Transactions (an Archived Category still can't be newly added —
CAT-2).

## Implement

- **Schema** (`schema.ts`): the paginated list sorts `createdAt desc` (preserving today's
  order), so the sort key must live in the index.
  - Add **`by_circle_type_status_createdAt`** `["circleId","type","status","createdAt"]` —
    serves `status=active|archived` (eq on status, paginate, `.order("desc")`).
  - **Replace `by_circle_and_type` with `by_circle_type_createdAt`**
    `["circleId","type","createdAt"]` — it supersedes the old index (same `circleId,type`
    prefix) and serves `status=all` (both statuses interleaved by `createdAt`). Repoint its
    three current callers (`listCategories`, `getTransactionSearchOptions`,
    `getLedgerFilterOptions`). Net **+1 index**.
- **Convex** (`categories.ts`): add a paginated query **`filterCategories`**, args
  `{ circleId, type: "expense"|"income", status: "active"|"archived"|"all", query?: string,
  paginationOpts }`:
  - `resolveCircleAccess` → `null` if no access (ADR 0016; same shape as `listCategories`).
  - Paginate the source index (status index when `active`/`archived`, the no-status
    `createdAt` index when `all`), then **filter the name substring in-handler**, collecting
    until the requested page is full or the source is exhausted — reuse the
    `collectTransactionViews` loop shape from `search.ts` (RPT-2's root pagination fix).
  - Name match is **substring, case-insensitive, whitespace-normalized** (reuse the
    `textIncludes` helper), **name only** — there is no second text path. Empty/whitespace
    `query` means no text narrowing.
  - Return `toCategoryView(...)` rows (capability flags + status), same view contract the
    page already renders.
  - **Leave `listCategories` as the collected query** — it still feeds the Transaction-form
    Category picker and the filter-option queries, which need the whole small selectable set.
- **View contract** (`data.ts`): add `useCategoriesPage(circleId, { type, status, query })`
  over `usePaginatedQuery`, returning `{ categories, status, loadMore }` (mirror
  `useLedgerTransactionFilter`), with the `MOCKS` fork + a `fixtures.ts` fixture. Derive the
  row type via `FunctionReturnType` (ADR 0003) — do not hand-write it.
- **URL state**: add `categories-filter-url.ts` (a small sibling of `transaction-filter-url.ts`,
  *not* an overload — the Categories `type` is binary `expense|income`, it has no `all`):
  - Params: `type` (default `expense`, always written), `status` (default `all`, always
    written), `q` (omitted when empty). Readers clamp unknown values to defaults.
- **Web** (`routes/circle/categories.tsx`): replace the `useState` `type`/`showArchived` with
  URL-driven filters. Render the type tab + a tri-state status `Segmented` + a debounced
  (~250ms) search `input[type=search]`, all inline (no draft/Apply panel — three controls fit
  in place). Discrete changes (type, status) write the URL with **push**; debounced search
  writes with **replace** (so typing a word doesn't bury history). The list paginates at the
  source (`filterCategories`, ~25 per page — mirroring `transaction-list.tsx`'s page size)
  with automatic **infinite scroll** (IntersectionObserver sentinel); the inline **History**
  panel still uses a manual **Load more** button. The new-Category form keeps using the URL
  `type`.

## Why this way

- **`filterCategories` is new, `listCategories` stays** — the management list and the form
  picker have opposite access patterns (paginated stream vs whole selectable set). One query
  with an "everything" escape hatch would defeat the pagination, and paginating a chip
  multi-select is bad UX. Same split RPT-2/RPT-1 made for Transactions.
- **Substring, in-memory, name-only** — matches Transaction text search and works at
  Categories' realistic volume; an indexed prefix scan would be cheaper but prefix-only
  ("ocer" wouldn't find "Groceries"), a worse search than the rest of the app.
- **Default `status=all`** — parity with the ledger's one-picture view; archived rows are
  distinguished, not hidden, so history is visible without toggling.
- **`createdAt`, not `_creationTime`** — `createdAt` is a domain field set explicitly at
  create (Circle Setup derives starter Categories with deliberate values), so it can diverge
  from Convex's `_creationTime`; the index must sort on `createdAt` to keep today's order.
- **URL, not `useState`** — filter/search state is shareable and reproducible (ADR 0016);
  push/replace split keeps a useful back-stack without history spam.
- **Reactivity falls out for free** — under `status=active`, archiving a row drops it from the
  live query; under `all`, the badge flips in place. This is the TXN-3 / issue #82 lesson
  already encoded in `LifecycleButton`; no special handling needed.

## How to test

- **Search:** substring match on name, case-insensitive, whitespace-normalized; empty/
  whitespace `q` returns the unfiltered (status-scoped) list; a term matching nothing returns
  an empty page (not an error); match spans active and archived rows under `status=all`.
- **Status:** `active` returns only active, `archived` only archived, `all` both; default
  (no `status` param) behaves as `all`.
- **Pagination (scalability):** seed past one page; assert the first page is bounded to the
  page size and `continueCursor` returns the next page; assert **filtered** pages are filled
  after in-handler narrowing — no empty intermediate page while further matches exist; both
  the status-index path and the all (`createdAt`-index) path paginate.
- **Sort:** rows come back `createdAt desc` with the `_creationTime` desc tiebreak, across
  page boundaries, identical to the pre-pagination order.
- **URL encoding:** canonical URL always carries `type` and `status`; `q` is omitted when
  empty and trimmed/normalized when present; unknown `type`/`status` values clamp to
  `expense`/`all`; type & status changes push, debounced search replaces.
- **Reactivity:** under `status=active`, archiving a visible row removes it from the live
  result; under `all`, the same row stays and its status flips; restore is symmetric.
- **Access / anti-enumeration:** non-member → `null`; inaccessible and missing Circle are
  indistinguishable; an archived Circle still lists (read-only, no create/edit/archive).
- **Picker untouched:** the Transaction-form Category picker still loads its full selectable
  set via `listCategories` (active + already-attached archived) after the index swap.
- **Mock parity:** the `filterCategories` fixture shape matches the derived view type;
  add a route/render test for the filter + infinite-scroll interaction under MOCKS.
- **Empty states:** distinguish "no Categories of this type yet" from "no Categories match
  this filter" (search/status narrowed everything out).
- **E2E:** type a search term and see the list narrow; switch status active/archived/all;
  reload the page and the filtered view reproduces from the URL; scrolling the infinite-scroll sentinel loads the next
  page; archive a row and watch it leave the active-filtered list.

## Done when

- The Categories page paginates `filterCategories` at the source with **infinite scroll** (sentinel + `IntersectionObserver`);
  name search (substring, name-only) and tri-state status narrow the list; filter state is
  URL-owned and reproducible; the index swap leaves the picker and option queries correct;
  `listCategories` remains the collected picker query; comprehensive unit, integration, and
  E2E tests are green; gates pass.

## Out of scope

Paginating / typeahead-ing the Transaction-form Category picker (`listCategories`'s own
collect-the-whole-type scale problem) — a separate slice. Any change to which Categories can
be attached to Transactions (CAT-2/CAT-3 own that). Category analytics filtering (RPT-5).
