import {
  buildRef,
  circleInputSchema,
  circleSetupAnswersSchema,
  colorLabel,
  DEFAULT_COLOR_ID,
  initials,
  isSupportedCurrency,
  MUTATION_ERRORS,
  mutationErrorData,
  parseCircleSettingsUpdate,
  starterCategories,
  toCurrencyCode,
} from "@pocketcircle/domain";
import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { mutation, query } from "./_generated/server.js";
import {
  accountDeletionBlockerFields,
  recomputeAccountDeletionBlockers,
} from "./accountDeletionBlockers.js";
import { requireCurrentUser } from "./auth.js";
import { createCategoryForMember } from "./categories.js";
import { requireCircleAccess, resolveCircleAccess } from "./guard.js";
import type { HistoryChange } from "./history.js";
import { circleEntity, paginateEntityHistory, recordEvent } from "./history.js";
import { type HistoryEventView, newActorCache, toHistoryEventView } from "./historyView.js";
import { revokePendingInvitationsForCircle } from "./invitations.js";
import { isEffectiveActiveMember } from "./memberIdentity.js";
import { getPersonalCircleForOwner, reconcilePersonalCircleFromDisplayName } from "./model.js";
import { notifyCircleLifecycleChange } from "./notify.js";

const circleSetupAnswers = v.object({
  purpose: v.optional(
    v.union(
      v.literal("residence"),
      v.literal("trip"),
      v.literal("family"),
      v.literal("roommates"),
      v.literal("project"),
      v.literal("personal"),
      v.literal("other"),
    ),
  ),
  residenceType: v.optional(v.union(v.literal("leased"), v.literal("owned"))),
});

/** A Circle plus its canonical ref, shaped for the client. */
function toCircleView(circle: Doc<"circles">) {
  return {
    id: circle._id,
    ref: buildRef(circle.name, circle._id),
    name: circle.name,
    kind: circle.kind,
    currency: circle.currency,
    color: circle.color,
    mark: circle.mark,
    status: circle.status,
    setupAnswers: circle.setupAnswers,
    setupComplete: circle.setupCompletedAt !== null,
    currencyLocked: circle.currencyLocked,
    nameCustomized: circle.personalNameCustomizedAt !== undefined,
  };
}

/** Circles the current User is an active Member of, Personal Circle first. */
export const listMyCircles = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireCurrentUser(ctx);
    const memberships = await ctx.db
      .query("members")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();

    const circles: Doc<"circles">[] = [];
    for (const membership of memberships) {
      if (membership.status !== "active") {
        continue;
      }
      const circle = await ctx.db.get(membership.circleId);
      if (circle) {
        circles.push(circle);
      }
    }

    circles.sort((a, b) => {
      if (a.kind !== b.kind) {
        return a.kind === "personal" ? -1 : 1;
      }
      return a.createdAt - b.createdAt;
    });

    return circles.map(toCircleView);
  },
});

/**
 * Resolves a single Circle by its authoritative ID for the staged route guard
 * (ADR 0016/0017). Returns null when missing or inaccessible without
 * distinguishing the two cases.
 */
export const getCircle = query({
  // Accepts the raw trailing-segment ID from the route ref. A malformed ID
  // normalizes to null (treated as unavailable) rather than throwing, so the
  // guard's fallback path stays uniform (ADR 0016).
  args: { circleId: v.string() },
  handler: async (ctx, args) => {
    const circleId = ctx.db.normalizeId("circles", args.circleId);
    if (!circleId) {
      return null;
    }
    const access = await resolveCircleAccess(ctx, circleId);
    return access ? toCircleView(access.circle) : null;
  },
});

