import {
  buildRef,
  categoryInputSchema,
  categoryUpdateSchema,
  colorLabel,
  MUTATION_ERRORS,
  mutationErrorData,
  normalizeSearchText,
  textIncludes,
} from "@spend-circle/domain";
import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { mergedStream, stream } from "convex-helpers/server/stream";
import type { Doc } from "./_generated/dataModel.js";
import { type MutationCtx, mutation, type QueryCtx, query } from "./_generated/server.js";
import {
  type AuthorizedCircle,
  requireCategoryAccess,
  requireCircleAccess,
  resolveCircleAccess,
} from "./guard.js";
import {
  categoryEntity,
  type HistoryChange,
  paginateEntityHistory,
  recordEvent,
} from "./history.js";
import { newActorCache, toHistoryEventView } from "./historyView.js";
import { notifyCategoryLifecycleChange } from "./notify.js";
import schema from "./schema.js";
import { newViewCaches, toTransactionView } from "./transactions.js";

const transactionType = v.union(v.literal("expense"), v.literal("income"));

function duplicateCategoryNameError() {
  return new ConvexError(mutationErrorData(MUTATION_ERRORS.categoryNameDuplicate));
}

/** The viewer a Category view is shaped FOR — drives the capability flags below. */
export interface CategoryViewer {
  userId: Doc<"users">["_id"];
  isOwner: boolean;
}

/**
 * A Category shaped for the client. The creator is surfaced as a Member
 * reference (Display Name + image) resolved from the materialized membership
 * identity (ADR 0018) — never a raw user id — so the UI can attribute the
 * Category without re-resolving. Categories created by a Removed Member stay
 * active (PRD story 53); the frozen removed-member identity is what shows.
 *
 * `canEditFields` is resolved HERE against the viewer: only the creator may edit
 * a Category's name/color (CAT-2), and because it compares the stored
 * `creatorUserId` to the caller's stable User id, a Removed→rejoined creator
 * regains it automatically (PRD 44 applied to Categories). `canArchive` is the
 * moderation counterpart — the creator OR the Owner may archive/restore (the
 * Owner moderates lifecycle without gaining field edit, so the two flags are
 * deliberately distinct). The UI gates its affordances on these flags, but the
 * server re-checks on every mutation — they are the courtesy, not the
 * enforcement (ADR 0015), matching `requireCategoryAccess` in `guard.ts`.
 */
export async function toCategoryView(
  ctx: QueryCtx,
  category: Doc<"categories">,
  viewer: CategoryViewer,
) {
  const creatorMembership = await ctx.db
    .query("members")
    .withIndex("by_circle_and_user", (q) =>
      q.eq("circleId", category.circleId).eq("userId", category.creatorUserId),
    )
    .unique();
  const isCreator = category.creatorUserId === viewer.userId;
  return {
    id: category._id,
    name: category.name,
    type: category.type,
    color: category.color,
    status: category.status,
    creator: {
      displayName: creatorMembership?.displayName ?? "Unknown member",
      image: creatorMembership?.image,
    },
    canEditFields: isCreator,
    canArchive: isCreator || viewer.isOwner,
  };
}

export type CategoryView = Awaited<ReturnType<typeof toCategoryView>>;

export async function toCategoryDetailView(
  ctx: QueryCtx,
  category: Doc<"categories">,
  viewer: CategoryViewer,
) {
  return {
    ...(await toCategoryView(ctx, category, viewer)),
    ref: buildRef(category.name, category._id),
  };
}

export type CategoryDetailView = Awaited<ReturnType<typeof toCategoryDetailView>>;

interface CreateCategoryForMemberArgs {
  access: AuthorizedCircle;
  name: string;
  type: "expense" | "income";
  color: string;
  duplicate: "throw" | "skip";
}

