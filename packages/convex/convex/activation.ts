import { buildRef } from "@pocketcircle/domain";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { mutation, query } from "./_generated/server.js";
import { requireCurrentUser } from "./auth.js";
import { getPersonalCircleForOwner } from "./model.js";

const ACTIVATION_ITEM_IDS = [
  "personalTransaction",
  "personalCategory",
  "regularCircle",
  "sharedMember",
] as const;

const ACTIVATION_TOTAL = ACTIVATION_ITEM_IDS.length;

const MILESTONE_FIELDS = [
  "personalTransactionCreatedAt",
  "personalCategoryCreatedAt",
  "regularCircleCreatedAt",
  "sharedMemberJoinedAt",
] as const;

type ActivationMilestoneField = (typeof MILESTONE_FIELDS)[number];

type SharedMemberState = "not_started" | "pending" | "complete";

type MemberCta =
  | { kind: "members"; circleRef: string }
  | { kind: "setup"; circleRef: string }
  | { kind: "create" };

type ActivationRow = Doc<"userActivation">;

async function listActivationRows(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  return await ctx.db
    .query("userActivation")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
}

function earliestTimestamp(left: number | undefined, right: number | undefined) {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return Math.min(left, right);
}

function mergedActivationFields(rows: ActivationRow[]) {
  let personalTransactionCreatedAt: number | undefined;
  let personalCategoryCreatedAt: number | undefined;
  let regularCircleCreatedAt: number | undefined;
  let sharedMemberJoinedAt: number | undefined;
  let dismissedAt: number | undefined;
  let completionEventDeliveredAt: number | undefined;
  let initializedAt = Number.POSITIVE_INFINITY;

  for (const row of rows) {
    initializedAt = Math.min(initializedAt, row.initializedAt);
    personalTransactionCreatedAt = earliestTimestamp(
      personalTransactionCreatedAt,
      row.personalTransactionCreatedAt,
    );
    personalCategoryCreatedAt = earliestTimestamp(
      personalCategoryCreatedAt,
      row.personalCategoryCreatedAt,
    );
    regularCircleCreatedAt = earliestTimestamp(regularCircleCreatedAt, row.regularCircleCreatedAt);
    sharedMemberJoinedAt = earliestTimestamp(sharedMemberJoinedAt, row.sharedMemberJoinedAt);
    dismissedAt = earliestTimestamp(dismissedAt, row.dismissedAt);
    completionEventDeliveredAt = earliestTimestamp(
      completionEventDeliveredAt,
      row.completionEventDeliveredAt,
    );
  }

  return {
    initializedAt: Number.isFinite(initializedAt) ? initializedAt : Date.now(),
    ...(personalTransactionCreatedAt === undefined ? {} : { personalTransactionCreatedAt }),
    ...(personalCategoryCreatedAt === undefined ? {} : { personalCategoryCreatedAt }),
    ...(regularCircleCreatedAt === undefined ? {} : { regularCircleCreatedAt }),
    ...(sharedMemberJoinedAt === undefined ? {} : { sharedMemberJoinedAt }),
    ...(dismissedAt === undefined ? {} : { dismissedAt }),
    ...(completionEventDeliveredAt === undefined ? {} : { completionEventDeliveredAt }),
  };
}

function pickKeeper(rows: ActivationRow[]) {
  let keeper = rows[0];
  if (!keeper) {
    return undefined;
  }
  for (const row of rows.slice(1)) {
    if (
      row.initializedAt < keeper.initializedAt ||
      (row.initializedAt === keeper.initializedAt && row._id < keeper._id)
    ) {
      keeper = row;
    }
  }
  return keeper;
}

/**
 * Enforces one row per User: keep the earliest, merge timestamps (never clear a
 * set field), delete extras. Safe to call from any mutation.
 */
