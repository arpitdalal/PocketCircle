# CS-0 · Create Circle UI + switcher

| | |
|---|---|
| **Status** | Done · [PR #78](https://github.com/arpitdalal/PocketCircle/pull/78) |
| **Labels** | `area:circles`, `ui` |
| **Depends on** | F0 |
| **Unlocks** | CS-1, CS-2, CS-4 |
| **PRD stories** | 6, 10, 11, 24 |
| **ADRs** | 0003, 0016, 0017 |
| **Glossary** | Circle, Circle Color, Circle Mark, Personal Circle |

## Intent

The backend `createCircle` mutation already exists (F0). This slice is the **UI** to create a
regular Circle and to move between Circles — the navigation backbone every collaboration and
reporting slice needs a real Circle to exercise. Circle names may duplicate (PRD 10); the
Circle Mark + Circle Color distinguish them (PRD 11). There is **no Circle discovery** (PRD
24) — the switcher lists only the User's own Circles (`listMyCircles`).

## Implement

- **Web only** (mutation + `listMyCircles` exist):
  - A Circle switcher (in the app shell / protected layout) listing `useMyCircles()` with
    Circle Mark + name + color, Personal Circle first, linking to each Circle's canonical ref.
  - A "Create Circle" flow: name (required), Currency (default from locale via
    `defaultCurrencyForLocale`, USD fallback; chosen from `SUPPORTED_CURRENCIES`), Color
    (palette, default chosen), Mark auto-derived from initials. Calls `api.circles.createCircle`,
    then navigates to the new Circle's canonical ref (`buildRef`). Offer to start Circle
    Setup (CS-1) afterward.
  - Render the Circle Mark from initials + Color (shared `CircleMark` component) — reused by
    switcher, header, lists.

## Why this way

- Names duplicate by design → never block on name collision; rely on Mark+Color+ref for
  identity (refs are id-authoritative per ADR 0016).
- Currency default is **locale-derived with USD fallback** via the existing domain helper —
  don't hardcode USD in the UI.
- Navigate to `buildRef(name, id)` so the URL is canonical from creation (no stale-slug
  redirect on first load).

## How to test

- **Component/integration:** create flow submits valid input → mutation called with parsed
  values → navigates to canonical ref; duplicate name allowed; Mark derives from initials.
- **Switcher:** lists only the User's active Circles, Personal first; selecting navigates to
  the canonical ref.
- **Mock parity:** switcher + create render in mock mode using fixtures.
- **E2E:** create a regular Circle from the shell and land on it.

## Done when

- A User can create a regular Circle (locale currency default, palette color, derived mark)
  and switch between their Circles; no discovery of others' Circles; tests green; gates pass.

## Out of scope

Circle Setup / starter Categories (CS-1); editing color/mark after creation (CS-2).
</content>