export async function createCategoryForMember(ctx: MutationCtx, args: CreateCategoryForMemberArgs) {
  const input = categoryInputSchema.parse({
    name: args.name,
    type: args.type,
    color: args.color,
  });
  const nameLower = input.name.toLowerCase();

  // Uniqueness across ALL statuses — archived names are still reserved.
  const existing = await ctx.db
    .query("categories")
    .withIndex("by_circle_type_name", (q) =>
      q.eq("circleId", args.access.circle._id).eq("type", input.type).eq("nameLower", nameLower),
    )
    .first();
  if (existing) {
    if (args.duplicate === "skip") {
      return { created: false };
    }
    throw duplicateCategoryNameError();
  }

  const categoryId = await ctx.db.insert("categories", {
    circleId: args.access.circle._id,
    name: input.name,
    nameLower,
    type: input.type,
    color: input.color,
    creatorUserId: args.access.user._id,
    status: "active",
    createdAt: Date.now(),
  });

  // Record the create now (ADR 0018) even though the Category History view is
  // CAT-2 — its view needs this row to exist. Values are pre-formatted human
  // strings: the color label, never the raw id.
  await recordEvent(ctx, {
    entity: categoryEntity(categoryId),
    actor: args.access.membership,
    action: "created",
    changes: [
      { field: "name", to: input.name },
      { field: "color", to: colorLabel(input.color) },
      { field: "type", to: input.type },
    ],
  });

  return { created: true, categoryId, name: input.name };
}

/**
 * Lists a Circle's Categories for one type, active by default. Resolver query
 * (ADR 0016): an inaccessible or missing Circle returns `null`, identical to a
 * non-member — never leaking whether the Circle exists. When `type` is omitted
 * both types are returned (the form's color/name de-dupe doesn't need it, but a
 * future combined view does); `includeArchived` widens to archived Categories
 * for historical surfaces.
 */
export const listCategories = query({
  args: {
    circleId: v.id("circles"),
    type: v.optional(transactionType),
    includeArchived: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const access = await resolveCircleAccess(ctx, args.circleId);
    if (!access) {
      return null; // missing ≡ inaccessible (ADR 0016)
    }

    const { circleId, type } = args;
    const categories = type
      ? await ctx.db
          .query("categories")
          .withIndex("by_circle_type_createdAt", (q) => q.eq("circleId", circleId).eq("type", type))
          .collect()
      : await ctx.db
          .query("categories")
          .withIndex("by_circle", (q) => q.eq("circleId", circleId))
          .collect();

    const visible = args.includeArchived
      ? categories
      : categories.filter((category) => category.status === "active");

    // Newest first so a freshly created Category surfaces at the top.
    // `_creationTime` breaks ties when two rows share a `createdAt` millisecond.
    visible.sort((a, b) => b.createdAt - a.createdAt || b._creationTime - a._creationTime);

    const viewer = { userId: access.user._id, isOwner: access.isOwner };
    return await Promise.all(visible.map((category) => toCategoryView(ctx, category, viewer)));
  },
});

/**
 * Resolves one Category for its **Category Detail** object route (issue #240). The mirror
 * of {@link getTransaction}: normalize ids, verify Circle access, load by id, collapse
 * missing / inaccessible / wrong-Circle to `null` (ADR 0016). Archived Categories resolve —
 * detail is a read surface.
 */
export const getCategory = query({
  args: { circleId: v.string(), categoryId: v.string() },
  handler: async (ctx, args) => {
    const categoryId = ctx.db.normalizeId("categories", args.categoryId);
    const circleId = ctx.db.normalizeId("circles", args.circleId);
    if (!categoryId || !circleId) {
      return null;
    }
    const access = await resolveCircleAccess(ctx, circleId);
    if (!access) {
      return null;
    }
    const category = await ctx.db.get(categoryId);
    if (!category || category.circleId !== circleId) {
      return null;
    }
    const viewer = { userId: access.user._id, isOwner: access.isOwner };
    return toCategoryDetailView(ctx, category, viewer);
  },
});

/**
 * The five most recent Transactions linked to a Category (issue #240), ordered by
 * Transaction Date descending, then `createdAt` descending, then `transactionId` as a
 * deterministic tie-breaker. Includes active and archived Transactions. Returns `[]` for
 * the same anti-enumeration cases as other supporting list reads below a resolved object
 * route (malformed ids, missing Category, inaccessible Circle, wrong-Circle Category).
 */
