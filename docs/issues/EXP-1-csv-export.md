# EXP-1 · CSV Export

| | |
|---|---|
| **Status** | Shipped |
| **Labels** | `area:export`, `backend`, `ui` |
| **Depends on** | TXN-1, RPT-2 (shipped) |
| **PRD stories** | 87, 88 |
| **ADRs** | 0009, 0015, 0016, 0021 |
| **Glossary** | Export |

## Intent

Data portability: any current **Member** can export the current **Transaction Search** result set
as CSV (PRD 87). Export scope follows the Search lifecycle filter — default `status=all` exports
all Transactions (active and archived); `status=active` exports active only; `status=archived`
exports archived only (PRD 88). Only Transactions they can view (the Circle's), formatted for
human reading (amounts with explicit Currency, plain dates, Member display names, category
names) — never raw internal IDs.

## Current state (read before implementing)

RPT-2 shipped. Transaction Search now lives in:

- Backend query: `searchTransactions` in [`packages/convex/convex/search.ts`](../../packages/convex/convex/search.ts).
  It is **offset-paginated** (`page`, `pageSize`; `TRANSACTION_SEARCH_MAX_PAGE = 40`,
  `TRANSACTION_SEARCH_MAX_PUBLIC_PAGE_SIZE = 100`) — it is **not** a "give me everything" query.
  Export needs a new, non-paginated gather, so add a dedicated function rather than reusing it.
- Route: [`apps/web-app/app/routes/circle/search.tsx`](../../apps/web-app/app/routes/circle/search.tsx)
  at `/circles/:circleRef/search`.
- URL filter state: [`apps/web-app/app/lib/transaction-filter-url.ts`](../../apps/web-app/app/lib/transaction-filter-url.ts)
  (`SearchFilters`, `readSearchFilters`, `canonicalSearchParams`, `toMinorUnits`).
- Client hook + types: `useTransactionSearch`, `TransactionSearchFilters` in
  [`apps/web-app/app/lib/data/ledger.ts`](../../apps/web-app/app/lib/data/ledger.ts) (re-exported via `~/lib/data.js`).

Everything below names the **existing** helpers to reuse so the gather logic stays identical to
Search. Do not re-derive predicate semantics.

## Implement

### Backend — add `exportTransactions` query in a new `export.ts`

Put export in its own module (`packages/convex/convex/export.ts`, `api.export.exportTransactions`),
not in `search.ts`. Export is a distinct concern with its own output contract (ID-free CSV rows,
refusal caps, no pagination) that *reuses* Search's predicates — reuse is not a reason to share a
file, and it matches the `area:export` label + keeps the already-large `search.ts` focused on the
Search surface.

To do this, **export the shared predicate helpers from `search.ts`** (they are currently
module-private): `normalizeCommonFilters`, `resolveSearchWindow`, `validAmountBoundary`,
`streamByWindow`, `buildIndexedSearchSource`, `matchesFilters`, `newSearchCaches`, plus the
`commonFilterArgs` validator. These are genuinely shared search infrastructure; exporting them
encodes the predicate contract once so export and Search can't drift. (If this set later grows its
own identity, extract it to a `searchPredicates.ts` core that both import — not needed for v1.)
Note the `convex deploy` rule in CLAUDE.md: `export.ts` is a normal functions module, fine; only
`*.test.ts` / `packages/convex/test/` are excluded from deploy analysis.

- **Args** — reuse the existing `commonFilterArgs` spread plus the range args, mirroring
  `searchTransactions` minus the pagination args:
  `{ ...commonFilterArgs, dateFrom?, dateTo?, amountMin?, amountMax? }`.
  (`commonFilterArgs` = `{ circleId, query?, type, status, categoryIds?, recordedByMemberIds?,
  paidByMemberIds? }`. `type` ∈ `all|expense|income`, `status` ∈ `active|archived|all`.)
- **Access + validation** — copy `searchTransactions`'s prelude exactly:
  - `resolveCircleAccess(ctx, args.circleId)` → on `null` return a refusal/empty state (non-member,
    no leak). Archived Circle is still accessible (view-only).
  - `resolveSearchWindow(args)` for `dateFrom`/`dateTo` (invalid → throw `"Invalid search filters"`;
    reversed range → empty result, not error).
  - `validAmountBoundary(args.amountMin|amountMax)`; `amountMin > amountMax` → empty result.
  - `normalizeCommonFilters(ctx, args)` → returns `{ type, status, queryText, categoryIds,
    recordedByMemberIds, paidByMemberIds, hasOnlyUnknownIds }`. `hasOnlyUnknownIds === true` →
    empty result (stale deep-link ids).
