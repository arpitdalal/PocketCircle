# USR-2 · Resync Personal Circle name with your Display Name (Settings auto-sync toggle)

| | |
|---|---|
| **Status** | Done · [PR #175](https://github.com/arpitdalal/PocketCircle/pull/175) |
| **Labels** | `area:users`, `backend`, `ui` |
| **Depends on** | USR-1 (Personal Circle name customization flag + `reconcilePersonalCircleFromDisplayName`) |
| **Extends** | USR-1, ADR 0024 |
| **Glossary** | Personal Circle, Display Name, Mark |

## Intent

After USR-1, a Personal Circle's name auto-tracks the owner's Display Name until the owner
manually renames it (`personalNameCustomizedAt` absent ⇒ auto-tracking). This slice adds the
**opt-back-in** path: a Circle Settings toggle that turns auto-sync back on (immediately
re-deriving name + Mark from the current Display Name) or off (freezing the current name without
renaming). The toggle reads reactive `nameCustomized` state so a manual rename flips it off with
no extra client wiring.

## Implement

- **Backend** (`circles.ts`):
  - `toCircleView`: expose `nameCustomized: circle.personalNameCustomizedAt !== undefined` (always
    `false` for regular circles).
  - `setPersonalCircleNameAutoSync({ enabled })`: owner-scoped via `getPersonalCircleForOwner`;
    `enabled: true` clears the flag then calls `reconcilePersonalCircleFromDisplayName`; `enabled:
    false` sets `personalNameCustomizedAt` without changing the name. No Circle History event.
- **Data layer**: `useSetPersonalCircleNameAutoSync` hook; thread `nameCustomized` through the
  derived `Circle` type and mock fixtures.
- **UI** (`circle/settings.tsx`): Personal Circle only — toggle bound to `!nameCustomized`, label
  **Match my display name**, description explaining auto-sync and that manual rename turns it off.
  No optimistic local toggle state.

## How to test

- **Convex:** `setPersonalCircleNameAutoSync({ enabled: true })` on a customized circle clears the
  flag and re-derives name + mark; `{ enabled: false }` on an auto-tracking circle sets the flag
  without renaming; no Personal Circle no-ops; `nameCustomized` derived correctly in `getCircle`.
- **Web:** toggle ON/OFF for auto vs customized personal circles; toggling ON calls mutation with
  `enabled: true`; customized view shows OFF; absent on regular circles.

## Done when

- Client view exposes `nameCustomized`; mutation both directions; Settings toggle (Personal only);
  Convex + web tests green; ADR 0024, CONTEXT, and USR-1 cross-links updated.

## Out of scope

- Regular-circle name/mark behavior; changes to USR-1 gate/mark invariants.