export const listRecentCategoryTransactions = query({
  args: { circleId: v.string(), categoryId: v.string() },
  handler: async (ctx, args) => {
    const categoryId = ctx.db.normalizeId("categories", args.categoryId);
    const circleId = ctx.db.normalizeId("circles", args.circleId);
    if (!categoryId || !circleId) {
      return [];
    }
    const access = await resolveCircleAccess(ctx, circleId);
    if (!access) {
      return [];
    }
    const category = await ctx.db.get(categoryId);
    if (!category || category.circleId !== circleId) {
      return [];
    }

    const links = await ctx.db
      .query("transactionCategories")
      .withIndex("by_category_recent", (q) => q.eq("categoryId", categoryId))
      .order("desc")
      .take(5);

    const caches = newViewCaches();
    const rows = [];
    for (const link of links) {
      const txn = await ctx.db.get(link.transactionId);
      if (!txn || txn.circleId !== circleId) {
        continue;
      }
      rows.push(await toTransactionView(ctx, txn, caches, access.membership._id, access.isOwner));
    }
    return rows;
  },
});

/** One type's stream, scoped by lifecycle: the status index when the scope is
 * `active`/`archived` (eq on status, `createdAt` desc), the no-status
 * `createdAt` index when `all` (both statuses interleaved). Either way the index
 * carries the sort key, so pages stay in `createdAt` desc order (with Convex's
 * implicit `_creationTime` desc tiebreak) across page boundaries. Both indexes
 * fix every field before `createdAt` via `.eq(...)`, so each stream is already
 * ordered by `createdAt` then Convex's implicit `_creationTime` — the precondition
 * `mergedStream` needs to merge the two type streams on that same composite key
 * (see {@link streamCategoriesByStatus}). */
function streamCategoriesOfType(
  ctx: QueryCtx,
  args: {
    circleId: Doc<"circles">["_id"];
    type: "expense" | "income";
    status: "active" | "archived" | "all";
  },
) {
  if (args.status === "all") {
    return stream(ctx.db, schema)
      .query("categories")
      .withIndex("by_circle_type_createdAt", (q) =>
        q.eq("circleId", args.circleId).eq("type", args.type),
      )
      .order("desc");
  }
  const status = args.status;
  return stream(ctx.db, schema)
    .query("categories")
    .withIndex("by_circle_type_status_createdAt", (q) =>
      q.eq("circleId", args.circleId).eq("type", args.type).eq("status", status),
    )
    .order("desc");
}

/** The Category Filter's source stream. For a concrete type it is the single
 * lifecycle-scoped stream above. For `type: "all"` it MERGES the expense and
 * income streams on `["createdAt", "_creationTime"]` (desc), preserving newest-first across both
 * types — neither type index alone can range over both, but each is already
 * `createdAt`-ordered (it fixes `type` with `.eq`), so the merge reuses the
 * existing indexes with no schema change. The merge is type-agnostic about
 * lifecycle: each side honors the `status` scope independently. */
function streamCategoriesByStatus(
  ctx: QueryCtx,
  args: {
    circleId: Doc<"circles">["_id"];
    type: "all" | "expense" | "income";
    status: "active" | "archived" | "all";
  },
) {
  if (args.type !== "all") {
    return streamCategoriesOfType(ctx, { ...args, type: args.type });
  }
  return mergedStream(
    [
      streamCategoriesOfType(ctx, { ...args, type: "expense" }),
      streamCategoriesOfType(ctx, { ...args, type: "income" }),
    ],
    ["createdAt", "_creationTime"],
  );
}

/**
 * The **Category Filter** read (CAT-4): one page of a Circle's Categories of one
 * type — or both, when `type` is `"all"` (issue #138), merged newest-first across
 * the two type streams — narrowed by lifecycle scope (active / archived / all) and
 * an optional name search — substring, case-insensitive, whitespace-normalized, **name
 * only**. The management list this feeds grows with the Circle, so it paginates
 * **at the source** (README §4): the status-appropriate index streams rows
 * newest-first and the text match filters in-handler (`filterWith`), filling the
 * page until the requested size or the source is exhausted, so a sparse match
 * never yields an empty intermediate page while further matches exist.
 *
 * The page-filling read goes through `convex-helpers` streams rather than the
 * RPT-2 paginate-and-loop shape the slice sketched: Convex permits only ONE
 * `.paginate()` call per function execution, so a loop that re-paginates to fill
 * a sparsely-matched page throws `"ran multiple paginated queries"` on the real
 * backend (convex-test doesn't enforce it; the E2E run did). Streams read the
 * same index ranges via `take` under the hood, sidestepping the restriction with
 * identical semantics.
 *
 * This deliberately does NOT replace {@link listCategories}: the Transaction-form
 * picker and the filter-option queries need the whole small selectable set, the
 * opposite access pattern of this paginated stream.
 *
 * Anti-enumeration (ADR 0016): an inaccessible or missing Circle returns the same
 * empty, exhausted page — indistinguishable from a Circle with no Categories. (A
 * paginated query returns an empty page rather than `null` so `usePaginatedQuery`
 * stays on its normal lifecycle, exactly like `listCategoryHistory`.) An archived
 * Circle still lists — reading history is allowed, writing is not.
 */
