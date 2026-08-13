# USR-1 · Onboarding confirmation + PocketCircle owns the profile

| | |
|---|---|
| **Status** | Done · [PR #166](https://github.com/arpitdalal/PocketCircle/pull/166) |
| **Labels** | `area:users`, `backend`, `ui` |
| **Depends on** | F0 |
| **Unlocks** | richer EML/MEM identity (Welcome email + Member List use the owned name) |
| **PRD stories** | 1, 5 (extends both — adds onboarding confirmation + editable Display Name beyond literal v1, per ADR 0024) |
| **ADRs** | 0024 (new), 0018 (amended), 0002, 0015, 0017 |
| **Glossary** | Onboarding, Display Name, Profile Picture, Google Account Email, Personal Circle |

## Intent

Google is a **one-time identity seed**, not a permanent source of truth (ADR 0024). Today
`propagateUserProfile` re-mirrors the Google profile onto `users` and every active membership on
**every** `user.onUpdate` ([auth.ts](../../packages/convex/convex/auth.ts)), so the app can store a
name but Google wins every sync — a user edit would be clobbered on the next profile refresh. This
slice flips ownership: **seed once from Google, then the User owns their profile in PocketCircle.**

- **Onboarding** (glossary): a one-time, gated step after first sign-in. The User confirms and
  optionally edits their **Display Name**; their **Google Account Email** is shown **read-only**
  (it is identity/delivery-critical, not a vanity field). No other questions in v1.
- **Display Name** becomes app-owned and editable (Onboarding + App Settings). Google no longer
  overwrites it.
- **Profile Picture** is seeded once and frozen (uploads are a later feature — PRD non-goal "Editable
  Profile Picture in v1").
- **Google Account Email** is the **lone synced field** — kept current from Google, never
  user-editable.
- The **Personal Circle**'s name is seeded from the Google first name (`{firstName}'s Circle`) and
  **auto-tracks the confirmed or edited Display Name** until the owner manually renames it
  (`personalNameCustomizedAt` on the Circle row; absent ⇒ auto-tracking). After a manual rename,
  Onboarding and App Settings Display Name edits no longer change the Circle name. Identity-driven
  reconciles are a direct patch with no Circle History event. Its **Mark** always derives from the
  Circle's current name via `initials()` at every write that can change the name (bootstrap, identity
  reconcile, manual rename) — replacing the hardcoded `"P"`.
- The Personal Circle's switcher/home subtitle changes from `"Personal"` to **"Your Circle"** (regular
  Circles keep `"Circle"`).

> **Why history-free reconcile.** Identity-driven Personal Circle name updates (Onboarding confirmation and
> Settings Display Name edits, while auto-tracking is active) patch the Circle name/mark directly — they
> are not user-initiated Circle renames via `renameCircle`, so they do not record **Circle History**
> events. Manual renames set `personalNameCustomizedAt` and do record history.

> **Why a funnel, not a server boundary.** Onboarding completion is a UX funnel, not an authorization
> rule — the only thing behind it is the User's *own* solo data. So the gate is a client redirect (ADR
> 0017), not a `requireOnboarded` check bolted onto every mutation. ADR 0015 governs access to *shared*
> data; this isn't that. If a determined caller hits endpoints directly pre-onboarding, nothing breaks:
> the Personal Circle already exists.

## Implement

### Domain (`packages/domain/src`)

- `personalCircleName(displayName)`: pure helper → `` `${firstToken}'s Circle` `` where `firstToken`
  is the first whitespace-delimited token; falls back to `"Personal Circle"` when the name yields no
  token (empty / whitespace / emoji-only). Pure, shared, unit-tested with zero mocks.
- Reuse the existing `initials()` ([initials.ts](../../packages/domain/src/initials.ts)) for the Mark —
  do **not** reimplement.
- `profileUpdateSchema` (Zod): `{ displayName: <trimmed, min 1, max same bound as other name inputs> }`.

### Schema (`schema.ts`)

- `users`: add required `onboardingCompletedAt: v.union(v.number(), v.null())`. `null` = not yet
  onboarded; a number = done.
- `circles`: add optional `personalNameCustomizedAt: v.number()` — set on manual Personal Circle rename;
  absent ⇒ the name auto-tracks the owner's Display Name. Personal Circles only; no backfill needed.

### Backend model (`model.ts`)

- `createUserWithPersonalCircle`: set the new user's `onboardingCompletedAt: null`; name the Personal
  Circle via `personalCircleName(profile.displayName)` and set `mark: initials(name)` (drop the
  hardcoded `"P"`).
- Extract `setUserDisplayName(ctx, userId, name)`: patch `users.displayName` **and** refresh the
  Display Name on the User's **ACTIVE** memberships only — Removed Members stay frozen (ADR 0018). This
  is the in-app re-home of the propagation that used to fire from the auth trigger. (Image is untouched
  — it no longer syncs.)

### Auth trigger (`auth.ts`)

- Reduce `user.onUpdate` to **email-only**: patch `users.email` from `authUser.email` (keep the
  `normalizeId` guard). It no longer propagates `displayName`/`image`. Email is not part of materialized
  member identity, so this is a single-row patch with no membership fan-out.

### Convex functions (`users.ts`)

- `completeOnboarding` mutation `{ displayName: v.string() }`: `requireCurrentUser` → reject if already
  onboarded (`onboardingCompletedAt !== null`) → parse with `profileUpdateSchema` → if the name differs
  from current, `setUserDisplayName(...)` → **reconcile the Personal Circle** via
  `reconcilePersonalCircleFromDisplayName` (name only while `personalNameCustomizedAt` is absent; mark
  always from current name — no `recordEvent`) → set `onboardingCompletedAt: now`.
- `updateProfile` mutation `{ displayName: v.string() }`: post-onboarding edit. `requireCurrentUser` →
  parse → `setUserDisplayName(...)` → **reconcile the Personal Circle** the same way. Does **not** touch
  `onboardingCompletedAt`. After a manual rename (`renameCircle` sets `personalNameCustomizedAt`), later
  Display Name edits no longer change the Personal Circle name.
- Expose `onboardingComplete: user.onboardingCompletedAt !== null`, `displayName`, and `email` on the
  current-user view the protected layout already reads.

### View contract (`data.ts`)

- Derive the added fields via `FunctionReturnType` (ADR 0003) — never hand-write the shape. Add
  `useCompleteOnboarding()` and `useUpdateProfile()` hooks with the `MOCKS` fork; add/extend the
  current-user fixture in `fixtures.ts` so the gate and forms have a mock path (ADR 0006).

### Web (`apps/web-app/app`)

- **Onboarding form** — repurpose `routes/onboarding.tsx` from a *technical* splash into the *product*
  form: Display Name input (prefilled), read-only Google Account Email, single **Continue** →
  `completeOnboarding`. Rename the bootstrap-splash branch (authenticated-but-not-propagated) so the two
  "onboarding"s don't collide — the splash stays for the not-yet-bootstrapped state; this route is the
  ready-but-not-onboarded state.
- **Route gate** (`routes/layouts/circle-layout.tsx` / the protected layout): when the User is ready and
  `!onboardingComplete`, redirect to `/onboarding` — **except when already there** (no redirect loop;
  compare `useLocation().pathname`). Mirror the CS-5 setup-gate shape.
- **App Settings** (`routes/settings.tsx`, SET-1 surface): add an editable Display Name field bound to
  `updateProfile`, plus the Google Account Email shown read-only. (If SET-1 has not landed, add the field
  with the rest of the user-level settings.)
- **"Your Circle" label**: in `circle-switcher.tsx` and `home.tsx`, the Personal-Circle subtitle becomes
  `"Your Circle"`; regular Circles keep `"Circle"` (`circle.kind === "personal" ? "Your Circle" : "Circle"`).

## Why this way

- **Seed-once, app-owned (ADR 0024).** Mirroring Google forever clobbers user edits and forces identity
  changes through Google. Owning the profile in-app removes that round-trip; email stays synced because it
  is identity/delivery-critical.
- **Amends ADR 0018's trigger, not its contract.** Materialized member identity still refreshes active
  memberships and freezes Removed Members — it is now driven by `updateProfile`/`completeOnboarding`, not
  the auth `onUpdate`.
- **History-free reconcile.** Identity-driven Personal Circle renames patch directly — they are not
  user-initiated `renameCircle` actions, so they do not invent `renamed` history events.
- **Funnel over boundary** — see the Intent callout. No `requireOnboarded` on every mutation.
- **Security, forward.** Invitation acceptance must match the **live** Google session email
  (`authUser.email`), never a stored snapshot — MEM-3 honors this; this slice only stops syncing the other
  fields and documents the rule.

## How to test

- **Bootstrap:** a new User has `onboardingCompletedAt === null`; the Personal Circle is named
  `{firstName}'s Circle` with `mark === initials(name)`. Fallbacks: mononym → `Madonna's Circle`;
  empty/emoji-only Display Name → `"Personal Circle"` (mark `"PC"`). Domain unit tests cover
  `personalCircleName` + the `initials` reuse with zero mocks.
- **completeOnboarding:** sets `onboardingCompletedAt`; renames the Personal Circle to the confirmed name
  with a re-derived Mark and records **no** Circle History event (assert the Circle's history is empty);
  confirming the *same* name performs no rename write; a second call is rejected.
- **updateProfile (Settings):** changes `displayName`, propagates to **ACTIVE** memberships only
  (Removed Member's materialized name stays frozen — ADR 0018), and reconciles the Personal Circle
  name/mark while auto-tracking is active (`personalNameCustomizedAt` absent) with **no** Circle History
  event. After a manual rename, the Circle name/mark stay put but membership displayName still updates.
- **renameCircle (Personal):** sets `personalNameCustomizedAt`, regenerates mark from the new name,
  records a `renamed` history event (name only). Regular Circles: name only; mark and flag untouched.
- **Sync policy:** simulating a `user.onUpdate` patches `users.email` only — `displayName` and `image` are
  unchanged (a user edit survives a Google refresh).
- **Gate:** a not-onboarded User is redirected to `/onboarding` from every protected route; `/onboarding`
  does not redirect to itself; after completion, routes render normally. Funnel only — directly calling a
  mutation pre-onboarding is not blocked by an onboarding guard (the Personal Circle exists; nothing breaks).
- **Label:** the Personal-Circle row shows **"Your Circle"**; a regular Circle shows "Circle".
- **Mock parity:** the current-user fixture matches the derived view type (typecheck enforces); a
  render/route test asserts the gate redirects under `MOCKS`.

## Done when

- New Users land on the Onboarding form (confirm/edit name, read-only email) and cannot reach the app until
  they Continue; Display Name is app-owned and editable in Settings; Google no longer overwrites name/photo
  while email stays synced; the Personal Circle is seeded `{firstName}'s Circle` with an `initials()` Mark
  and auto-tracks Display Name edits until manually renamed; mark always derives from the current name;
  the Personal Circle subtitle reads "Your Circle"; ADR 0024 + the glossary terms are in place; tests
  green; gates pass.

## Out of scope

- Resync / opt-back-in toggle after a manual rename — see [USR-2](USR-2-resync-personal-circle-name.md).
- Editable Profile Picture / file uploads (later feature — PRD non-goal). Optional Onboarding questions
  (referral source, etc. — never-blocking, future). Invitation email matching against the live Google session
  email (the *rule* lives here; its *enforcement* is MEM-3). Account Deletion (separate USR-3 slice).