/** Creates a regular Circle owned by the current User (PRD story 6). */
/** Creates a regular Circle. Born incomplete — owner must Finish setup (ADR 0023). */
export const createCircle = mutation({
  args: {
    name: v.string(),
    currency: v.string(),
    color: v.string(),
    mark: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    const input = circleInputSchema.parse(args);
    const now = Date.now();

    const circleId = await ctx.db.insert("circles", {
      name: input.name,
      kind: "regular",
      currency: input.currency,
      color: input.color || DEFAULT_COLOR_ID,
      mark: input.mark,
      ownerUserId: user._id,
      status: "active",
      setupCompletedAt: null,
      currencyLocked: false,
      ...accountDeletionBlockerFields(
        { kind: "regular", status: "active", setupCompletedAt: null },
        1,
      ),
      createdAt: now,
    });

    const memberId = await ctx.db.insert("members", {
      circleId,
      userId: user._id,
      role: "owner",
      status: "active",
      displayName: user.displayName,
      image: user.image,
      joinedAt: now,
    });

    const ownerMembership = await ctx.db.get(memberId);
    await recordEvent(ctx, {
      entity: circleEntity(circleId),
      actor: ownerMembership,
      action: "created",
      changes: [{ field: "name", to: input.name }], // no `from` on create
    });

    return circleId;
  },
});

/** Updates Circle Settings the caller owns: Color and Setup answers (CS-2). */
export const updateCircleSettings = mutation({
  args: {
    circleId: v.id("circles"),
    color: v.optional(v.string()),
    setupAnswers: v.optional(circleSetupAnswers),
  },
  handler: async (ctx, args) => {
    const access = await requireCircleAccess(ctx, args.circleId);
    if (!access.isOwner) {
      throw new Error("Only the owner can change circle settings");
    }
    access.assertWritable();

    const input = parseCircleSettingsUpdate(
      {
        color: args.color,
        setupAnswers: args.setupAnswers,
      },
      access.circle.kind,
    );

    // Setup answers must not be edited until the owner has finished Circle Setup via
    // completeCircleSetup (one-shot starter seeding). Color-only edits stay allowed
    // before setup (ADR 0023 / CS-5); answer edits opt into the shared setup guard.
    if (input.setupAnswers !== undefined) {
      access.assertSetupComplete();
    }

    const patch: Partial<Doc<"circles">> = {};
    const changes: HistoryChange[] = [];

    if (input.color !== undefined && input.color !== access.circle.color) {
      patch.color = input.color;
      changes.push({
        field: "color",
        from: colorLabel(access.circle.color),
        to: colorLabel(input.color),
      });
    }

    if (input.setupAnswers !== undefined) {
      const answerChanges = setupAnswerChanges(access.circle.setupAnswers, input.setupAnswers);
      if (answerChanges.length > 0) {
        patch.setupAnswers = input.setupAnswers;
        changes.push(...answerChanges);
      }
    }

    if (changes.length === 0) {
      return;
    }

    await ctx.db.patch(access.circle._id, patch);
    await recordEvent(ctx, {
      entity: circleEntity(access.circle._id),
      actor: access.membership,
      action: "settings_changed",
      changes,
    });
  },
});

/**
 * Turns Personal Circle name auto-sync with the owner's Display Name on or off (USR-2).
 * Exempt from setup gating: Personal Circles are born complete (ADR 0023).
 * No Circle History event — identity-driven, like `reconcilePersonalCircleFromDisplayName`.
 */
export const setPersonalCircleNameAutoSync = mutation({
  args: { enabled: v.boolean() },
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    const personalCircle = await getPersonalCircleForOwner(ctx, user._id);
    if (!personalCircle) {
      return;
    }

    if (args.enabled) {
      await ctx.db.patch(personalCircle._id, { personalNameCustomizedAt: undefined });
      await reconcilePersonalCircleFromDisplayName(ctx, user._id, user.displayName);
      return;
    }

    if (personalCircle.personalNameCustomizedAt === undefined) {
      await ctx.db.patch(personalCircle._id, { personalNameCustomizedAt: Date.now() });
    }
  },
});

