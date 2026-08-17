import { buildRef } from "@pocketcircle/domain";
import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
  internalMutation,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from "./_generated/server.js";
import { asyncMapChunked, DEFAULT_READ_CONCURRENCY } from "./asyncBatch.js";
import { requireCurrentUser } from "./auth.js";
import { getPersonalCircleForOwner } from "./model.js";

// Generic Activation item IDs (GH-273 rename from Personal-specific language).
const ACTIVATION_ITEM_IDS = ["transaction", "category", "regularCircle", "sharedMember"] as const;
const ACTIVATION_TOTAL = ACTIVATION_ITEM_IDS.length;

const ITEM_MILESTONE_FIELD = {
  transaction: "transactionCreatedAt",
  category: "categoryCreatedAt",
  regularCircle: "regularCircleCreatedAt",
  sharedMember: "sharedMemberJoinedAt",
} as const;

type ActivationMilestoneField = (typeof ITEM_MILESTONE_FIELD)[keyof typeof ITEM_MILESTONE_FIELD];

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

/**
 * Normalizes a row: merges legacy Personal-specific fields into generic fields
 * using earliest-timestamp-wins. Returns the patch needed to normalize. Legacy
 * fields are cleared. Preserves dismissal/completion markers. Does NOT infer
 * old regular activity — only merges timestamps that are present.
 */
function normalizationPatch(row: ActivationRow) {
  const patch: Record<string, number | undefined> = {};

  // transactionCreatedAt = earliest of (generic, legacy personalTransactionCreatedAt)
  const mergedTxn = earliestTimestamp(row.transactionCreatedAt, row.personalTransactionCreatedAt);
  if (mergedTxn !== undefined && mergedTxn !== row.transactionCreatedAt) {
    patch.transactionCreatedAt = mergedTxn;
  }

  // categoryCreatedAt = earliest of (generic, legacy personalCategoryCreatedAt)
  const mergedCat = earliestTimestamp(row.categoryCreatedAt, row.personalCategoryCreatedAt);
  if (mergedCat !== undefined && mergedCat !== row.categoryCreatedAt) {
    patch.categoryCreatedAt = mergedCat;
  }

  // Clear legacy fields if they are set
  if (row.personalTransactionCreatedAt !== undefined) {
    patch.personalTransactionCreatedAt = undefined;
  }
  if (row.personalCategoryCreatedAt !== undefined) {
    patch.personalCategoryCreatedAt = undefined;
  }

  return patch;
}

/**
 * Returns a view of an activation row with legacy fields merged into generic.
 * Used for reads (query path) where we don't persist the normalization.
 */
function normalizedView(row: ActivationRow) {
  const txnAt = earliestTimestamp(row.transactionCreatedAt, row.personalTransactionCreatedAt);
  const catAt = earliestTimestamp(row.categoryCreatedAt, row.personalCategoryCreatedAt);
  const cleared: { personalTransactionCreatedAt: undefined; personalCategoryCreatedAt: undefined } =
    {
      personalTransactionCreatedAt: undefined,
      personalCategoryCreatedAt: undefined,
    };
  return {
    ...row,
    transactionCreatedAt: txnAt,
    categoryCreatedAt: catAt,
    ...cleared,
  };
}