- **Gather all matching rows (no offset paging).** Two paths, same split `searchTransactions` uses:
  - **No text query** (`!filters.queryText`): build the stream with the existing
    `streamByWindow(ctx, {...})`, chain `.filterWith((txn) => matchesFilters(ctx, txn, {...}, caches))`
    (same args object `searchTransactions` passes), then `.take(EXPORT_LIMIT + 1)`. If the result
    length `> EXPORT_LIMIT` → **refuse** (see cap). No `.paginate()` here — a Convex query allows a
    single `.paginate()` and export uses none, leaving headroom (see `convex-single-paginate-limit`
    memory / RPT-7).
  - **Text query** (`filters.queryText`): build with the existing `buildIndexedSearchSource(ctx, {...})`,
    then `.paginate({ numItems: TRANSACTION_SEARCH_INDEXED_RESULT_CEILING, cursor: null })`.
    Convex full-text search is hard-capped at `TRANSACTION_SEARCH_INDEXED_RESULT_CEILING = 1024`
    results — you **cannot** scan to 5000 with a text query. If `!result.isDone` (more than the
    ceiling matched) → **refuse**. Otherwise export all (≤1024) rows.
- **Cap** — `EXPORT_LIMIT = 5000` (add the constant; export-only, distinct from the Search
  pagination constants). On either refusal path, return a discriminated refusal state
  (e.g. `{ ok: false, reason: "tooMany", limit: EXPORT_LIMIT }`) — **never partial CSV**. On success
  return `{ ok: true, rows: ExportRow[], currency }`.
- **Row shape — ID-free, CSV-ready.** Do **not** return `toTransactionView` directly: it carries
  `id`, `ref`, and `recordedBy.id`/`paidBy.id`/`categories[].id`. Build a dedicated row from the
  `Doc<"transactions">` plus resolved names:
  - `date` — `txn.date` (plain `YYYY-MM-DD` string, unconverted).
  - `type` — `txn.type` (`expense`/`income`).
  - `title` — `txn.title`.
  - `note` — `txn.note ?? ""`.
  - `amount` — positive plain decimal via `formatMoneyAmount(money(txn.amountMinorUnits, currency))`
    from `@pocketcircle/domain` (currency-decimal aware, no symbol/grouping/locale — the ADR 0021
    export policy). Expense vs Income carries direction, not the sign.
  - `currency` — `access.circle.currency` (ISO 4217 code; Circle currency is single + locked in v1).
  - `categories` — joined category **names** (read `transactionCategories` via the existing
    `categoryLinksForTransaction` cache + resolve names; preserve archived attachments). Join with a
    stable separator the CSV layer can re-escape (e.g. `, ` inside the quoted cell).
  - `recordedBy` / `paidBy` — Member **display names** via the same `members`-row read
    `toTransactionView` uses (`member.displayName`, frozen-on-removal per ADR 0018; `"Unknown member"`
    fallback). No IDs.
  - `status` — `txn.status` (`active`/`archived`).
  - Resolve members/categories through a per-query cache (`newViewCaches()` from `transactions.ts`)
    to avoid N+1 across rows.

### Web — Export action on the Search page

- Add an **Export** button next to the existing **Filters** button in
  [`search.tsx`](../../apps/web-app/app/routes/circle/search.tsx) (the `flex gap-2` row).
- It exports the **current applied URL Search state** — read with `readSearchFilters(searchParams)`
  and convert with the page's existing `toSearchQuery(filters)` helper (same shape the export query
  args expect, minus `page`/`pageSize`). Default `/search?status=all&type=all` exports all Circle
  Transactions.
- Add an `exportTransactions` action hook in `apps/web-app/app/lib/data/ledger.ts` next to
  `useTransactionSearch` (honor the `MOCKS` branch like the other hooks). Prefer a lazy/imperative
  fetch (`useConvex().query(...)` on click) over a live `useQuery` — export is a one-shot user
  action, not subscribed page state.