async function collapseActivationRows(ctx: MutationCtx, rows: ActivationRow[]) {
  if (rows.length <= 1) {
    return rows[0] ?? null;
  }

  const keeper = pickKeeper(rows);
  if (!keeper) {
    return null;
  }

  const merged = mergedActivationFields(rows);
  const extras = rows.filter((row) => row._id !== keeper._id);
  for (const extra of extras) {
    await ctx.db.delete(extra._id);
  }

  await ctx.db.patch(keeper._id, merged);
  const updated = await ctx.db.get(keeper._id);
  return updated;
}

async function getUniqueActivationRow(ctx: MutationCtx, userId: Id<"users">) {
  return await collapseActivationRows(ctx, await listActivationRows(ctx, userId));
}

function readActivationRow(rows: ActivationRow[]) {
  if (rows.length === 0) {
    return null;
  }
  if (rows.length === 1) {
    return rows[0] ?? null;
  }
  const keeper = pickKeeper(rows);
  if (!keeper) {
    return null;
  }
  return { ...keeper, ...mergedActivationFields(rows) };
}

async function insertActivationRow(ctx: MutationCtx, userId: Id<"users">, initializedAt: number) {
  await ctx.db.insert("userActivation", { userId, initializedAt });
  return await getUniqueActivationRow(ctx, userId);
}

async function applyEvidenceToRow(ctx: MutationCtx, row: ActivationRow, userId: Id<"users">) {
  const evidence = await collectActivationEvidence(ctx, userId, row.initializedAt);
  const patch: Partial<ActivationRow> = {};
  for (const field of MILESTONE_FIELDS) {
    const next = evidence[field];
    if (row[field] === undefined && next !== undefined) {
      patch[field] = next;
    }
  }
  if (Object.keys(patch).length === 0) {
    return row;
  }
  await ctx.db.patch(row._id, patch);
  const updated = await ctx.db.get(row._id);
  return updated ?? row;
}

/**
 * Creates the row if missing (backfilling evidence when this is the first write
 * for an existing User), then returns the unique row. New Users already have a
 * bootstrap row, so this is a read + collapse.
 */
async function ensureActivationRow(ctx: MutationCtx, userId: Id<"users">, now = Date.now()) {
  const existing = await getUniqueActivationRow(ctx, userId);
  if (existing) {
    return existing;
  }
  const created = await insertActivationRow(ctx, userId, now);
  if (!created) {
    throw new Error("Activation row missing after insert");
  }
  return await applyEvidenceToRow(ctx, created, userId);
}

/** Idempotent: sets a milestone timestamp only when absent. */
export async function markActivationMilestone(
  ctx: MutationCtx,
  userId: Id<"users">,
  field: ActivationMilestoneField,
  at = Date.now(),
) {
  const row = await ensureActivationRow(ctx, userId, at);
  if (row[field] !== undefined) {
    return;
  }
  await ctx.db.patch(row._id, { [field]: at });
}

async function earliestPersonalCategoryCreatedAt(
  ctx: QueryCtx | MutationCtx,
  personalCircleId: Id<"circles">,
) {
  const categories = await ctx.db
    .query("categories")
    .withIndex("by_circle", (q) => q.eq("circleId", personalCircleId))
    .collect();
  let earliest: number | undefined;
  for (const category of categories) {
    earliest = earliestTimestamp(earliest, category.createdAt);
  }
  return earliest;
}

async function earliestPersonalTransactionCreatedAt(
  ctx: QueryCtx | MutationCtx,
  personalCircle: Doc<"circles">,
  fallback: number,
) {
  const transaction = await ctx.db
    .query("transactions")
    .withIndex("by_circle", (q) => q.eq("circleId", personalCircle._id))
    .first();
  if (transaction) {
    return transaction.createdAt;
  }
  if (personalCircle.currencyLocked) {
    return fallback;
  }
  return undefined;
}

/**
 * Durable "created a regular Circle" evidence: Circle History `created` whose
 * actor is this User's Member row. Current `ownerUserId` is mutable under
 * transferOwnership and must not credit the new Owner (ADR 0030).
 */