function mergedActivationFields(rows: ActivationRow[]) {
  let transactionCreatedAt: number | undefined;
  let categoryCreatedAt: number | undefined;
  let regularCircleCreatedAt: number | undefined;
  let sharedMemberJoinedAt: number | undefined;
  let dismissedAt: number | undefined;
  let completionEventDeliveredAt: number | undefined;
  let evidenceBackfilledAt: number | undefined;
  let initializedAt = Number.POSITIVE_INFINITY;

  for (const row of rows) {
    initializedAt = Math.min(initializedAt, row.initializedAt);
    // Merge generic + legacy for each row
    transactionCreatedAt = earliestTimestamp(
      transactionCreatedAt,
      earliestTimestamp(row.transactionCreatedAt, row.personalTransactionCreatedAt),
    );
    categoryCreatedAt = earliestTimestamp(
      categoryCreatedAt,
      earliestTimestamp(row.categoryCreatedAt, row.personalCategoryCreatedAt),
    );
    regularCircleCreatedAt = earliestTimestamp(regularCircleCreatedAt, row.regularCircleCreatedAt);
    sharedMemberJoinedAt = earliestTimestamp(sharedMemberJoinedAt, row.sharedMemberJoinedAt);
    dismissedAt = earliestTimestamp(dismissedAt, row.dismissedAt);
    completionEventDeliveredAt = earliestTimestamp(
      completionEventDeliveredAt,
      row.completionEventDeliveredAt,
    );
    evidenceBackfilledAt = earliestTimestamp(evidenceBackfilledAt, row.evidenceBackfilledAt);
  }

  return {
    initializedAt: Number.isFinite(initializedAt) ? initializedAt : Date.now(),
    ...(transactionCreatedAt === undefined ? {} : { transactionCreatedAt }),
    ...(categoryCreatedAt === undefined ? {} : { categoryCreatedAt }),
    ...(regularCircleCreatedAt === undefined ? {} : { regularCircleCreatedAt }),
    ...(sharedMemberJoinedAt === undefined ? {} : { sharedMemberJoinedAt }),
    ...(dismissedAt === undefined ? {} : { dismissedAt }),
    ...(completionEventDeliveredAt === undefined ? {} : { completionEventDeliveredAt }),
    ...(evidenceBackfilledAt === undefined ? {} : { evidenceBackfilledAt }),
    // Always clear legacy fields in merged output
    personalTransactionCreatedAt: undefined,
    personalCategoryCreatedAt: undefined,
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
 * set field), delete extras. Normalizes legacy fields. Safe to call from any mutation.
 */
async function collapseActivationRows(ctx: MutationCtx, rows: ActivationRow[]) {
  if (rows.length <= 1) {
    const single = rows[0] ?? null;
    if (single) {
      // Normalize legacy fields on the single row
      const patch = normalizationPatch(single);
      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(single._id, patch);
        const updated = await ctx.db.get(single._id);
        return updated;
      }
    }
    return single;
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
    const row = rows[0] ?? null;
    if (!row) {
      return null;
    }
    // Return normalized view (merge legacy into generic without persisting)
    return normalizedView(row);
  }
  const keeper = pickKeeper(rows);
  if (!keeper) {
    return null;
  }
  const merged = { ...keeper, ...mergedActivationFields(rows) };
  return merged;
}

async function insertActivationRow(ctx: MutationCtx, userId: Id<"users">, initializedAt: number) {
  await ctx.db.insert("userActivation", { userId, initializedAt });
  return await getUniqueActivationRow(ctx, userId);
}

async function applyEvidenceToRow(ctx: MutationCtx, row: ActivationRow, userId: Id<"users">) {
  const evidence = await collectActivationEvidence(ctx, userId, row.initializedAt);
  const patch: Record<string, number | undefined> = {};
  // Use the normalized view for comparison
  const normalized = normalizedView(row);
  for (const id of ACTIVATION_ITEM_IDS) {
    const field = ITEM_MILESTONE_FIELD[id];
    const next = evidence[field];
    if (normalized[field] === undefined && next !== undefined) {
      patch[field] = next;
    }
  }
  if (row.evidenceBackfilledAt === undefined) {
    patch.evidenceBackfilledAt = Date.now();
  }
  // Also normalize legacy fields during evidence application
  const normPatch = normalizationPatch(row);
  Object.assign(patch, normPatch);

  if (Object.keys(patch).length === 0) {
    return row;
  }
  await ctx.db.patch(row._id, patch);
  const updated = await ctx.db.get(row._id);
  return updated ?? row;
}

/**
 * Creates an empty Activation row when missing. Does NOT scan evidence — writers
 * must stay bounded (ADR 0030 / non-blocking). Evidence backfill runs only via
 * initializeActivationChecklist (or Skip, which initializes first).
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
  return created;
}

/** Idempotent: sets a milestone timestamp only when absent. Uses generic field names only. */
export async function markActivationMilestone(
  ctx: MutationCtx,
  userId: Id<"users">,
  field: ActivationMilestoneField,
  at = Date.now(),
) {
  const row = await ensureActivationRow(ctx, userId, at);
  // Read from normalized view to check if already set
  const normalized = normalizedView(row);
  if (normalized[field] !== undefined) {
    return;
  }
  await ctx.db.patch(row._id, { [field]: at });
}