- **Build the CSV client-side** from the returned rows. No CSV/download helper exists yet — add a
  small one (e.g. `apps/web-app/app/lib/csv.ts`): RFC-4180 escaping (wrap a field in `"` and double
  embedded `"` when it contains `,`, `"`, `\n`, or `\r`), `\r\n` line endings, header row first.
  Trigger download via a `Blob` (`type: "text/csv;charset=utf-8"`) + object URL + temporary `<a download>`;
  revoke the URL after. Filename e.g. `pocketcircle-<circleRef>-<YYYY-MM-DD>.csv`.
- On the refusal state, surface guidance to narrow the Search (toast/inline) — **do not** download a
  partial file.
- No Export button on the Monthly Ledger for v1.

## Why this way

- **Formatted, ID-free rows** so the CSV is meaningful to a human and leaks no internals
  (consistent with the history ID rule, ADR 0016).
- **Locale-independent money columns** — export uses `formatMoneyAmount` (positive plain decimal)
  plus an explicit ISO Currency column (ADR 0021), so spreadsheets calculate without parsing symbols
  and the file is unambiguous regardless of the viewer's locale. Expense/Income, not amount sign,
  determines direction. Server code must not call `formatMoney` (no viewer locale).
- **Search-scoped** — export answers "download what I searched for" instead of creating another
  filter surface. Reuses RPT-2's exact predicate helpers so scope can't drift from the visible list.
- **Bounded synchronous export** — v1 avoids background jobs; `EXPORT_LIMIT = 5000` (stream path) and
  the `1024` full-text ceiling (text path) keep a single read bounded. Refuse, never partial.
- **Member-scoped, view-only** — Export is a read; no mutation, no history event.

## How to test

Convex tests live next to the function (`export.test.ts`); reuse the same Circle/Transaction seed
builders `search.test.ts` uses so filter-parity assertions can't drift. Web tests share
`apps/web-app/app/test/convex-react.tsx`. Do not mock our own logic — exercise the real query.

- **Scope:** default Search (`status=all`) exports all Transactions and flags status in a column;
  `status=active` exports active only; `status=archived` exports archived only.
- **Filter parity:** title/note query, type, Category (OR), Recorded By (OR), Paid By (OR), date
  range (inclusive), amount range (inclusive, minor units), and lifecycle status match Transaction
  Search semantics — assert against the same fixtures `search.test.ts` uses.
- **Content/format:** positive amount decimals from minor units via `formatMoneyAmount`; Currency is
  the explicit ISO code; plain dates unconverted; Member names are display names (frozen for removed);
  categories joined; **no raw IDs** in any column.
- **Cap (stream path):** > 5,000 matching Transactions (no text query) refuses export with guidance
  to narrow Search; no partial CSV.
- **Cap (text path):** a text query matching more than the `1024` full-text ceiling refuses
  (`!isDone`); ≤ ceiling exports fully.
- **CSV safety:** titles/notes/category names containing commas, quotes, and newlines escape
  correctly (round-trip parse test on the `csv.ts` helper). Member-controlled fields that start with
  spreadsheet formula starters (`=`, `+`, `-`, `@`, including after leading whitespace) are
  neutralized in `escapeCsvField` before RFC-4180 escaping so Excel/Sheets open them as literal text.
- **Access:** non-member → refusal/empty (no leak); archived Circle exportable (view-only).
- **Empty:** a Circle with no matching Transactions exports headers only.
- **Stale ids:** unknown-only category/member id filters → empty result (mirrors `hasOnlyUnknownIds`).

## Done when

- A Member can export the current Transaction Search result set to correctly-escaped, ID-free CSV
  with explicit Currency and lifecycle status; both cap paths refuse cleanly; tests green; gates pass.

## Shipped implementation

- Backend: `api.export.exportTransactions` in `packages/convex/convex/export.ts` (`EXPORT_LIMIT = 5000`;
  reuses exported predicate helpers from `search.ts`).
- Web: Export button on Transaction Search (`search.tsx`), `useExportTransactions` in `ledger.ts`,
  RFC-4180 + formula-injection-safe CSV helpers in `apps/web-app/app/lib/csv.ts`.
- Tests: `export.test.ts`, `csv.test.ts`, Search route export coverage in `search.test.tsx`.

## Out of scope

Importing (out of scope for v1); exporting histories (out of scope for v1); exporting from the
Monthly Ledger; background/async export jobs; chunked or multi-request export beyond the caps.