/** Changes a Circle's currency before the first Transaction (CS-3). */
export const setCurrency = mutation({
  args: { circleId: v.id("circles"), currency: v.string() },
  handler: async (ctx, args) => {
    const access = await requireCircleAccess(ctx, args.circleId);
    if (!access.isOwner) {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.currencyForbidden));
    }
    access.assertWritable();
    access.assertSetupComplete();

    const hasTransaction = await ctx.db
      .query("transactions")
      .withIndex("by_circle", (q) => q.eq("circleId", args.circleId))
      .first();
    if (access.circle.currencyLocked || hasTransaction) {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.currencyLocked));
    }

    if (!isSupportedCurrency(args.currency)) {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.currencyUnsupported));
    }
    const currency = toCurrencyCode(args.currency);
    if (currency === access.circle.currency) {
      return;
    }

    const from = access.circle.currency;
    await ctx.db.patch(access.circle._id, { currency });
    await recordEvent(ctx, {
      entity: circleEntity(access.circle._id),
      actor: access.membership,
      action: "settings_changed",
      changes: [{ field: "currency", from, to: currency }],
    });
  },
});

/** Renames a Circle the caller owns (PRD stories 5, 79). */
export const renameCircle = mutation({
  args: { circleId: v.id("circles"), name: v.string() },
  handler: async (ctx, args) => {
    const access = await requireCircleAccess(ctx, args.circleId);
    if (!access.isOwner) {
      throw new Error("Only the owner can rename this circle");
    }
    access.assertWritable(); // an archived Circle is read-only (PRD story 79)
    access.assertSetupComplete();

    const name = args.name.trim();
    if (name === "") {
      throw new Error("Name is required");
    }
    if (name === access.circle.name) {
      return; // no-op: nothing changed, so nothing to record
    }

    const patch: Partial<Doc<"circles">> = { name };
    if (access.circle.kind === "personal") {
      patch.mark = initials(name);
      patch.personalNameCustomizedAt = Date.now();
    }

    await ctx.db.patch(access.circle._id, patch);
    await recordEvent(ctx, {
      entity: circleEntity(access.circle._id),
      actor: access.membership,
      action: "renamed",
      changes: [{ field: "name", from: access.circle.name, to: name }],
    });
  },
});

/** Completes Circle Setup once: persisted answers + starter Categories. Exempt — this is the transition out of incomplete (ADR 0023). */
export const completeCircleSetup = mutation({
  args: {
    circleId: v.id("circles"),
    answers: circleSetupAnswers,
  },
  handler: async (ctx, args) => {
    const access = await requireCircleAccess(ctx, args.circleId);
    if (!access.isOwner) {
      throw new Error("Only the owner can complete circle setup");
    }
    access.assertWritable();
    if (access.circle.setupCompletedAt !== null) {
      throw new Error("Circle setup is already complete");
    }

    const answers = circleSetupAnswersSchema.parse(args.answers);
    const now = Date.now();
    const circleChanges: HistoryChange[] = setupAnswerChanges(access.circle.setupAnswers, answers);
    const patch: Partial<Doc<"circles">> = { setupAnswers: answers, setupCompletedAt: now };

    await ctx.db.patch(args.circleId, patch);

    // Setup completion is a milestone in its own right — record it even when the owner
    // finishes with default answers (no answer diff). `changes` is empty in that case,
    // like a created/archived event.
    await recordEvent(ctx, {
      entity: circleEntity(args.circleId),
      actor: access.membership,
      action: "setup_completed",
      changes: circleChanges,
    });

    await recomputeAccountDeletionBlockers(ctx, args.circleId);

    const createdCategoryIds: Id<"categories">[] = [];
    for (const category of starterCategories(answers)) {
      const result = await createCategoryForMember(ctx, {
        access,
        name: category.name,
        type: category.type,
        color: category.color,
        duplicate: "skip",
      });
      if (result.categoryId) {
        createdCategoryIds.push(result.categoryId);
      }
    }

    return { createdCategoryIds };
  },
});