async function earliestCategoryCreatedAt(ctx: QueryCtx | MutationCtx, circleId: Id<"circles">) {
  const category = await ctx.db
    .query("categories")
    .withIndex("by_circle_createdAt", (q) => q.eq("circleId", circleId))
    .first();
  return category?.createdAt;
}

async function earliestTransactionCreatedAt(
  ctx: QueryCtx | MutationCtx,
  circle: Doc<"circles">,
  fallback: number,
) {
  const transaction = await ctx.db
    .query("transactions")
    .withIndex("by_circle_createdAt", (q) => q.eq("circleId", circle._id))
    .first();
  if (transaction) {
    return transaction.createdAt;
  }
  if (circle.currencyLocked) {
    return fallback;
  }
  return undefined;
}

/**
 * Durable "created a regular Circle" evidence: immutable `creatorUserId` on the
 * Circle (not mutable `ownerUserId` after transferOwnership). One indexed read.
 */
async function earliestCreatedRegularCircleAt(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  const circle = await ctx.db
    .query("circles")
    .withIndex("by_creatorUserId_kind_createdAt", (q) =>
      q.eq("creatorUserId", userId).eq("kind", "regular"),
    )
    .first();
  return circle?.createdAt;
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
    .first();
  return accepted?.createdAt;
}

