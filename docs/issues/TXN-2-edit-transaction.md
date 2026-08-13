# TXN-2 · Edit Transaction + Type Change

| | |
|---|---|
| **Status** | Done · [PR #64](https://github.com/arpitdalal/PocketCircle/pull/64) |
| **Labels** | `area:transactions`, `backend`, `ui` |
| **Depends on** | TXN-1 |
| **Unlocks** | — |
| **PRD stories** | 29, 30, 38, 42, 44 |
| **ADRs** | 0015, 0016, 0018 |
| **Glossary** | Recorded By, Transaction Type Change, Removed Member |

## Intent

**Only the Recorded By Member can edit a Transaction's fields** (PRD 38) — not the Owner, not
other Members. This is the rule that lets people trust their records won't be rewritten. A
Removed Member loses edit rights; a rejoined User regains them (PRD 42, 44), which falls out
of resolving Recorded By against the *current* membership.

**Type Change** (Expense↔Income) is special (PRD 29, 30): it requires confirmation on a saved
Transaction, **clears existing Categories** (Expense and Income Categories must not mix), and
requires the caller to supply ≥1 active Category of the new type in the same operation.

## Implement

- **Convex** (`transactions.ts`):
  - `updateTransaction` mutation: args `{ transactionId, fields…, categoryIds? }`. Flow:
    load txn → `requireCircleAccess(ctx, txn.circleId)` → `assertWritable()` → **Recorded By
    check**: `txn.recordedByMemberId === access.membership._id` (so a Removed→rejoined User
    matches their stable member row) else throw → reject editing an **archived** Transaction
    (frozen — PRD 40) → validate changed fields (reuse domain schema) → if `paidByMemberId`
    changes, assert new value is a current Member → re-validate categories if provided →
    patch + `updatedAt` → rewrite `transactionCategories` if categories changed →
    `recordEvent` with per-field `from`/`to` (only changed fields).
  - `changeTransactionType` (or a `type` change inside `updateTransaction` with mandatory
    `categoryIds`): assert Recorded By; require `categoryIds` of the **new** type, ≥1, active,
    no dup; clear old `transactionCategories`, write new; set `type`; `recordEvent`
    (`action:"type changed"` with from/to type + categories cleared/added).
- **Web:** edit form reachable from Transaction detail, enabled only when the server marks the
  viewer as Recorded By. Segmented Expense/Income switch with a confirm dialog on a saved
  Transaction; on switch, clear the Category selection and require re-selecting from the new
  type's active Categories before save.

## Why this way

- **Recorded By is a member-id comparison**, not a user-id one, but because there's exactly
  one member row per (Circle, User) and it's reactivated on rejoin, comparing the txn's
  `recordedByMemberId` to the resolved `access.membership._id` naturally restores edit rights
  on rejoin (PRD 44). Don't special-case rejoin.
- **Type change clears categories in the same transaction** as setting the new ones, so the
  invariant "≥1 active category of the matching type" never breaks mid-operation.
- **Archived Transactions are frozen** — block edits here, don't rely on UI.

## How to test

- **Recorded By enforcement:** Recorded By edits ✓; Owner edits another's fields ✗
  (Owner may only archive/restore — TXN-3); other Member ✗; Removed Recorded By ✗; rejoined
  Recorded By ✓ (reactivate membership row, retry).
- **Type change:** requires new-type categories — supplying none ✗, old-type categories ✗,
  archived new-type category ✗, valid new-type ✓; old categories cleared; event records
  type from/to.
- **Field edges:** same value edits → no-op or no spurious history (decide and test);
  invalid amount/date/title rejected as in TXN-1; changing Paid By to a Removed Member ✗.
- **Lifecycle:** editing an archived Transaction ✗; editing in an archived Circle ✗.
- **History:** only changed fields recorded with correct from/to; no raw IDs; multiple field
  edits in one call produce one event with multiple changes.

## Done when

- Only Recorded By edits fields (rejoin-aware); type change confirms, clears, and re-requires
  categories; archived txns frozen; events precise; comprehensive tests green; gates pass.

## Out of scope

Archive/restore + Owner moderation (TXN-3); detail/history rendering (TXN-4).
</content>