/** Archives a regular Circle the caller owns (MEM-8; PRD 20–22). */
export const archiveCircle = mutation({
  args: { circleId: v.id("circles") },
  handler: async (ctx, args) => {
    const access = await requireCircleAccess(ctx, args.circleId);
    if (!access.isOwner) {
      throw new Error("Only the owner can archive this circle");
    }
    if (access.circle.kind === "personal") {
      throw new Error("Personal Circles can't be archived");
    }
    if (access.circle.status !== "active") {
      throw new Error("Circle is already archived");
    }
    access.assertSetupComplete();

    const now = Date.now();
    await ctx.db.patch(access.circle._id, { status: "archived", archivedAt: now });
    await revokePendingInvitationsForCircle(ctx, access.circle._id);
    await recomputeAccountDeletionBlockers(ctx, access.circle._id);

    await recordEvent(ctx, {
      entity: circleEntity(access.circle._id),
      actor: access.membership,
      action: "archived",
      changes: [],
    });

    await notifyCircleLifecycleChange(ctx, {
      circle: access.circle,
      actorUserId: access.user._id,
      actorDisplayName: access.membership.displayName,
      action: "archived",
    });

    return args.circleId;
  },
});

/**
 * One newest-first page of a Circle's **Circle History** (CS-4; PRD stories 79–80)
 * — ownership transfers, membership changes, lifecycle, rename, and settings
 * events with the acting Member and frozen old/new values. Any current Member
 * may view it, for an Archived Circle too (history is a read surface).
 *
 * The exact mirror of `listCategoryHistory` (CAT-2), reusing the same
 * `paginateEntityHistory` read over the `by_entity` index (README §4: history is
 * unbounded-growth, so it must never `.collect()` the whole audit) and the same
 * shared event view, so the web's `HistoryList` renders both.
 *
 * Anti-enumeration (ADR 0016): a malformed id or an inaccessible Circle return
 * the same empty, exhausted page — indistinguishable from a Circle with no
 * history, so nothing leaks.
 */
export const listCircleHistory = query({
  args: {
    circleId: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const emptyPage = { page: [], isDone: true, continueCursor: "" };
    const circleId = ctx.db.normalizeId("circles", args.circleId);
    if (!circleId) {
      return emptyPage;
    }
    const access = await resolveCircleAccess(ctx, circleId);
    if (!access) {
      return emptyPage;
    }
    const result = await paginateEntityHistory(ctx, circleEntity(circleId), args.paginationOpts);
    const cache = newActorCache();
    const page = await Promise.all(
      result.page.map((event) => toHistoryEventView(ctx, event, cache)),
    );
    return {
      ...result,
      page: access.isOwner ? page : redactInviteeEmailFromHistoryPage(page),
    };
  },
});

/** Omit Invitation invitee email from Circle History for non-Owners (ADR 0028). */
function redactInviteeEmailFromHistoryPage(page: HistoryEventView[]) {
  return page.map((event) => ({
    ...event,
    changes: event.changes.filter((change) => change.field !== "email"),
  }));
}

/** Whether a Circle has any Transaction row, of any status (MEM-9 UI gate). */
export const circleHasTransactions = query({
  args: { circleId: v.id("circles") },
  handler: async (ctx, args) => {
    const access = await resolveCircleAccess(ctx, args.circleId);
    if (!access) {
      return null;
    }
    const transaction = await ctx.db
      .query("transactions")
      .withIndex("by_circle", (q) => q.eq("circleId", args.circleId))
      .first();
    return transaction !== null;
  },
});