async function collectActivationEvidence(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  initializedAt: number,
) {
  const personalCircle = await getPersonalCircleForOwner(ctx, userId);
  const evidence: Partial<Record<ActivationMilestoneField, number>> = {};

  if (personalCircle) {
    const categoryAt = await earliestCategoryCreatedAt(ctx, personalCircle._id);
    if (categoryAt !== undefined) {
      evidence.categoryCreatedAt = categoryAt;
    }
    const transactionAt = await earliestTransactionCreatedAt(ctx, personalCircle, initializedAt);
    if (transactionAt !== undefined) {
      evidence.transactionCreatedAt = transactionAt;
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

/**
 * Latest unexpired pending Invitation expiry for this inviter. The client timer
 * must wait until every live pending Invitation has expired; `.order("desc")`
 * yields the furthest `expiresAt` among rows still past `Date.now()`.
 */
async function latestUnexpiredPendingInvitationExpiresAt(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
) {
  const pending = await ctx.db
    .query("invitations")
    .withIndex("by_inviter_status_expiresAt", (q) =>
      q.eq("invitedByUserId", userId).eq("status", "pending").gt("expiresAt", Date.now()),
    )
    .order("desc")
    .first();
  return pending?.expiresAt;
}

function circleRefOf(circle: Doc<"circles">) {
  return buildRef(circle.name, circle._id);
}

/** Bounded Member CTA: one `.first()` per setup lane via the setupComplete index. */
async function resolveMemberCta(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  const setupComplete = await ctx.db
    .query("circles")
    .withIndex("by_owner_kind_status_setupComplete_createdAt", (q) =>
      q
        .eq("ownerUserId", userId)
        .eq("kind", "regular")
        .eq("status", "active")
        .eq("setupComplete", true),
    )
    .first();
  if (setupComplete) {
    return { kind: "members" as const, circleRef: circleRefOf(setupComplete) };
  }

  const incomplete = await ctx.db
    .query("circles")
    .withIndex("by_owner_kind_status_setupComplete_createdAt", (q) =>
      q
        .eq("ownerUserId", userId)
        .eq("kind", "regular")
        .eq("status", "active")
        .eq("setupComplete", false),
    )
    .first();
  if (incomplete) {
    return { kind: "setup" as const, circleRef: circleRefOf(incomplete) };
  }
  return { kind: "create" as const };
}

function completedCountOf(row: {
  transactionCreatedAt?: number;
  categoryCreatedAt?: number;
  regularCircleCreatedAt?: number;
  sharedMemberJoinedAt?: number;
}) {
  let count = 0;
  if (row.transactionCreatedAt !== undefined) count += 1;
  if (row.categoryCreatedAt !== undefined) count += 1;
  if (row.regularCircleCreatedAt !== undefined) count += 1;
  if (row.sharedMemberJoinedAt !== undefined) count += 1;
  return count;
}

function firstIncompleteOf(row: {
  transactionCreatedAt?: number;
  categoryCreatedAt?: number;
  regularCircleCreatedAt?: number;
  sharedMemberJoinedAt?: number;
}) {
  for (const id of ACTIVATION_ITEM_IDS) {
    if (row[ITEM_MILESTONE_FIELD[id]] === undefined) {
      return id;
    }
  }
  return null;
}

/**
 * Minimal Circle picker ref for activation checklist: only active, setup-complete,
 * visible Circles that are eligible to satisfy checklist items (GH-273 req 6).
 */
export interface ActivationCircleRef {
  id: Id<"circles">;
  ref: string;
  name: string;
  currency: string;
  kind: "personal" | "regular";
}

/**
 * Returns minimal eligible active setup-complete visible Circle picker refs
 * for the activation checklist (GH-273 req 6). These are Circles where the
 * user is an active member and the Circle is active + setup-complete.
 * Sorted: Personal first, then by creation order (ascending).
 */
async function resolveEligibleCircles(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  const memberships = await ctx.db
    .query("members")
    .withIndex("by_user_and_status", (q) => q.eq("userId", userId).eq("status", "active"))
    .collect();

  // Chunk Circle document loads — no serial N+1
  const resolved = await asyncMapChunked(
    memberships,
    DEFAULT_READ_CONCURRENCY,
    async (membership) => {
      const circle = await ctx.db.get(membership.circleId);
      if (circle?.status !== "active" || circle.setupCompletedAt === null) {
        return null;
      }
      return {
        id: circle._id,
        ref: circleRefOf(circle),
        name: circle.name,
        currency: circle.currency,
        kind: circle.kind,
        createdAt: circle.createdAt,
      } satisfies ActivationCircleRef & { createdAt: number };
    },
  );

  const circles = resolved.filter((c): c is NonNullable<typeof c> => c !== null);

  // Sort: Personal first, then by creation order (ascending)
  circles.sort((a, b) => {
    if (a.kind === "personal" && b.kind !== "personal") return -1;
    if (a.kind !== "personal" && b.kind === "personal") return 1;
    return a.createdAt - b.createdAt;
  });

  return circles.map(({ createdAt: _, ...rest }) => rest);
}

function toActivationChecklistView(
  row: {
    transactionCreatedAt?: number;
    categoryCreatedAt?: number;
    regularCircleCreatedAt?: number;
    sharedMemberJoinedAt?: number;
    dismissedAt?: number;
    completionEventDeliveredAt?: number;
  },
  pendingInvitationExpiresAt: number | undefined,
  memberCta: MemberCta,
  eligibleCircles: ActivationCircleRef[],
) {
  const completedCount = completedCountOf(row);
  const allComplete = completedCount === ACTIVATION_TOTAL;
  const dismissed = row.dismissedAt !== undefined;
  const sharedMemberState: SharedMemberState =
    row.sharedMemberJoinedAt !== undefined
      ? "complete"
      : pendingInvitationExpiresAt !== undefined
        ? "pending"
        : "not_started";

  const transactionComplete = row.transactionCreatedAt !== undefined;
  const categoryComplete = row.categoryCreatedAt !== undefined;
  const regularCircleComplete = row.regularCircleCreatedAt !== undefined;

  return {
    status: "ready" as const,
    visible: !dismissed && !allComplete,
    dismissed,
    allComplete,
    completedCount,
    total: ACTIVATION_TOTAL,
    // Generic boolean names (GH-273 rename)
    transactionComplete,
    categoryComplete,
    regularCircleComplete,
    sharedMemberState,
    pendingInvitationExpiresAt: pendingInvitationExpiresAt ?? null,
    firstIncomplete: firstIncompleteOf(row),
    memberCta,
    completionEventPending: allComplete && row.completionEventDeliveredAt === undefined,
    eligibleCircles,
  };
}

/**
 * Existing-User compatibility path: create the row if missing and merge durable
 * evidence into empty milestone fields only. Idempotent; never overwrites
 * progress or dismissal. Skips the evidence scan once `evidenceBackfilledAt` is set
 * so Skip/re-init cannot exceed read limits on active accounts.
 */
async function initializeActivationFromEvidence(ctx: MutationCtx, userId: Id<"users">) {
  const now = Date.now();
  const existing = await getUniqueActivationRow(ctx, userId);
  if (existing?.evidenceBackfilledAt !== undefined) {
    return existing;
  }
  if (existing) {
    return await applyEvidenceToRow(ctx, existing, userId);
  }
  const created = await insertActivationRow(ctx, userId, now);
  if (!created) {
    throw new Error("Activation row missing after insert");
  }
  return await applyEvidenceToRow(ctx, created, userId);
}

/** UI-ready Activation Checklist for the signed-in User. `uninitialized` when no row
 * or evidence backfill has not run yet (writer-created rows stay off the hot path). */
export const getActivationChecklist = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireCurrentUser(ctx);
    const rows = await listActivationRows(ctx, user._id);
    const row = readActivationRow(rows);
    if (!row || row.evidenceBackfilledAt === undefined) {
      return { status: "uninitialized" as const };
    }
    const pendingInvitationExpiresAt = await latestUnexpiredPendingInvitationExpiresAt(
      ctx,
      user._id,
    );
    const memberCta = await resolveMemberCta(ctx, user._id);
    const eligibleCircles = await resolveEligibleCircles(ctx, user._id);
    return toActivationChecklistView(row, pendingInvitationExpiresAt, memberCta, eligibleCircles);
  },
});

