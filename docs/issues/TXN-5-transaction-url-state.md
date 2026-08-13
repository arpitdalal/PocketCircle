# TXN-5 · Transaction URL state + edit deep links

| | |
|---|---|
| **Status** | Done · [PR #67](https://github.com/arpitdalal/PocketCircle/pull/67) |
| **Labels** | `area:transactions`, `backend`, `ui`, `routing` |
| **Depends on** | TXN-2, RPT-1 |
| **Unlocks** | — |
| **PRD stories** | 27, 28, 29, 30, 38, 42, 44, 62, 64 |
| **ADRs** | 0016, 0017, 0020 |
| **Glossary** | Monthly Ledger, Transaction, Expense, Income, Archived Transaction |

## Intent

The Transactions page should survive reload and direct links without dropping the User back
to the default state. The URL owns the **Monthly Ledger** month and whether the User is adding
an Expense, adding Income, or editing a Transaction; unsaved form fields remain normal draft
state and are not encoded in the URL.

## Implement

- **Routing / URL state:**
  - The selected ledger month lives in `month=YYYY-MM`.
  - Bare `/circles/:circleRef/transactions` replaces to
    `/circles/:circleRef/transactions?month=<currentMonth>`.
  - Invalid `month` replaces to current month without snackbar.
  - Month changes push normal history entries.
  - Add forms deep link as
    `/circles/:circleRef/transactions?month=YYYY-MM&new=expense|income`.
  - Invalid `new` is dropped while preserving valid `month`.
  - Edit form deep links as
    `/circles/:circleRef/transactions/:transactionRef/edit?month=YYYY-MM`.
- **Convex/data:**
  - Add an edit-target query that fetches one Transaction by ID and returns `null` for missing,
    inaccessible, wrong-Circle, archived, or not-editable-by-viewer targets.
  - Return canonical `ref: buildRef(transaction.title, transaction.id)` in Transaction views
    used by ledger rows and edit-target resolution.
  - Do not resolve edit targets from the current ledger page; the Transaction may be off-page
    or outside the selected month.
- **Web:**
  - Add the edit route under the Circle layout.
  - Open Add Expense/Add Income from `new`, with default date based on the selected month.
  - Open Edit from the object route using the fetched Transaction, even if it is not visible in
    the selected month list.
  - Stale Transaction title slugs canonicalize with replace, preserving `month`.
  - Closing or successfully saving either form removes only the form state and preserves
    `month`.
  - Archived Circles stay on the read-only Transactions page; form state is dropped.

## Why this way

- **Month is ledger context, not Transaction identity.** Editing an April Transaction while
  viewing May should not jump the ledger to April; closing returns to May.
- **Create forms are UI state; edit forms are object state.** Add Expense/Add Income have no
  object yet, so query state is enough. Editing needs the canonical object route from ADR 0016.
- **Reload restores navigation, not drafts.** Draft persistence would be a separate feature
  with separate storage and conflict rules.
- **An edit link means editable active Transaction.** Owner moderation, archived Transaction
  views, and Transaction detail/history stay separate surfaces.

## How to test

- **Month URL:** bare route replaces to current month; invalid month replaces to current month;
  prev/next/month input updates the URL and reload preserves the month.
- **Create deep links:** `?new=expense` and `?new=income` open the correct fresh form; reload
  keeps it open; invalid `new` is dropped; close/save removes `new` and keeps `month`.
- **Edit deep links:** row Edit opens `/transactions/:transactionRef/edit?month=...`; reload
  opens the latest server values; stale slug canonicalizes; closing/saving returns to
  `/transactions?month=...`.
- **Off-month edit:** edit link opens even when the selected ledger month does not contain the
  Transaction; the ledger month does not auto-change.
- **Access/lifecycle:** missing, inaccessible, wrong-Circle, archived, and not-editable
  Transactions all show the unavailable-link path and fall back to the Circle Transactions
  route with `month` preserved; archived Circle shows the read-only state instead.
- **No draft persistence:** reloading a partially edited create/edit form restores only the
  route context and uses fresh defaults/server data.

## Done when

- Ledger month, add form, and edit form are URL-restorable; canonical object links preserve
  query state; invalid UI query state normalizes safely; edit targets are fetched directly and
  access-checked; focused route/data/component/E2E tests pass.

## Out of scope

Transaction detail/history (TXN-4); draft persistence; archive/restore actions; Search filter
URL state.