async function earliestCreatedRegularCircleAt(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  const memberships = await ctx.db
    .query("members")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  let earliest: number | undefined;
  for (const membership of memberships) {
    const circle = await ctx.db.get(membership.circleId);
    if (circle?.kind !== "regular") {
      continue;
    }
    const events = await ctx.db
      .query("histories")
      .withIndex("by_entity", (q) => q.eq("entityId", circle._id))
      .collect();
    const createdByThisUser = events.some(
      (event) => event.action === "created" && event.actorMemberId === membership._id,
    );
    if (createdByThisUser) {
      earliest = earliestTimestamp(earliest, circle.createdAt);
    }
  }
  return earliest;
}

/**
 * Durable Member-milestone evidence: an Invitation this User sent that was
 * accepted. Current co-membership under owned Circles is not evidence — those
 * Members may have accepted a previous Owner's Invitation after transfer.
 */
async function sharedMemberEvidenceAt(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  const accepted = await ctx.db
    .query("invitations")
    .withIndex("by_inviter_status_createdAt", (q) =>
      q.eq("invitedByUserId", userId).eq("status", "accepted"),
    )
    .collect();
  let earliest: number | undefined;
  for (const invitation of accepted) {
    earliest = earliestTimestamp(earliest, invitation.createdAt);
  }
  return earliest;
}

async function collectActivationEvidence(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  initializedAt: number,
) {
  const personalCircle = await getPersonalCircleForOwner(ctx, userId);
  const evidence: Partial<Record<ActivationMilestoneField, number>> = {};

  if (personalCircle) {
    const categoryAt = await earliestPersonalCategoryCreatedAt(ctx, personalCircle._id);
    if (categoryAt !== undefined) {
      evidence.personalCategoryCreatedAt = categoryAt;
    }
    const transactionAt = await earliestPersonalTransactionCreatedAt(
      ctx,
      personalCircle,
      initializedAt,
    );
    if (transactionAt !== undefined) {
      evidence.personalTransactionCreatedAt = transactionAt;
    }
  }

  const regularAt = await earliestCreatedRegularCircleAt(ctx, userId);
  if (regularAt !== undefined) {
    evidence.regularCircleCreatedAt = regularAt;
  }

  const memberAt = await sharedMemberEvidenceAt(ctx, userId);
  if (memberAt !== undefined) {
    evidence.sharedMemberJoinedAt = memberAt;
  }

  return evidence;
}

async function hasUnexpiredPendingInvitation(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  const pending = await ctx.db
    .query("invitations")
    .withIndex("by_inviter_status_expiresAt", (q) =>
      q.eq("invitedByUserId", userId).eq("status", "pending").gt("expiresAt", Date.now()),
    )
    .first();
  return pending !== null;
}

function circleRefOf(circle: Doc<"circles">) {
  return buildRef(circle.name, circle._id);
}

async function resolveMemberCta(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  const activeRegular = await ctx.db
    .query("circles")
    .withIndex("by_owner_kind_status_createdAt", (q) =>
      q.eq("ownerUserId", userId).eq("kind", "regular").eq("status", "active"),
    )
    .collect();

  const setupComplete = activeRegular.find((circle) => circle.setupCompletedAt !== null);
  if (setupComplete) {
    return { kind: "members" as const, circleRef: circleRefOf(setupComplete) };
  }
  const incomplete = activeRegular[0];
  if (incomplete) {
    return { kind: "setup" as const, circleRef: circleRefOf(incomplete) };
  }
  return { kind: "create" as const };
}

function completedCountOf(row: ActivationRow) {
  let count = 0;
  for (const field of MILESTONE_FIELDS) {
    if (row[field] !== undefined) {
      count += 1;
    }
  }
  return count;
}

function firstIncompleteOf(row: ActivationRow) {
  if (row.personalTransactionCreatedAt === undefined) {
    return "personalTransaction";
  }
  if (row.personalCategoryCreatedAt === undefined) {
    return "personalCategory";
  }
  if (row.regularCircleCreatedAt === undefined) {
    return "regularCircle";
  }
  if (row.sharedMemberJoinedAt === undefined) {
    return "sharedMember";
  }
  return null;
}

