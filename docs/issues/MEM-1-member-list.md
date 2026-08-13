# MEM-1 · Member List

| | |
|---|---|
| **Status** | Done · [PR #77](https://github.com/arpitdalal/PocketCircle/pull/77) |
| **Labels** | `area:membership`, `backend`, `ui` |
| **Depends on** | F0 |
| **Unlocks** | MEM-2, MEM-5, MEM-6, MEM-7 |
| **PRD stories** | — (Member List glossary; 43) |
| **ADRs** | 0015, 0016, 0018 |
| **Glossary** | Member List, Member, Owner, Removed Member |

## Intent

The Member List is the foundation for all collaboration slices: it reads the **materialized
member identity** (`members.displayName`/`image`) so it shows current names for active Members
and **frozen** names for Removed Members (PRD 43). All current Members can view it. This slice
is read-only — it's the surface the invite/remove/transfer slices then act on.

## Implement

- **Convex** new `packages/convex/convex/members.ts`:
  - `listMembers` query: args `{ circleId, includeRemoved? }`. `resolveCircleAccess` → `null`
    if no access → return active Members by default (Owner first), each as a `toMemberView`
    (member id, display name, image, role, status, joinedAt; **no userId leaked** to clients
    beyond what's needed). Optionally include removed (for history/search contexts).
- **Web:** `Member` view type via `FunctionReturnType`; `useMembers(circleId)` with MOCKS
  fork + fixtures. Member List UI: avatar (image or generated initials), display name, Owner
  badge. Used by Paid By selector (TXN-1), invite management, etc.

## Why this way

- Reads materialized identity, so removed Members render with their frozen name automatically
  — no join to live User rows, consistent with ADR 0018.
- Owner-first ordering gives the management surfaces a stable anchor.

## How to test

- **Access:** member ✓; non-member → `null`; unauthenticated → `null`.
- **Content:** active Members listed Owner-first with materialized display/image; a Removed
  Member shows frozen name when `includeRemoved`; default excludes removed.
- **Personal Circle:** exactly one Member.
- **Mock parity:** fixtures conform to `Member` view type.

## Done when

- Current Members can view the Member List with correct (frozen-for-removed) identity;
  selectors can consume it; tests green; gates pass.

## Out of scope

Inviting, removing, transferring (MEM-2/5/7).
</content>
