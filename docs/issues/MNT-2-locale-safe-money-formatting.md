# MNT-2 · Locale-safe money formatting

| | |
|---|---|
| **Status** | Done · [PR #73](https://github.com/arpitdalal/PocketCircle/pull/73) |
| **Labels** | `area:platform`, `backend`, `ui`, `testing` |
| **Depends on** | TXN-1, TXN-2, RPT-1, RPT-3 |
| **Unlocks** | TXN-4, RPT-2, RPT-4, RPT-5, EXP-1 |
| **PRD stories** | — |
| **ADRs** | 0009, 0018, 0021 |
| **Glossary** | Amount, Currency, Transaction History, Monthly Ledger, Dashboard, Export |

## Intent

Fix already-shipped money formatting paths so PocketCircle never relies on the runtime's ambient locale. Local tests currently fail on non-US-English terminals because `Intl.NumberFormat` falls back to the process locale; the deeper issue is that UI display, immutable history, and export need separate money presentation policies.

## Implement

- **Domain:** keep integer minor-unit math; add explicit money presentation helpers so app code cannot accidentally format with omitted locale. Viewer-facing helpers receive a locale; export uses positive decimal amount plus ISO Currency.
- **Convex history:** migrate Transaction create/edit history amount changes from preformatted strings to typed money values `{ minorUnits, currency }`. Transactions themselves stay normalized as `amountMinorUnits` plus Circle Currency.
- **Web:** Monthly Ledger and Dashboard money display use viewer locale (`navigator.language`, explicit `en-US` fallback for non-browser render/test contexts) plus Circle Currency. No route should call a money formatter that can fall back to ambient Node locale.
- **Tests:** reproduce with `LANG=en_CA.UTF-8`; assert USD renders disambiguated for an Australian/Canadian-style viewer locale where applicable, and that server/history tests do not depend on terminal locale.

## Why this way

- **History freezes meaning, not presentation.** `10000 USD` is immutable; `$100.00` vs `US$100.00` is viewer presentation.
- **Done slices stay done.** This issue owns modifying the behavior already shipped by TXN-1, TXN-2, RPT-1, and RPT-3 instead of rewriting their historical slice docs.
- **Export is a file format, not UI.** Positive decimal `amount` plus separate `currency` is unambiguous and spreadsheet-friendly.

## How to test

- **Locale regression:** under `LANG=en_CA.UTF-8`, full Vitest suite passes without pinning test process locale.
- **Viewer UI:** Ledger and Dashboard format money with explicit viewer locale + Circle Currency.
- **History:** create/edit amount events store typed money values with Currency and no raw IDs; rendering formats those typed values in viewer locale.
- **Export contract:** exported rows contain positive decimal `amount` and ISO `currency`, never locale-specific symbols.

## Done when

- All money formatting call sites use an explicit presentation policy; shipped history rows for new amount changes are typed; local non-US-English test runs match CI; tests green.

## Out of scope

Backfilling old history rows; mixed-currency Circles; user-selectable locale preferences.