/** Deletes an owner-only, zero-transaction regular Circle (MEM-9). Exempt — abandoned empty incomplete Circles must remain deletable (ADR 0023). */
export const deleteCircle = mutation({
  args: { circleId: v.id("circles") },
  handler: async (ctx, args) => {
    const access = await requireCircleAccess(ctx, args.circleId);
    if (!access.isOwner) {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.circleDeleteForbidden));
    }
    if (access.circle.kind === "personal") {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.circleDeletePersonal));
    }

    // Gate counts effective active members only (owner must be sole active member).
    const activeMembers = await ctx.db
      .query("members")
      .withIndex("by_circle_and_status", (q) =>
        q.eq("circleId", args.circleId).eq("status", "active"),
      )
      .collect();
    let effectiveActive = 0;
    for (const member of activeMembers) {
      if (await isEffectiveActiveMember(ctx, member)) {
        effectiveActive += 1;
      }
    }
    if (effectiveActive !== 1) {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.circleDeleteHasMembers));
    }

    const hasTransaction = await ctx.db
      .query("transactions")
      .withIndex("by_circle", (q) => q.eq("circleId", args.circleId))
      .first();
    if (hasTransaction) {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.circleDeleteNotEmpty));
    }

    await deleteCircleCascade(ctx, args.circleId);
  },
});

/** Restores an archived regular Circle the caller owns (MEM-8). */
export const restoreCircle = mutation({
  args: { circleId: v.id("circles") },
  handler: async (ctx, args) => {
    const access = await requireCircleAccess(ctx, args.circleId);
    if (!access.isOwner) {
      throw new Error("Only the owner can restore this circle");
    }
    if (access.circle.status !== "archived") {
      throw new Error("Circle is not archived");
    }
    access.assertSetupComplete();

    await ctx.db.patch(access.circle._id, { status: "active", archivedAt: undefined });
    await recomputeAccountDeletionBlockers(ctx, access.circle._id);

    await recordEvent(ctx, {
      entity: circleEntity(access.circle._id),
      actor: access.membership,
      action: "restored",
      changes: [],
    });

    await notifyCircleLifecycleChange(ctx, {
      circle: access.circle,
      actorUserId: access.user._id,
      actorDisplayName: access.membership.displayName,
      action: "restored",
    });

    return args.circleId;
  },
});

async function deleteHistoriesForEntity(ctx: MutationCtx, entityId: string) {
  const rows = await ctx.db
    .query("histories")
    .withIndex("by_entity", (q) => q.eq("entityId", entityId))
    .collect();
  for (const row of rows) {
    await ctx.db.delete(row._id);
  }
}

async function deleteCircleCascade(ctx: MutationCtx, circleId: Id<"circles">) {
  const categories = await ctx.db
    .query("categories")
    .withIndex("by_circle", (q) => q.eq("circleId", circleId))
    .collect();
  for (const category of categories) {
    await deleteHistoriesForEntity(ctx, category._id);
    await ctx.db.delete(category._id);
  }

  const invitations = await ctx.db
    .query("invitations")
    .withIndex("by_circle", (q) => q.eq("circleId", circleId))
    .collect();
  for (const invitation of invitations) {
    await ctx.db.delete(invitation._id);
  }

  const e2eTokens = await ctx.db
    .query("e2eInvitationTokens")
    .withIndex("by_circle_and_email", (q) => q.eq("circleId", circleId))
    .collect();
  for (const token of e2eTokens) {
    await ctx.db.delete(token._id);
  }

  await deleteHistoriesForEntity(ctx, circleId);

  const members = await ctx.db
    .query("members")
    .withIndex("by_circle", (q) => q.eq("circleId", circleId))
    .collect();
  for (const member of members) {
    await ctx.db.delete(member._id);
  }

  await ctx.db.delete(circleId);
}

function setupAnswerChanges(
  before: Doc<"circles">["setupAnswers"],
  after: NonNullable<Doc<"circles">["setupAnswers"]>,
) {
  const changes: HistoryChange[] = [];
  if (before?.purpose !== after.purpose) {
    changes.push({
      field: "setup.purpose",
      ...(before?.purpose ? { from: before.purpose } : {}),
      ...(after.purpose ? { to: after.purpose } : {}),
    });
  }
  if (before?.residenceType !== after.residenceType) {
    changes.push({
      field: "setup.residenceType",
      ...(before?.residenceType ? { from: before.residenceType } : {}),
      ...(after.residenceType ? { to: after.residenceType } : {}),
    });
  }
  return changes;
}
