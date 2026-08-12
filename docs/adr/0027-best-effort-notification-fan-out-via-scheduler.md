# Best-effort notification fan-out decoupled from business mutations via the Convex scheduler

PocketCircle's in-app notifications (NTF-2) were written synchronously inside the originating business mutation — `notifyCircleLifecycleChange` loops every active Member and `await`s an insert each, inside the same `archiveCircle` / `restoreCircle` transaction that already did its own writes. We decouple every notification write from its originating mutation by scheduling it with `ctx.scheduler.runAfter(0, …)`, fanning out **one scheduled delivery mutation per recipient** so a single failed insert cannot abort the business mutation or starve the rest of the batch. Notifications are explicitly **best-effort**: we rely on Convex's built-in OCC/transient mutation retry and add no application-error retry, backoff, or dead-letter. We rejected a notification Workpool (the email precedent) and a single batched scheduled mutation.

## Context

`notifyUser` and its wrappers (`notify.ts`) are the sole writers of the `notifications` table. They were called inline from the business mutations in `circles.ts`, `members.ts`, `transactions.ts`, `categories.ts`, and `invitations.ts`. Two distinct problems followed from running them on the originating transaction:

1. **Shared write budget + serial latency.** `notifyCircleLifecycleChange` (`circles.ts` archive/restore) queries all active Members and `await`s an insert per Member — inside the archive transaction that already patched the Circle, revoked invitations, and recorded a history event. A Circle's notification fan-out therefore doubles its mutation write-set and serializes N round-trips on the user-facing critical path. There is **no member cap** in the schema, so N is unbounded in principle and can approach Convex's per-mutation document limits.

2. **Correctness coupling.** If any notify insert throws, the entire archive transaction rolls back. A secondary concern (notifications) could abort a primary state change. That is the wrong failure mode — the archive should commit whether or not its notifications do.

Two facts shaped the fix:

- **Notifications are local DB inserts into our own `notifications` table — not external IO.** This is the crucial difference from email. The email path uses `@convex-dev/workpool` (`emailPool`, ADR 0008) because Resend is flaky external IO that needs bounded concurrency, retry-with-backoff, and idempotent dedup against a vendor. None of that rationale transfers to an insert into a table we own.
- **The realistic failure modes of a local insert are largely auto-handled.** OCC write conflicts and transient internal errors are **automatically retried by Convex for all mutations**, scheduled ones included. The remaining failure modes — schema/validation bugs, per-mutation document limits — are deterministic; retry cannot fix them, and a batch-splitting design avoids the limit.

`ctx.scheduler` was previously unused in this codebase; the only async-after-commit precedent was the email Workpool.

## Decision

**Decouple every notification write from its originating mutation with `ctx.scheduler.runAfter(0, …)`, and fan out per recipient.**

- Each `notify*` wrapper becomes a thin enqueue at the call site. The actual `notifications` insert moves into an internal mutation seam (`internal.notify.*`) that the scheduler runs in its own transaction **after** the originating mutation commits. Convex only schedules the job if the originating mutation commits, so an aborted business mutation fires no notifications — and a failed notification can no longer roll back the business mutation.

- **Fan-out is two-stage and per-recipient.** The business mutation schedules one small coordinator job (e.g. `internal.notify.fanOutCircleLifecycle` with `{ circleId, actorUserId, actorDisplayName, action }`). That coordinator queries Members and schedules **one `deliverOne` job per recipient** — it inserts nothing itself, so its only failure surface is the Member query (OCC auto-retried). `deliverOne` performs a single insert. One recipient's failure is isolated to that one row; it cannot starve the batch, and there is no N-insert ceiling in any single transaction.

- **The actor-skip rule is centralized and evaluated at enqueue time.** `recipient === actor → no row` is enforced by a single `isActorSkip` helper used by both `scheduleDeliverOne` and the `deliverOne` backstop. The check runs before scheduling, so common self-actions (archiving your own Category) never schedule a no-op `deliverOne` job. Circle archive/restore fan-out is also gated at enqueue time: when the actor is the only active Member, `notifyCircleLifecycleChange` skips scheduling the coordinator entirely — no no-op coordinator job runs.

- **Notifications are best-effort. No application-error retry, backoff, or dead-letter in v1.** We rely solely on Convex's built-in OCC/transient mutation retry. In-app activity notifications are explicitly not email (PRD 86) and carry no delivery guarantee; gold-plating a local insert with vendor-grade durability machinery is unwarranted.

## Considered options

- **Single batched scheduled mutation (one job does all N inserts).** Decouples from the originating transaction (fixes both problems) but keeps the fan-out all-or-nothing: one insert failing rolls back the whole batch, and N inserts in one transaction still face the per-mutation document limit. Per-recipient scheduling removes both for free. Rejected.

- **Notification Workpool (mirror `emailPool`).** Follows the email precedent literally and would add real application-error retry, backoff, and an `onComplete` hook. Rejected: its rationale is vendor-oriented (bounded concurrency, backoff, idempotent dedup against an external API) and does not transfer to inserts into our own DB; it consumes the free-plan Workpool parallelism ceiling (20 shared across all pools — `emailPool` already claims 5) for a far higher-frequency event than email; and it is machinery without a payoff for best-effort local writes. It remains the documented upgrade path if notifications are ever promoted to guaranteed delivery.

- **Hybrid: schedule only the fan-out, leave single-insert notifies inline.** Smallest diff, targets the acute case. Rejected: leaves the correctness coupling half-fixed and the mechanism inconsistent across notify paths, against the "fix from the root / one reusable abstraction" bar.

- **Status quo (inline on the originating transaction).** The defect. Rejected.

## Consequences

- The archive/restore (and all other) business mutations no longer carry the notification write-set or its latency, and can no longer be rolled back by a notification failure. Correctness of the primary state change is independent of notification delivery.

- A single recipient's failed insert no longer aborts the fan-out, and no single transaction holds an unbounded number of notification inserts — the per-mutation document limit is not a fan-out ceiling.

- **Delivery is best-effort.** A notification lost to a non-retryable error is gone; there is no dead-letter or alert. Acceptable for in-app activity notifications. The escape hatch is documented: swap `runAfter` for a notification Workpool (one job per recipient) to gain retry-with-backoff and `onComplete` dead-lettering, if product upgrades notifications to guaranteed delivery.

- **Enqueue-time gating adds one indexed Member read on circle lifecycle notifies.** `notifyCircleLifecycleChange` queries active Members before scheduling the coordinator so a solo Circle never pays for a no-op fan-out job. This is a read-only check on the enqueue path — it does not reintroduce the N-insert write-set coupling ADR 0027 removed from the business mutation.

- **Tests must flush scheduled functions.** Assertions that previously read the `notifications` table synchronously after `t.mutation(...)` now run `vi.useFakeTimers()` + `t.finishAllScheduledFunctions(vi.runAllTimers)` first — the established pattern already used for the email Workpool in `invitations.test.ts`.

- Display strings (e.g. the actor's name) are resolved when the coordinator runs rather than at the instant the business mutation committed. With `runAfter(0)` the staleness window is effectively zero and the values are not security-sensitive.