/** Idempotent per-User evidence backfill. Existing Users call this once from Home. */
export const initializeActivationChecklist = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireCurrentUser(ctx);
    await initializeActivationFromEvidence(ctx, user._id);
  },
});

/**
 * Persists Skip onboarding. Does not mark milestones. Repeated calls keep the
 * original dismissedAt. Returns `claimed: true` only for the caller that sets
 * dismissal (so analytics fire once across tabs).
 */
export const skipActivationChecklist = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireCurrentUser(ctx);
    // Skip may be the first touch for a legacy User — backfill evidence here so
    // completedCount is accurate, without putting scans on create writers.
    const row = await initializeActivationFromEvidence(ctx, user._id);
    const normalized = normalizedView(row);
    const completedCount = completedCountOf(normalized);
    if (row.dismissedAt !== undefined) {
      return { completedCount, claimed: false };
    }
    await ctx.db.patch(row._id, { dismissedAt: Date.now() });
    return { completedCount, claimed: true };
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
    if (!row) {
      return { claimed: false };
    }
    const normalized = normalizedView(row);
    if (completedCountOf(normalized) !== ACTIVATION_TOTAL) {
      return { claimed: false };
    }
    if (row.completionEventDeliveredAt !== undefined) {
      return { claimed: false };
    }
    await ctx.db.patch(row._id, { completionEventDeliveredAt: Date.now() });
    return { claimed: true };
  },
});

/**
 * Bounded internal migration: normalizes activation rows that still have legacy
 * fields. Processes at most MIGRATION_BATCH_SIZE rows per call using cursor
 * pagination (bounded at source). Returns whether more remain so the caller can
 * schedule continuation. Idempotent — safe to re-run.
 */
const MIGRATION_BATCH_SIZE = 50;

export const migrateActivationRows = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("userActivation").paginate({
      cursor: args.cursor ?? null,
      numItems: MIGRATION_BATCH_SIZE,
    });
    let migrated = 0;
    for (const row of page.page) {
      if (
        row.personalTransactionCreatedAt === undefined &&
        row.personalCategoryCreatedAt === undefined
      ) {
        continue;
      }
      const patch = normalizationPatch(row);
      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(row._id, patch);
        migrated += 1;
      }
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.activation.migrateActivationRows, {
        cursor: page.continueCursor,
      });
    }
    return { done: page.isDone, migrated, continueCursor: page.continueCursor };
  },
});