export const filterCategories = query({
  args: {
    circleId: v.id("circles"),
    type: v.union(transactionType, v.literal("all")),
    status: v.union(v.literal("active"), v.literal("archived"), v.literal("all")),
    query: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const access = await resolveCircleAccess(ctx, args.circleId);
    if (!access) {
      return { page: [], isDone: true, continueCursor: "" }; // missing ≡ inaccessible (ADR 0016)
    }

    // Normalized once per request; empty/whitespace means no text narrowing.
    const queryText = normalizeSearchText(args.query);

    const source = streamCategoriesByStatus(ctx, args);
    const narrowed = queryText
      ? source.filterWith(async (category) => textIncludes(category.name, queryText))
      : source;
    const result = await narrowed.paginate(args.paginationOpts);

    const viewer = { userId: access.user._id, isOwner: access.isOwner };
    return {
      page: await Promise.all(result.page.map((category) => toCategoryView(ctx, category, viewer))),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

/**
 * Creates a type-specific Category in a Circle (PRD stories 47–49, 59–61). Any
 * current Member may create — not just the Owner (PRD story 48) — so this gates
 * on `requireCircleAccess` + `assertWritable` only, with no owner check.
 *
 * The hard invariant lives here: names are unique per (Circle, type),
 * case-insensitively, and that uniqueness spans archived names too (PRD stories
 * 49, 54). We compare on the stored `nameLower` via `by_circle_type_name` and do
 * NOT filter by status, so an archived "Gas" still blocks a new "gas".
 */
export const createCategory = mutation({
  args: {
    circleId: v.id("circles"),
    name: v.string(),
    type: transactionType,
    color: v.string(),
  },
  handler: async (ctx, args) => {
    const access = await requireCircleAccess(ctx, args.circleId);
    access.assertWritable(); // an archived Circle is read-only (PRD story 79)
    const result = await createCategoryForMember(ctx, { access, ...args, duplicate: "throw" });
    if (!result.created) {
      throw duplicateCategoryNameError();
    }
    return result.categoryId;
  },
});

/**
 * Edits a Category's fields — name and/or color (CAT-2; PRD stories 55, 56). Both
 * args are optional: an absent field is left unchanged, and only the fields that
 * actually change are patched and recorded, so a no-op submit writes nothing and
 * leaves no spurious history (the TXN-2 contract applied to Categories).
 *
 * Flow: `requireCategoryAccess` (folds in `resolveCircleAccess`, ADR 0015) →
 * `assertWritable` (an archived Circle is read-only) → **creator check**: only the
 * Member who created the Category may edit its fields — the Owner moderates
 * lifecycle (archive/restore below) but may NOT rename or recolor another
 * Member's Category, so this gates on `isCreator`, never `canArchive` → reject an
 * **Archived Category** (frozen until restored, like an Archived Transaction) →
 * validate present fields against the shared Zod schema → re-run uniqueness on a
 * rename (case-insensitive, per Circle+type, INCLUDING archived names — the same
 * invariant create enforces) → patch → `recordEvent` with per-field `from`/`to`
 * (color as its display label, never the raw id — ADR 0018).
 *
 * A case-only rename of the SAME Category (e.g. "gas" → "Gas") is allowed: its
 * `nameLower` lookup finds itself, which is not a collision.
 *
 * Anti-enumeration (ADR 0016): a missing Category and one whose Circle the caller
 * can't access both throw the same "Category not found".
 */
export const updateCategory = mutation({
  args: {
    categoryId: v.id("categories"),
    name: v.optional(v.string()),
    color: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireCategoryAccess(ctx, args.categoryId);
    access.assertWritable(); // an archived Circle is read-only (PRD story 79)

    // Only the creator edits fields (PRD story 55). The Owner's moderation power is
    // archive/restore, NOT field edits (PRD story 56) — same generic message either way.
    if (!access.isCreator) {
      throw new Error("Only the member who created this category can edit it");
    }

    const category = access.category;
    // An Archived Category is frozen — restore it first. Blocked here, never by the
    // UI alone (ADR 0015); its name stays reserved while archived (PRD story 54).
    if (category.status !== "active") {
      throw new Error("Archived categories can't be edited");
    }

    const input = categoryUpdateSchema.parse({ name: args.name, color: args.color });

    const patch: Partial<Doc<"categories">> = {};
    const changes: HistoryChange[] = [];

    if (input.name !== undefined && input.name !== category.name) {
      const nameLower = input.name.toLowerCase();
      // Re-run uniqueness on rename, across ALL statuses (archived names stay
      // reserved) — finding ITSELF (a case-only rename) is not a collision.
      const existing = await ctx.db
        .query("categories")
        .withIndex("by_circle_type_name", (q) =>
          q.eq("circleId", category.circleId).eq("type", category.type).eq("nameLower", nameLower),
        )
        .first();
      if (existing && existing._id !== category._id) {
        throw duplicateCategoryNameError();
      }
      patch.name = input.name;
      patch.nameLower = nameLower;
      changes.push({ field: "name", from: category.name, to: input.name });
    }

    if (input.color !== undefined && input.color !== category.color) {
      patch.color = input.color;
      // Frozen display labels, never the raw color id (ADR 0018).
      changes.push({
        field: "color",
        from: colorLabel(category.color),
        to: colorLabel(input.color),
      });
    }

    // No real change ⇒ a true no-op: no patch, no spurious history.
    if (changes.length === 0) {
      return args.categoryId;
    }

    await ctx.db.patch(category._id, patch);

    await recordEvent(ctx, {
      entity: categoryEntity(category._id),
      actor: access.membership,
      action: "edited",
      changes,
    });

    return args.categoryId;
  },
});

/**
 * Archives a Category — removes it from future Transaction selection without
 * deleting it (CAT-2; PRD stories 54, 57, 58). An Archived Category stays attached
 * to historical Transactions and stays usable as a filter, but cannot be NEWLY
 * added to Transactions (TXN-1/2 enforce that side), and its name stays reserved
 * until restored, so historical meaning is never split.
 *
 * Flow: `requireCategoryAccess` → `assertWritable` (an archived Circle is
 * read-only, so neither archive nor restore works there) → permission:
 * `canArchive` = the creator OR the Owner. This is deliberately a DIFFERENT
 * predicate than `isCreator` (which gates field edits): the Owner moderates
 * lifecycle here but `updateCategory` still rejects an Owner renaming another
 * Member's Category, so archiving never becomes a field-edit backdoor.
 *
 * Archiving an already-archived Category is REJECTED (not a silent no-op) so a
 * stale UI or a lost race surfaces rather than masquerading as success (README §4).
 * Records an `"archived"` event with the moderator as actor and no field changes
 * (the lifecycle flip is the event — ADR 0018).
 */
export const archiveCategory = mutation({
  args: { categoryId: v.id("categories") },
  handler: async (ctx, args) => {
    const access = await requireCategoryAccess(ctx, args.categoryId);
    access.assertWritable(); // an archived Circle is read-only (PRD story 79)

    // The creator OR the Owner may archive (PRD story 56). NOT `isCreator`: the
    // Owner moderates lifecycle without gaining field-edit rights.
    if (!access.canArchive) {
      throw new Error("Only the creator or the owner can archive this category");
    }

    const category = access.category;
    // Reject a redundant archive rather than silently succeeding — a no-op would
    // hide a stale UI or a concurrent race (README §4 no silent failures).
    if (category.status !== "active") {
      throw new Error("Category is already archived");
    }

    await ctx.db.patch(category._id, { status: "archived", archivedAt: Date.now() });

    await recordEvent(ctx, {
      entity: categoryEntity(category._id),
      actor: access.membership, // the moderator who archived it
      action: "archived",
      changes: [],
    });

    await notifyCategoryLifecycleChange(ctx, {
      creatorUserId: category.creatorUserId,
      actorUserId: access.user._id,
      actorDisplayName: access.membership.displayName,
      circle: access.circle,
      category,
      action: "archived",
    });

    return args.categoryId;
  },
});

/**
 * Restores an Archived Category back to active (CAT-2; PRD story 58) — it becomes
 * selectable on Transactions again and editable by its creator. The mirror of
 * {@link archiveCategory}: same `canArchive` permission (creator or Owner), same
 * `assertWritable`, and the same anti-enumeration "Category not found".
 *
 * Restore re-checks the name invariant defensively: `createCategory` reserves
 * archived names, so an active same-name Category shouldn't exist — but if one
 * somehow does, restoring must fail rather than seat two active Categories on one
 * name (the uniqueness invariant stays airtight). Restoring a Category that is
 * already active is REJECTED for the same no-silent-failure reason archiving a
 * redundant one is. Records a `"restored"` event with the moderator as actor and
 * no field changes, and clears `archivedAt`.
 */
export const restoreCategory = mutation({
  args: { categoryId: v.id("categories") },
  handler: async (ctx, args) => {
    const access = await requireCategoryAccess(ctx, args.categoryId);
    access.assertWritable(); // an archived Circle is read-only (PRD story 79)

    if (!access.canArchive) {
      throw new Error("Only the creator or the owner can restore this category");
    }

    const category = access.category;
    if (category.status !== "archived") {
      throw new Error("Category is not archived");
    }

    // Defensive collision re-check: any OTHER Category holding this name (in this
    // Circle+type, any status) blocks the restore. The index range is one exact
    // nameLower key — bounded by construction, not an unbounded scan.
    const sameName = await ctx.db
      .query("categories")
      .withIndex("by_circle_type_name", (q) =>
        q
          .eq("circleId", category.circleId)
          .eq("type", category.type)
          .eq("nameLower", category.nameLower),
      )
      .collect();
    if (sameName.some((other) => other._id !== category._id)) {
      throw duplicateCategoryNameError();
    }

    // Setting `archivedAt` to undefined removes the field (it is schema-optional).
    await ctx.db.patch(category._id, { status: "active", archivedAt: undefined });

    await recordEvent(ctx, {
      entity: categoryEntity(category._id),
      actor: access.membership, // the moderator who restored it
      action: "restored",
      changes: [],
    });

    await notifyCategoryLifecycleChange(ctx, {
      creatorUserId: category.creatorUserId,
      actorUserId: access.user._id,
      actorDisplayName: access.membership.displayName,
      circle: access.circle,
      category,
      action: "restored",
    });

    return args.categoryId;
  },
});

/**
 * One newest-first page of a Category's **Category History** (CAT-2; PRD story 78)
 * — the immutable created / edited / archived / restored events with the acting
 * Member, changed field names, and old/new values. Any current Member of the
 * Circle may view it, for an Archived Category too (history is a read surface).
 *
 * The exact mirror of `listTransactionHistory` (TXN-4), reusing the same
 * `paginateEntityHistory` read over the `by_entity` index (README §4: history is
 * unbounded-growth, so it must never `.collect()` the whole audit) and the same
 * shared event view, so the web's `HistoryList` renders both.
 *
 * Anti-enumeration (ADR 0016): a malformed id, a missing Category, an inaccessible
 * Circle, or a wrong-Circle Category all return the same empty, exhausted page —
 * indistinguishable from a Category with no history, so nothing leaks. (A paginated
 * query returns an empty page rather than `null` so `usePaginatedQuery` stays on
 * its normal lifecycle, exactly like the Transaction History read.)
 */
export const listCategoryHistory = query({
  args: {
    circleId: v.string(),
    categoryId: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const emptyPage = { page: [], isDone: true, continueCursor: "" };
    const categoryId = ctx.db.normalizeId("categories", args.categoryId);
    const circleId = ctx.db.normalizeId("circles", args.circleId);
    if (!categoryId || !circleId) {
      return emptyPage;
    }
    const access = await resolveCircleAccess(ctx, circleId);
    if (!access) {
      return emptyPage;
    }
    const category = await ctx.db.get(categoryId);
    if (!category || category.circleId !== circleId) {
      return emptyPage;
    }
    const result = await paginateEntityHistory(
      ctx,
      categoryEntity(categoryId),
      args.paginationOpts,
    );
    const cache = newActorCache();
    const page = await Promise.all(
      result.page.map((event) => toHistoryEventView(ctx, event, cache)),
    );
    return { ...result, page };
  },
});
