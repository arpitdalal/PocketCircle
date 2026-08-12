# CS-2 · Circle Settings: Color, Mark, Setup answers

| | |
|---|---|
| **Status** | Done |
| **Labels** | `area:circles`, `backend`, `ui` |
| **Depends on** | CS-0 |
| **PRD stories** | 11 |
| **ADRs** | 0015, 0018 |
| **Glossary** | Circle Color, Circle Mark, Circle Settings |

## Intent

**Circle Settings are Owner-controlled** (glossary). The Owner can change Circle Color
(which re-tints the Circle Mark) and re-edit Setup answers. Members cannot change
settings, but Members can still create non-colliding Categories (that's CAT-1, unaffected).
Renaming the Circle already exists (F0 `renameCircle`); this slice covers Color and
Setup answers, all audited into Circle History (CS-4).

### Circle Mark — do NOT write it

`circles.mark` is a **stored initials string** (max 2 chars), derived from the name at
creation only. Its color is **not stored** — `CircleMark` ([circle-mark.tsx](../../apps/web-app/app/components/circle-mark.tsx))
re-tints at render via `colorHex(circle.color)`. So changing `color` updates the Mark's tint
automatically: **this slice patches `color`, never `mark`.** (Re-deriving the Mark glyph on
rename is an F0 concern and is out of scope here — `renameCircle` does not currently touch the
Mark either.)

## Implement

- **Domain** (`packages/domain/src/validation.ts`): add a `circleSettingsUpdateSchema`
  parallel to the existing `categoryUpdateSchema` (CAT-2) — optional fields, each validated by
  the same rule as on create so the entry points can't drift:
  `{ color?: <the existing `colorId` refine>, setupAnswers?: circleSetupAnswersSchema (from `@pocketcircle/domain`) }`.
  Absent field ≡ "leave unchanged".
- **Convex** (`circles.ts`):
  - `updateCircleSettings` mutation: args `{ circleId: v.id("circles"), color: v.optional(v.string()), setupAnswers: v.optional(circleSetupAnswers) }`
    (reuse the module-local `circleSetupAnswers` validator already defined at the top of the file).
    Flow: `requireCircleAccess` → Owner-only (`if (!access.isOwner) throw`) → `access.assertWritable()`
    → parse args with `circleSettingsUpdateSchema` → diff against `access.circle`:
    - **color**: if present and `!== access.circle.color`, add a change `{ field: "color", from: colorLabel(access.circle.color), to: colorLabel(next) }` (palette labels via `colorLabel`, never raw ids — ADR 0018) and include in the patch.
    - **setupAnswers**: if present, reuse the existing module-private `setupAnswerChanges(access.circle.setupAnswers, answers)` helper for the per-field `setup.purpose` / `setup.residenceType` changes, and include `setupAnswers` in the patch.
    - **No-op:** if nothing changed, return early without patching or recording (mirror `renameCircle`).
    - Patch only the changed fields, then emit **one** `recordEvent` (not one per field) with
      `action: "settings_changed"`, `actor: access.membership`, `entity: circleEntity(access.circle._id)`, and the accumulated `changes[]`.
  - Changing setup answers does **not** touch existing Categories (starter derivation is CS-1, one-time).
- **History labels** (`apps/web-app/app/components/history-list.tsx`): add the labels these new
  events need so the shared renderer doesn't fall back to raw keys —
  `ACTION_LABEL["settings_changed"]` (e.g. `"updated settings"`) and
  `FIELD_LABEL["setup.purpose"]` / `FIELD_LABEL["setup.residenceType"]` (`color`/`name` already
  present). The values themselves are already human-formatted (`colorLabel`; the answer
  literals). The CS-4 Circle History *view* consumes these; the label maps live in the shared
  component, so add them here.
- **Web:** a new **Circle-scoped** Owner-only settings route — `circles/:circleRef/settings`
  → `routes/circle/settings.tsx`, added under the `:circleRef` children in
  [routes.ts](../../apps/web-app/app/routes.ts). **Distinct from the existing top-level
  `routes/settings.tsx`**, which is the user-level App Settings (SET-1) — do not conflate them.
  Surface: name (via existing `renameCircle`), a color picker (the `COLOR_PALETTE`), and the
  Setup answers, each bound to its mutation. Reach it from the circle layout/switcher. Hide for
  non-owners (courtesy) by checking the viewer's role — `listMembers` already returns each
  member's `role` and flags `isSelf`, so `members.find((m) => m.isSelf)?.role === "owner"`; the
  server enforces regardless.

## Why this way

- Keep settings mutations Owner-gated server-side; the Member-can-still-create-Categories rule
  is preserved because category creation is a separate function with Member permission.
- Color is a cue, not identity — collisions allowed; never block on a duplicate color.
- One event with a `changes[]` array (not one event per field) matches `createCircle` /
  `renameCircle` / `completeCircleSetup`; the history viewer renders multiple change rows under
  a single event header.

## How to test

- **Permissions:** Owner edits color/answers ✓; non-owner Member ✗; Removed Member ✗; archived
  Circle ✗ (each enforced server-side, not just hidden in the UI).
- **Validation:** invalid color id ✗ (rejected by `circleSettingsUpdateSchema`); valid ✓.
  Mark tint reflects the new Circle Color (asserted via the rendered `colorHex(color)`, since
  the Mark is never re-written).
- **No-op:** calling with the same color / same answers records **no** history event and patches
  nothing.
- **Invariant:** editing setup answers leaves existing Categories untouched (assert counts/ids
  unchanged).
- **History:** color change records `{ field: "color", from, to }` as palette labels (no raw
  ids); answer changes record `setup.purpose` / `setup.residenceType` from/to; all under a single
  `settings_changed` event. The shared renderer shows a human label for the action and each field.

## Done when

- Owner can change Color and Setup answers (Members cannot); the Mark re-tints from the new
  Color with no `mark` write; Categories preserved across answer edits; changes audited as one
  `settings_changed` event with labeled fields; tests green; gates pass.

## Out of scope

Rename (F0), re-deriving the Mark glyph on rename (F0), starter derivation (CS-1), Circle
History *view* (CS-4 — this slice only writes the events and adds their labels).
</content>
