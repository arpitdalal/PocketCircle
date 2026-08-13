# TXN-3 · Archive / Restore Transaction

| | |
|---|---|
| **Status** | Done · [PR #71](https://github.com/arpitdalal/PocketCircle/pull/71) |
| **Labels** | `area:transactions`, `backend`, `ui` |
| **Depends on** | TXN-1 |
| **Unlocks** | (RPT-* exclude archived from default totals/search; RPT-2 lifecycle filters) |
| **PRD stories** | 39, 40, 41, 46 |
| **ADRs** | 0015, 0016, 0018 |
| **Glossary** | Archived Transaction, Owner |

## Intent

Archiving is the moderation/void path that preserves history instead of deleting (PRD 46). An
**Archived Transaction is frozen and excluded from Dashboard totals** (PRD 40). Archived
Transactions are **visible by default in Ledger Filter and Transaction Search** but are visually
distinguished (muted title, "Archived" badge) so the full history is always present while active
and archived rows remain easy to tell apart; users can narrow to active-only or archived-only via
the lifecycle status filter (PRD 41). The permission shape is the
counterpart to TXN-2: **the Recorded By creator OR the Owner** can archive/restore — but the
Owner archiving someone's Transaction must NOT let them edit its fields (PRD 39). This is how
an Owner moderates without rewriting records.

## Implement

- **Convex** (`transactions.ts`):
  - `archiveTransaction` / `restoreTransaction`: load txn → `requireCircleAccess` →
    `assertWritable()` → permission: `txn.recordedByMemberId === access.membership._id ||
    access.isOwner` → flip `status`, set/clear `archivedAt` → `recordEvent`
    (`action:"archived"`/`"restored"`, actor = the moderator).
  - This composes over the `requireTransactionAccess` shape documented in `guard.ts` —
    consider extracting it now (TXN-2 and TXN-3 are the two adapters that make it a real seam).
- **Web:** archive/restore actions on Transaction detail and ledger rows, shown per
  server-provided capability. Archived rows render frozen (no edit affordances).

## Why this way

- **`canArchive = isRecorder || isOwner`** but **`canEditFields = isRecorder` only** — keep
  these as two distinct predicates so an Owner never gains field-edit through the archive
  path. This is exactly the `requireTransactionAccess` example in `guard.ts`; instantiate it.
- **Exclusion from totals is enforced in the reporting queries** (RPT-*), but archived state is
  set here; RPT Dashboard (RPT-3) must filter `status === "active"` so archived Transactions never
  affect totals. Ledger Filter and Transaction Search default to `status = "all"` and show archived
  rows with a visual distinction (muted title, "Archived" badge) rather than hiding them. Document
  the contract: archived ⇒ excluded from Dashboard totals; visible by default in lists with visual
  distinction; narrowable via lifecycle scope filter.

## How to test

- **Permissions:** Recorded By archives own ✓; Owner archives another's ✓; Owner restores
  another's ✓; non-owner non-creator Member ✗; Removed creator ✗; rejoined creator ✓.
- **Owner cannot edit fields via this path:** assert `updateTransaction` still rejects the
  Owner on a Transaction they archived.
- **Frozen:** editing an archived Transaction ✗ (already in TXN-2 — assert again here); a
  second archive of an already-archived txn is a no-op or rejected (decide + test).
- **Lifecycle:** archive/restore in an archived Circle ✗.
- **Reporting contract (set up assertions RPT consumes):** an archived Transaction is excluded
  from Dashboard totals; visible by default in Ledger Filter and Transaction Search (with visual
  distinction); excluded when lifecycle scope is `active`; included when `archived` or `all`.
- **History:** archive/restore events record the moderator as actor, correct action, no raw IDs.

## Done when

- Creator-or-Owner archive/restore enforced; Owner gains no field-edit; archived txns frozen,
  excluded from Dashboard totals, and visually distinguished in lists by default; events recorded;
  `requireTransactionAccess` extracted and reused;
  tests green; gates pass.

## Out of scope

The actual Dashboard/Search exclusion math and lifecycle filters (RPT-2, RPT-3) — this slice
sets state and defines the contract.
</content>