function toActivationChecklistView(
  row: ActivationRow,
  pendingInvitation: boolean,
  memberCta: MemberCta,
) {
  const completedCount = completedCountOf(row);
  const allComplete = completedCount === ACTIVATION_TOTAL;
  const dismissed = row.dismissedAt !== undefined;
  const sharedMemberState: SharedMemberState =
    row.sharedMemberJoinedAt !== undefined
      ? "complete"
      : pendingInvitation
        ? "pending"
        : "not_started";

  return {
    status: "ready" as const,
    visible: !dismissed && !allComplete,
    dismissed,
    allComplete,
    completedCount,
    total: ACTIVATION_TOTAL,
    personalTransactionComplete: row.personalTransactionCreatedAt !== undefined,
    personalCategoryComplete: row.personalCategoryCreatedAt !== undefined,
    regularCircleComplete: row.regularCircleCreatedAt !== undefined,
    sharedMemberState,
    firstIncomplete: firstIncompleteOf(row),
    memberCta,
    completionEventPending: allComplete && row.completionEventDeliveredAt === undefined,
  };
}

/**
 * Existing-User compatibility path: create the row if missing and merge durable
 * evidence into empty milestone fields only. Idempotent; never overwrites
 * progress or dismissal. New Users already have a bootstrap row and do not need
 * this for correctness, but calling it is a no-op merge.
 */
async function initializeActivationFromEvidence(ctx: MutationCtx, userId: Id<"users">) {
  const now = Date.now();
  const existing = await getUniqueActivationRow(ctx, userId);
  if (existing) {
    return await applyEvidenceToRow(ctx, existing, userId);
  }
  const created = await insertActivationRow(ctx, userId, now);
  if (!created) {
    throw new Error("Activation row missing after insert");
  }
  return await applyEvidenceToRow(ctx, created, userId);
}

/** UI-ready Activation Checklist for the signed-in User. `uninitialized` when no row. */
export const getActivationChecklist = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireCurrentUser(ctx);
    const rows = await listActivationRows(ctx, user._id);
    const row = readActivationRow(rows);
    if (!row) {
      return { status: "uninitialized" as const };
    }
    const pendingInvitation = await hasUnexpiredPendingInvitation(ctx, user._id);
    const memberCta = await resolveMemberCta(ctx, user._id);
    return toActivationChecklistView(row, pendingInvitation, memberCta);
  },
});

/** Idempotent per-User evidence backfill. Existing Users call this once from the dashboard. */
export const initializeActivationChecklist = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireCurrentUser(ctx);
    await initializeActivationFromEvidence(ctx, user._id);
  },
});

/**
 * Persists Skip onboarding. Does not mark milestones. Repeated calls keep the
 * original dismissedAt. Returns the completed-item count at skip time (0–3 while
 * the card is shown; 4 if already complete).
 */
export const skipActivationChecklist = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireCurrentUser(ctx);
    const row = await ensureActivationRow(ctx, user._id);
    const completedCount = completedCountOf(row);
    if (row.dismissedAt === undefined) {
      await ctx.db.patch(row._id, { dismissedAt: Date.now() });
    }
    return { completedCount };
  },
});

/**
 * Claims the one-shot completion analytics delivery. Returns `{ claimed: true }`
 * only for the caller that persisted the marker. Does not set milestone timestamps.
 */
export const acknowledgeActivationCompleted = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireCurrentUser(ctx);
    const row = await getUniqueActivationRow(ctx, user._id);
    if (!row || completedCountOf(row) !== ACTIVATION_TOTAL) {
      return { claimed: false };
    }
    if (row.completionEventDeliveredAt !== undefined) {
      return { claimed: false };
    }
    await ctx.db.patch(row._id, { completionEventDeliveredAt: Date.now() });
    return { claimed: true };
  },
});
