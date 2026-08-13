# TXN-4 · Transaction detail: Audit Metadata + Transaction History

| | |
|---|---|
| **Status** | Done · [PR #75](https://github.com/arpitdalal/PocketCircle/pull/75) |
| **Labels** | `area:transactions`, `backend`, `ui`, `routing` |
| **Depends on** | TXN-1 (benefits from TXN-2, TXN-3 events) |
| **Unlocks** | — |
| **PRD stories** | 76, 77, 80 |
| **ADRs** | 0003, 0016, 0017, 0018, 0021 |
| **Glossary** | Audit Metadata, Transaction History |

## Intent

The Transaction detail surface — and the **first object route**, so it instantiates the
object-guard pattern that `categories/:categoryRef` will copy. It shows the Transaction plus
its **Audit Metadata** (created-by/at, updated-by/at — PRD 76) and its **Transaction History**
(created/edited/archived/restored events with acting Member, changed field names, old/new
values — PRD 77), and crucially **no raw internal IDs** (PRD 80).

Timestamps in Audit Metadata display with their stored offset, not converted to the viewer's
timezone (glossary: Audit Metadata).

## Implement

- **Convex** (`transactions.ts`):
  - `getTransaction` query: parse the raw ref id (like `getCircle` does with `normalizeId`)
    → `resolveCircleAccess` via the txn's Circle → `null` if inaccessible/missing → shape a
    detail view (fields + canonical `ref` + Recorded By/Paid By materialized display +
    audit metadata + capability flags `canEdit`/`canArchive`).
  - `listTransactionHistory` query: reuse `listEntityHistory(ctx, transactionEntity(id))`
    behind a Circle access check; `null` if no access.
- **Web — object route** `/circles/:circleRef/transactions/:transactionRef`:
  - Add the route under the Circle layout in `routes.ts`.
  - Write `useResolvedTransaction` adapter (the first object adapter) following the prose in
    `use-resolved-ref.ts`: read `transactionRef`, parse via `parseRef`+`normalizeId` seam,
    read the resolved Circle from Outlet context (`useCircle`), `useQuery(getTransaction,
    {skip when !parsed/MOCKS/!auth})`, feed `useResolvedRef` with a Circle-route fallback and
    a `canonicalPath` that builds `/circles/<circleRef>/transactions/<txnRef>`.
  - Detail UI: fields, Audit Metadata block, and the shared `HistoryList` (from CAT-2)
    rendering Transaction History. Derive view types via `FunctionReturnType`; add fixtures.

## Why this way

- **This is the reference object route.** Build the adapter as a thin shell over
  `useResolvedRef` exactly as documented — do not re-implement the parse/canonicalize/fallback
  dance. The next object route (`categories/:categoryRef`, if/when needed) copies this.
- **History values are frozen display-safe values** (already written by TXN-1/2/3 via
  `recordEvent`): text values are stored as strings, while money values store minor units plus
  Currency and render in the viewer locale (ADR 0021). The view never re-resolves raw entity
  IDs; no raw IDs appear because the writers never stored them (PRD 80).

## How to test

- **Object resolution (renderHook, mirror `use-resolved-ref.test.ts`):** pending while
  loading; stale slug → replace-navigate to canonical; unparseable ref → reported + snackbar
  + fallback to Circle route; inaccessible → snackbar + fallback (identical to unparseable to
  the user); resolved → ready.
- **Access:** `getTransaction` for a non-member → `null`; for a Transaction in another Circle
  → `null`; missing id → `null` (anti-enumeration).
- **History content:** events render newest-first with actor display name, field names, old/
  new values; money values render in viewer locale from typed minor-units + Currency values;
  **assert no raw `Id` strings** appear in rendered changes; archived/restored/type-change
  events present after performing those actions.
- **Audit Metadata:** created-by/at and updated-by/at correct; updated-by reflects the last
  editor; timestamps shown with stored offset (not viewer tz).
- **E2E:** open a Transaction, see history reflecting an edit and an archive.

## Done when

- Object route + `useResolvedTransaction` adapter live (reusing `useResolvedRef`); detail
  shows Audit Metadata + frozen, ID-free Transaction History; resolution/access/anti-
  enumeration tested; gates pass.

## Out of scope

Creating/editing/archiving (TXN-1/2/3) — this is the read/detail surface.
</content>
