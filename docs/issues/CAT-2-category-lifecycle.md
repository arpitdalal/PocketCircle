# CAT-2 · Edit / Archive / Restore Category + Category History

| | |
|---|---|
| **Status** | Done · [PR #88](https://github.com/arpitdalal/PocketCircle/pull/88) |
| **Labels** | `area:categories`, `backend`, `ui` |
| **Depends on** | CAT-1 |
| **Unlocks** | (analytics/search archived-category behavior leans on this) |
| **PRD stories** | 54, 55, 56, 57, 58, 78 |
| **ADRs** | 0015, 0016, 0018 |
| **Glossary** | Archived Category, Category History |

## Intent

Category permissions mirror Transaction permissions, and that asymmetry is the whole point
of this slice: **the creator controls field edits (name, color); the Owner controls
moderation (archive/restore) but may NOT rename or recolor someone else's Category** (PRD
55, 56). Archiving doesn't delete — an Archived Category stays attached to historical
Transactions and stays usable as a *filter*, but can't be newly added to Transactions, and
its name stays reserved (can't be reused until restored) so historical meaning isn't split
(PRD 54, 57). If the creator is a Removed Member they lose field-edit rights until rejoin
(PRD 44 applied to Categories).

This slice also lands the **Category History view** (PRD 78) — the read surface + UI panel
over the events that CAT-1/this slice record.

## Implement

- **Convex** (`categories.ts`):
  - `updateCategory` (name/color): `requireCircleAccess` → `assertWritable()` → load
    category, assert in this Circle → **creator check**: `category.creatorUserId ===
    access.user._id` else throw the generic permission error (Owner is NOT allowed here) →
    re-run uniqueness on rename (incl. archived, case-insensitive) → patch → `recordEvent`
    with `from`/`to` for each changed field.
  - `archiveCategory` / `restoreCategory`: `requireCircleAccess` → `assertWritable()` →
    **creator OR Owner** may moderate → flip `status`, set/clear `archivedAt` → on restore,
    re-check the name isn't now colliding with an active Category → `recordEvent`
    (`action:"archived"`/`"restored"`).
  - `listCategoryHistory` query: `resolveCircleAccess` (via the category's Circle) → reuse
    `listEntityHistory(ctx, categoryEntity(id))`; return `null` if no access.
- **Web:** add archive/restore + edit affordances on the categories route, gated by
  server-returned capability flags (don't compute permissions client-side as truth). A
  Category History panel (reuse a shared `HistoryList` component — build it here, TXN-4 and
  CS-4 reuse it) rendering action + actor + field changes, newest first.

## Why this way

- **Owner can moderate but not edit fields** — split into separate mutations so the
  permission predicate differs per mutation; do not add a single `mutateCategory` with a
  mode flag.
- **Restore re-checks collision:** while archived, another Member could have created an
  active Category with a different name; but a restore that would collide with a *now-active*
  same-name Category must fail (the archived name was reserved, but defensive re-check keeps
  the invariant airtight).
- History view reuses `listEntityHistory` — no new read path.

## How to test

- **Edit permissions:** creator edits name/color ✓; Owner (non-creator) edits name ✗,
  recolor ✗; non-creator Member ✗; Removed creator ✗; rejoined creator ✓ (reactivate
  membership, retry).
- **Moderation permissions:** creator archives/restores ✓; Owner archives/restores any ✓;
  non-creator non-owner Member ✗.
- **Uniqueness on rename:** rename into an existing active name (same type) ✗; into an
  archived name ✗; case-only rename collision ✗; rename to a free name ✓.
- **Restore collision:** archive "Gas", create active "Gas" again is already blocked by
  CAT-1; assert restoring the archived "Gas" while an active "Gas" exists ✗.
- **Lifecycle:** edit/archive against an archived Circle ✗; archived Category cannot be newly
  added to a Transaction (assert in TXN-1/TXN-2 too) but remains attached to existing ones.
- **History:** each edit/archive/restore records one event with correct actor + formatted
  from/to + no raw IDs; archived event has no `to` for the lifecycle field per convention;
  history list renders newest-first; inaccessible Circle → `null`.

## Done when

- Creator-only field edits and creator-or-Owner moderation enforced server-side; archived
  names stay reserved; restore re-checks collisions; Category History panel renders;
  comprehensive tests green; gates pass.

## Out of scope

Including archived Categories in analytics (RPT-5) and search (RPT-2) — those slices consume
this state.
</content>
