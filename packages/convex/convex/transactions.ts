import {
  buildRef,
  isSupportedCurrency,
  isValidPlainMonth,
  MUTATION_ERRORS,
  monthOf,
  mutationErrorData,
  type TransactionType,
  toCurrencyCode,
  transactionCreateSchema,
  transactionUpdateSchema,
} from "@pocketcircle/domain";
import { type PaginationOptions, paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { type MutationCtx, mutation, type QueryCtx, query } from "./_generated/server.js";
import { markActivationMilestone } from "./activation.js";
import {
  type AuthorizedCircle,
  type AuthorizedTransaction,
  requireCircleAccess,
  requireTransactionAccess,
  resolveCircleAccess,
} from "./guard.js";
import {
  type HistoryChange,
  latestEntityEvent,
  moneyChange,
  paginateEntityHistory,
  recordEvent,
  transactionEntity,
} from "./history.js";
import { newActorCache, toHistoryEventView } from "./historyView.js";
import { isEffectiveActiveMember, resolveMemberIdentity } from "./memberIdentity.js";
import { monthDateRange } from "./monthActivity.js";
import { notifyPaidBySet, notifyTransactionLifecycleChange } from "./notify.js";
import type { OperationReader } from "./operationReader.js";
import { syncTransactionSearchDocument } from "./transactionSearchDocuments.js";

const transactionType = v.union(v.literal("expense"), v.literal("income"));
const lifecycleStatus = v.union(v.literal("active"), v.literal("archived"));

interface MemberRef {
  id: Id<"members">;
  displayName: string;
  image?: string;
}
interface CategoryRef {
  id: Id<"categories">;
  name: string;
  color: string;
}

/**
 * Per-query lookup caches. A Transaction list repeats the same Paid By / Recorded
 * By Member and the same Categories across many rows, so resolving each id once
 * and reusing it collapses the otherwise-N+1 reads in {@link toTransactionView}.
 * Scoped to a single query call — never shared across requests.
 */
export interface ViewCaches {
  members: Map<Id<"members">, MemberRef>;
  categories: Map<Id<"categories">, CategoryRef | null>;
}

export function newViewCaches(): ViewCaches {
  return { members: new Map(), categories: new Map() };
}

/**
 * Resolves a Member's materialized identity (Display Name + image) for display,
 * memoized per query. Reads the frozen-on-removal `members` row directly (ADR
 * 0018) — current for an active Member, frozen for a Removed one — so a
 * later-removed Paid By keeps the name it had, with no join to live User rows.
 */
async function memberRef(
  ctx: OperationReader,
  memberId: Id<"members">,
  caches: ViewCaches,
): Promise<MemberRef> {
  const cached = caches.members.get(memberId);
  if (cached) {
    return cached;
  }
  const member = await ctx.db.get(memberId);
  if (!member) {
    const ref: MemberRef = {
      id: memberId,
      displayName: "Unknown member",
    };
    caches.members.set(memberId, ref);
    return ref;
  }
  const identity = await resolveMemberIdentity(ctx, member);
  const ref: MemberRef = {
    id: memberId,
    displayName: identity.displayName,
    image: identity.image,
  };
  caches.members.set(memberId, ref);
  return ref;
}

/** Member display name for export surfaces — same frozen-on-removal read as {@link toTransactionView}. */
export async function memberDisplayName(
  ctx: QueryCtx,
  memberId: Id<"members">,
  caches: ViewCaches,
) {
  return (await memberRef(ctx, memberId, caches)).displayName;
}

/** Category name for export surfaces — preserves archived attachments. */
export async function categoryDisplayName(
  ctx: QueryCtx,
  categoryId: Id<"categories">,
  caches: ViewCaches,
) {
  const category = await categoryRef(ctx, categoryId, caches);
  return category?.name ?? null;
}

/** Resolves a Category to its display fields, memoized per query. */
async function categoryRef(
  ctx: OperationReader,
  categoryId: Id<"categories">,
  caches: ViewCaches,
): Promise<CategoryRef | null> {
  if (caches.categories.has(categoryId)) {
    return caches.categories.get(categoryId) ?? null;
  }
  const category = await ctx.db.get(categoryId);
  const ref: CategoryRef | null = category
    ? { id: category._id, name: category.name, color: category.color }
    : null;
  caches.categories.set(categoryId, ref);
  return ref;
}

/**
 * A Transaction shaped for the client. Money is surfaced both as raw minor units
 * (for exact client-side sums — ADR 0009) and resolved identity/category names so
 * the UI attributes the Transaction without re-resolving. Categories are read
 * through the `transactionCategories` join, including any already-attached
 * archived Category (historical attachments are preserved — PRD story 57). Member
 * and Category lookups are memoized through `caches` to avoid re-reading the same
 * row across a list.
 *
 * `canEditFields` is resolved HERE against the viewer's Member: only the Recorded By
 * Member may edit a Transaction's fields (TXN-2), and because it compares to the
 * caller's stable member row, a Removed→rejoined User regains it automatically (PRD
 * 44). `canArchive` is the TXN-3 counterpart — the Recorded By Member OR the Owner may
 * archive/restore it (the Owner moderates lifecycle without gaining field edit, so the
 * two flags are deliberately distinct). The UI gates its affordances on these flags,
 * but the server re-checks on every mutation — they are the courtesy, not the
 * enforcement (ADR 0015), matching the `requireTransactionAccess` predicates in `guard.ts`.
 */
export async function toTransactionView(
  ctx: OperationReader,
  txn: Doc<"transactions">,
  caches: ViewCaches,
  viewerMemberId: Id<"members">,
  viewerIsOwner: boolean,
) {
  const links = await ctx.db
    .query("transactionCategories")
    .withIndex("by_transaction", (q) => q.eq("transactionId", txn._id))
    .collect();
  const categories: CategoryRef[] = [];
  for (const link of links) {
    const category = await categoryRef(ctx, link.categoryId, caches);
    if (category) {
      categories.push(category);
    }
  }

  return {
    id: txn._id,
    // The canonical "slug-id" ref (ADR 0016): the ledger row links its Edit action
    // to `/transactions/<ref>/edit`, and the edit-target resolver returns it so a
    // stale title slug in the URL canonicalizes (TXN-5). Built from the SAME title +
    // id the view already carries, so the link and the resolved object never disagree.
    ref: buildRef(txn.title, txn._id),
    type: txn.type,
    title: txn.title,
    note: txn.note,
    amountMinorUnits: txn.amountMinorUnits,
    date: txn.date,
    month: txn.month,
    status: txn.status,
    recordedBy: await memberRef(ctx, txn.recordedByMemberId, caches),
    paidBy: await memberRef(ctx, txn.paidByMemberId, caches),
    categories,
    canEditFields: txn.recordedByMemberId === viewerMemberId,
    canArchive: txn.recordedByMemberId === viewerMemberId || viewerIsOwner,
  };
}

export type TransactionView = Awaited<ReturnType<typeof toTransactionView>>;

/**
 * A Transaction shaped for its DETAIL surface (TXN-4): the full {@link toTransactionView}
 * plus its **Audit Metadata** (PRD story 76). Audit Metadata is the created/updated
 * by+at summary that sits above the full Transaction History list:
 *
 *   - `createdBy` is the Recorded By Member (the Member who created the record — by
 *     definition Recorded By), `createdAt` the stored creation instant.
 *   - `updatedBy` / `updatedAt` come from the NEWEST history event — the last Member to
 *     change the record and when — so the pair is always internally consistent (both
 *     read from the same event), and reflects lifecycle changes (archive/restore) too,
 *     not just field edits. A record with no history yet (only possible for a directly
 *     seeded row, never through the create mutation) falls back to the created pair.
 *
 * Timestamps are epoch millis (no stored offset — domain/date.ts notes audit/history
 * timestamps are epoch millis) surfaced RAW. The view never converts them to a zone:
 * the client renders them in a fixed reference zone, never the viewer's timezone
 * (Audit Metadata glossary), so the value crossing the seam stays presentation-free.
 * No raw IDs leak — only Display Names and timestamps appear.
 */
export async function toTransactionDetailView(
  ctx: OperationReader,
  txn: Doc<"transactions">,
  caches: ViewCaches,
  viewerMemberId: Id<"members">,
  viewerIsOwner: boolean,
) {
  const base = await toTransactionView(ctx, txn, caches, viewerMemberId, viewerIsOwner);
  const latest = await latestEntityEvent(ctx, transactionEntity(txn._id, txn.circleId));
  const updatedBy =
    latest?.actorMemberId != null
      ? await memberRef(ctx, latest.actorMemberId, caches)
      : base.recordedBy;
  return {
    ...base,
    audit: {
      createdBy: base.recordedBy,
      createdAt: txn.createdAt,
      updatedBy,
      updatedAt: latest?.createdAt ?? txn.updatedAt,
    },
  };
}

export type TransactionDetailView = Awaited<ReturnType<typeof toTransactionDetailView>>;

/**
 * Lists a Circle's Transactions of one lifecycle status, most recent first
 * (Transaction Date desc, then created-at desc via `_creationTime` — the Monthly
 * Ledger sort, PRD story 64). Paginated at the source off `by_circle_status_date`:
 * the database returns one ordered page, so nothing unbounded is ever loaded or
 * sorted in memory. This is the read TXN-1 needs to confirm a create landed and the
 * list half of the Monthly Ledger (RPT-1).
 *
 * `status` defaults to `"active"` — the normal surface that EXCLUDES archived
 * Transactions (TXN-3: archived ⇒ excluded unless a view explicitly asks for them).
 * Passing `"archived"` is the dedicated archived view the Restore affordance reads
 * from (TXN-3); it ranges the SAME index by the `archived` status prefix, so it is
 * equally bounded and index-backed — never a `.filter()` over the whole table. The
 * Search/Dashboard archive *filters* (RPT-2/RPT-3) build on this same contract.
 *
 * An optional `month` ("YYYY-MM") scopes the page to one month by ranging the SAME
 * date-ordered index to `[month, next-month)` — the Ledger's month-scoped list
 * (RPT-1). The range is applied at the source (never an in-memory `month` filter
 * over an unbounded set — README §4), and because the index already orders by
 * date the page stays date-desc within the month with no extra sort. The Ledger's
 * income/expense/net totals are a separate bounded aggregate (`ledger.getMonthlyLedger`):
 * `usePaginatedQuery` can't carry totals alongside a page, and the totals must sum
 * the WHOLE month while the list only resolves the visible page, so they are two
 * reads fused on the client into the slice's `{ transactions, totals }` surface.
 *
 * Anti-enumeration (ADR 0016): an inaccessible or missing Circle returns an empty,
 * exhausted page — indistinguishable from an accessible Circle with no
 * Transactions, so nothing about the Circle's existence leaks.
 */
export async function paginateCircleTransactionsForAccess(
  ctx: OperationReader,
  access: AuthorizedCircle,
  paginationOpts: PaginationOptions,
  args: { month?: string; status?: "active" | "archived" },
) {
  const status = args.status ?? "active";
  const range = args.month !== undefined ? monthDateRange(args.month) : undefined;

  const result = await ctx.db
    .query("transactions")
    .withIndex("by_circle_status_date", (q) => {
      const scoped = q.eq("circleId", access.circle._id).eq("status", status);
      return range ? scoped.gte("date", range.start).lt("date", range.endExclusive) : scoped;
    })
    .order("desc")
    .paginate(paginationOpts);

  const caches = newViewCaches();
  const page = await Promise.all(
    result.page.map((txn) =>
      toTransactionView(ctx, txn, caches, access.membership._id, access.isOwner),
    ),
  );
  return { ...result, page };
}

export const listTransactions = query({
  args: {
    circleId: v.id("circles"),
    paginationOpts: paginationOptsValidator,
    month: v.optional(v.string()),
    status: v.optional(lifecycleStatus),
  },
  handler: async (ctx, args) => {
    const access = await resolveCircleAccess(ctx, args.circleId);
    if (!access) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    if (args.month !== undefined && !isValidPlainMonth(args.month)) {
      throw new Error("Invalid month");
    }
    return paginateCircleTransactionsForAccess(ctx, access, args.paginationOpts, {
      month: args.month,
      status: args.status ?? "active",
    });
  },
});

/**
 * Resolves the edit TARGET behind `/circles/:circleRef/transactions/:transactionRef/edit`
 * (TXN-5): one Transaction fetched by its authoritative ID, NOT found in the visible
 * ledger page (the target may be off-page or in another month — that is why the Ledger
 * list can't serve it). An edit deep link means "open an editable active Transaction,"
 * so this returns the Transaction view ONLY when the caller may actually field-edit it,
 * and `null` for every other case — missing, inaccessible Circle, the Transaction
 * belonging to a DIFFERENT Circle than the URL's, an archived (frozen) Transaction, or
 * one the caller didn't record. The route adapter feeds that `null` into the shared
 * unavailable-link fallback (ADR 0016/0017), so all of those collapse to the same
 * observable outcome and nothing about the Transaction's existence or another Member's
 * activity leaks.
 *
 * It deliberately does NOT grant the Owner edit access through this path: the Owner
 * moderates lifecycle (archive/restore — TXN-3) but may not rewrite another Member's
 * fields (PRD story 38), matching `updateTransaction`'s `isRecorder` gate (ADR 0015) —
 * the server stays the authority and this read mirrors it so the UI never opens a form
 * a save would reject. An archived Circle is handled a layer up (the route surfaces
 * read-only in place rather than ejecting), so this resolver does not special-case it.
 *
 * Both ids arrive as raw strings (the `circleId` from the resolved Circle, the
 * `transactionId` from the URL ref) and normalize to `null` when malformed — the same
 * uniform unavailable outcome as a missing row (ADR 0016), never a throw.
 */
export const getEditableTransaction = query({
  args: { circleId: v.string(), transactionId: v.string() },
  handler: async (ctx, args) => {
    const transactionId = ctx.db.normalizeId("transactions", args.transactionId);
    const circleId = ctx.db.normalizeId("circles", args.circleId);
    if (!transactionId || !circleId) {
      return null;
    }
    const access = await resolveCircleAccess(ctx, circleId);
    if (!access) {
      return null;
    }
    const txn = await ctx.db.get(transactionId);
    // Wrong Circle, missing, archived (frozen), or not recorded by the caller all
    // collapse to the same `null` — anti-enumeration parity with an inaccessible
    // Circle (ADR 0016). Only the Recorded By Member may edit fields (PRD story 38).
    if (
      !txn ||
      txn.circleId !== circleId ||
      txn.status !== "active" ||
      txn.recordedByMemberId !== access.membership._id
    ) {
      return null;
    }
    return toTransactionView(ctx, txn, newViewCaches(), access.membership._id, access.isOwner);
  },
});

/**
 * Resolves the Transaction DETAIL surface behind the object route
 * `/circles/:circleRef/transactions/:transactionRef` (TXN-4) — the read-only view ANY
 * current Member may see, with its Audit Metadata (PRD stories 76, 80). The mirror of
 * the Circle guard's `getCircle`: both ids arrive as raw strings (the `circleId` from
 * the resolved Circle, the `transactionId` from the URL ref) and `normalizeId` to
 * `null` when malformed — the uniform unavailable outcome (ADR 0016), never a throw.
 *
 * Unlike {@link getEditableTransaction} (which gates on the Recorded By Member and an
 * active status because an edit link means "open an editable active Transaction"), this
 * is a READ surface: it resolves for any Member of the Circle and for an ARCHIVED
 * (frozen) Transaction too — a Member can view the detail + history of an Archived
 * Transaction. It still returns the `canEdit`/`canArchive` capability flags so the
 * detail UI can offer the lifecycle affordances the viewer is allowed (the server
 * re-checks every mutation — ADR 0015).
 *
 * Anti-enumeration (ADR 0016): a malformed id, a missing Transaction, an inaccessible
 * Circle, and a Transaction belonging to a DIFFERENT Circle than the URL's all collapse
 * to the same `null`, so nothing about a Transaction's existence or another Member's
 * activity leaks. The route adapter feeds that `null` into the shared unavailable-link
 * fallback.
 */
export const getTransaction = query({
  args: { circleId: v.string(), transactionId: v.string() },
  handler: async (ctx, args) => {
    const transactionId = ctx.db.normalizeId("transactions", args.transactionId);
    const circleId = ctx.db.normalizeId("circles", args.circleId);
    if (!transactionId || !circleId) {
      return null;
    }
    const access = await resolveCircleAccess(ctx, circleId);
    if (!access) {
      return null;
    }
    const txn = await ctx.db.get(transactionId);
    // Wrong Circle or missing collapse to the same `null` as an inaccessible Circle
    // (ADR 0016). An archived Transaction is NOT excluded here — detail is a read
    // surface, unlike the edit-target resolver.
    if (!txn || txn.circleId !== circleId) {
      return null;
    }
    return toTransactionDetailView(
      ctx,
      txn,
      newViewCaches(),
      access.membership._id,
      access.isOwner,
    );
  },
});

/**
 * One newest-first page of a Transaction's **Transaction History** for its detail
 * surface (TXN-4; PRD stories 77, 80) — the immutable created / edited / archived /
 * restored events with the acting Member, changed field names, and old/new values.
 *
 * Paginated at the source via {@link paginateEntityHistory} over the `by_entity` index
 * (README §4: history is unbounded-growth, so it must never `.collect()` the whole
 * audit). Behind the same Circle access check as {@link getTransaction}, and the same
 * anti-enumeration parity as `listTransactions`: a malformed id, missing Transaction,
 * inaccessible Circle, or wrong-Circle Transaction all return an empty, exhausted page —
 * indistinguishable from a Transaction with no history beyond its creation, so nothing
 * leaks (ADR 0016). (A paginated query returns an empty page rather than `null` so
 * `usePaginatedQuery` stays on its normal lifecycle — the detail route's `getTransaction`
 * guard already ejects an inaccessible Circle before this renders.)
 *
 * Values are frozen DISPLAY-safe values already written by TXN-1/2/3 (ADR 0018/0021):
 * text `from`/`to` are plain strings, money fields carry typed `{minorUnits, currency}`
 * for the client to render in the viewer locale. The view never re-resolves raw entity
 * IDs — no raw IDs appear because the writers never stored them (PRD story 80). Only the
 * actor's frozen Display Name + image are resolved per event, memoized to avoid an N+1.
 */
export const listTransactionHistory = query({
  args: {
    circleId: v.string(),
    transactionId: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const emptyPage = { page: [], isDone: true, continueCursor: "" };
    const transactionId = ctx.db.normalizeId("transactions", args.transactionId);
    const circleId = ctx.db.normalizeId("circles", args.circleId);
    if (!transactionId || !circleId) {
      return emptyPage;
    }
    const access = await resolveCircleAccess(ctx, circleId);
    if (!access) {
      return emptyPage;
    }
    const txn = await ctx.db.get(transactionId);
    if (!txn || txn.circleId !== circleId) {
      return emptyPage;
    }
    const result = await paginateEntityHistory(
      ctx,
      transactionEntity(transactionId, access.circle._id),
      args.paginationOpts,
    );
    // The event view is the shared, entity-agnostic one (historyView.ts) — the same
    // shape Category History (CAT-2) and Circle History (CS-4) page through.
    const cache = newActorCache();
    const page = await Promise.all(
      result.page.map((event) => toHistoryEventView(ctx, event, cache)),
    );
    return { ...result, page };
  },
});

/**
 * Asserts a Member id names a CURRENT active Member of `circleId`, returning the
 * row. The single home of the Paid By rule shared by create and edit (PRD stories
 * 36, 37): a Removed Member or a Member of another Circle is rejected — historical
 * preservation of a later-removed Paid By is the frozen `members` identity's job,
 * not a license to NEWLY assign a removed Member.
 */
async function requireCurrentMember(
  ctx: MutationCtx,
  circleId: Id<"circles">,
  memberId: Id<"members">,
): Promise<Doc<"members">> {
  const member = await ctx.db.get(memberId);
  if (!member || member.circleId !== circleId || !(await isEffectiveActiveMember(ctx, member))) {
    throw new ConvexError(mutationErrorData(MUTATION_ERRORS.transactionPaidByInvalid));
  }
  return member;
}

/**
 * Resolves and validates the Categories for a Transaction of `type`, the single
 * home of the Category rules shared by create and edit. Each id must name a
 * Category of THIS Circle and matching type; ≥1 / no-duplicate is already enforced
 * by the Zod schema, and order is preserved for a stable history string.
 *
 * `alreadyAttached` is the set of Categories currently on the Transaction: an
 * archived Category may only stay if it was already attached (PRD story 57 — an
 * edit keeps already-attached archived Categories but cannot NEWLY add one). Pass
 * an empty set for a create or a Transaction Type Change, where every Category is
 * new and therefore must be active.
 */
async function resolveCategories(
  ctx: MutationCtx,
  opts: {
    circleId: Id<"circles">;
    categoryIds: Id<"categories">[];
    type: TransactionType;
    alreadyAttached: ReadonlySet<Id<"categories">>;
  },
): Promise<Doc<"categories">[]> {
  const categories: Doc<"categories">[] = [];
  for (const categoryId of opts.categoryIds) {
    const category = await ctx.db.get(categoryId);
    if (!category || category.circleId !== opts.circleId) {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.transactionCategoryNotFound));
    }
    if (category.type !== opts.type) {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.transactionCategoryTypeMismatch));
    }
    if (category.status !== "active" && !opts.alreadyAttached.has(category._id)) {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.transactionCategoryArchived));
    }
    categories.push(category);
  }
  return categories;
}

/** Replaces a Transaction's Category links with `categoryIds`, in order. */
async function rewriteTransactionCategories(
  ctx: MutationCtx,
  circleId: Id<"circles">,
  transactionId: Id<"transactions">,
  categoryIds: Id<"categories">[],
  ordering: { transactionDate: string; transactionCreatedAt: number },
): Promise<void> {
  const existing = await ctx.db
    .query("transactionCategories")
    .withIndex("by_transaction", (q) => q.eq("transactionId", transactionId))
    .collect();
  for (const link of existing) {
    await ctx.db.delete(link._id);
  }
  for (const categoryId of categoryIds) {
    await ctx.db.insert("transactionCategories", {
      circleId,
      transactionId,
      categoryId,
      transactionDate: ordering.transactionDate,
      transactionCreatedAt: ordering.transactionCreatedAt,
    });
  }
}

/** Keeps denormalized ordering fields on join rows in sync when a Transaction's date changes. */
async function syncTransactionCategoryOrderingFields(
  ctx: MutationCtx,
  transaction: Doc<"transactions">,
): Promise<void> {
  const links = await ctx.db
    .query("transactionCategories")
    .withIndex("by_transaction", (q) => q.eq("transactionId", transaction._id))
    .collect();
  for (const link of links) {
    await ctx.db.patch(link._id, {
      transactionDate: transaction.date,
      transactionCreatedAt: transaction.createdAt,
    });
  }
}

/** Args shared by the public mutation, MCP bridge, and explicit-User update paths. */
export type PerformUpdateTransactionArgs = {
  type?: TransactionType;
  title?: string;
  note?: string;
  amountMinorUnits?: number;
  date?: string;
  categoryIds?: Id<"categories">[];
  paidByMemberId?: Id<"members">;
};

/**
 * Core update-Transaction write shared by the browser mutation and MCP (#326).
 * Caller must already hold {@link AuthorizedTransaction} with writable,
 * setup-complete, Recorded By, and active-transaction checks applied.
 */
export async function performUpdateTransaction(
  ctx: MutationCtx,
  access: AuthorizedTransaction,
  args: PerformUpdateTransactionArgs,
) {
  const txn = access.transaction;

  const input = transactionUpdateSchema.parse({
    type: args.type,
    title: args.title,
    note: args.note,
    date: args.date,
    amountMinorUnits: args.amountMinorUnits,
    categoryIds: args.categoryIds,
    paidByMemberId: args.paidByMemberId,
  });

  const currency = toCurrencyCode(access.circle.currency);
  const patch: Partial<Doc<"transactions">> = {};
  const changes: HistoryChange[] = [];

  const newType = input.type ?? txn.type;
  const typeChanges = newType !== txn.type;

  if (typeChanges && args.categoryIds === undefined) {
    throw new Error("Changing the transaction type requires categories of the new type");
  }

  const existingLinks = await ctx.db
    .query("transactionCategories")
    .withIndex("by_transaction", (q) => q.eq("transactionId", txn._id))
    .collect();
  const oldCategoryIds = existingLinks.map((link) => link.categoryId);

  let categoriesChanged = false;
  let newCategories: Doc<"categories">[] = [];
  if (args.categoryIds !== undefined) {
    newCategories = await resolveCategories(ctx, {
      circleId: txn.circleId,
      categoryIds: args.categoryIds,
      type: newType,
      alreadyAttached: typeChanges ? new Set<Id<"categories">>() : new Set(oldCategoryIds),
    });
    const sameSet =
      args.categoryIds.length === oldCategoryIds.length &&
      args.categoryIds.every((id) => oldCategoryIds.includes(id));
    categoriesChanged = typeChanges || !sameSet;
  }

  if (typeChanges) {
    patch.type = newType;
    changes.push({ field: "type", from: txn.type, to: newType });
  }

  if (input.title !== undefined && input.title !== txn.title) {
    patch.title = input.title;
    changes.push({ field: "title", from: txn.title, to: input.title });
  }

  if (input.amountMinorUnits !== undefined && input.amountMinorUnits !== txn.amountMinorUnits) {
    patch.amountMinorUnits = input.amountMinorUnits;
    changes.push(
      moneyChange(
        "amount",
        { minorUnits: input.amountMinorUnits, currency },
        { minorUnits: txn.amountMinorUnits, currency },
      ),
    );
  }

  if (input.date !== undefined && input.date !== txn.date) {
    patch.date = input.date;
    patch.month = monthOf(input.date);
    changes.push({ field: "date", from: txn.date, to: input.date });
  }

  if (args.paidByMemberId !== undefined && args.paidByMemberId !== txn.paidByMemberId) {
    const newPaidBy = await requireCurrentMember(ctx, txn.circleId, args.paidByMemberId);
    const oldPaidBy = await ctx.db.get(txn.paidByMemberId);
    patch.paidByMemberId = newPaidBy._id;
    changes.push({
      field: "paidBy",
      from: oldPaidBy?.displayName ?? "Unknown member",
      to: newPaidBy.displayName,
    });
  }

  if (input.note !== undefined) {
    const newNote = input.note.length > 0 ? input.note : undefined;
    if (newNote !== txn.note) {
      patch.note = newNote;
      changes.push({
        field: "note",
        ...(txn.note ? { from: txn.note } : {}),
        ...(newNote ? { to: newNote } : {}),
      });
    }
  }

  if (categoriesChanged) {
    const oldNames = (await Promise.all(oldCategoryIds.map((id) => ctx.db.get(id)))).flatMap(
      (category) => (category ? [category.name] : []),
    );
    changes.push({
      field: "categories",
      from: oldNames.join(", "),
      to: newCategories.map((category) => category.name).join(", "),
    });
  }

  if (changes.length === 0) {
    return txn._id;
  }

  patch.updatedAt = Date.now();
  await ctx.db.patch(txn._id, patch);
  const updatedTransaction = await ctx.db.get(txn._id);
  if (!updatedTransaction) {
    throw new Error("Transaction not found");
  }

  if (categoriesChanged) {
    await rewriteTransactionCategories(
      ctx,
      txn.circleId,
      txn._id,
      newCategories.map((category) => category._id),
      {
        transactionDate: updatedTransaction.date,
        transactionCreatedAt: updatedTransaction.createdAt,
      },
    );
  } else if (input.date !== undefined && input.date !== txn.date) {
    await syncTransactionCategoryOrderingFields(ctx, updatedTransaction);
  }
  await syncTransactionSearchDocument(ctx, updatedTransaction, {
    categoryIds: categoriesChanged ? newCategories.map((category) => category._id) : oldCategoryIds,
  });

  await recordEvent(ctx, {
    entity: transactionEntity(txn._id, txn.circleId),
    actor: access.membership,
    action: typeChanges ? "type changed" : "edited",
    changes,
  });

  return txn._id;
}

/** Args shared by the public mutation and explicit-User create paths. */
export type PerformCreateTransactionArgs = {
  type: TransactionType;
  title: string;
  note?: string;
  amountMinorUnits: number;
  date: string;
  categoryIds: Id<"categories">[];
  paidByMemberId?: Id<"members">;
  expectedCurrency: string;
};

/**
 * Core create-Transaction write shared by the browser mutation and MCP (#325).
 * Caller must already hold {@link AuthorizedCircle} with writable, setup-complete
 * checks applied.
 */
export async function performCreateTransaction(
  ctx: MutationCtx,
  access: AuthorizedCircle,
  args: PerformCreateTransactionArgs,
) {
  const circleCurrency = toCurrencyCode(access.circle.currency);
  if (!isSupportedCurrency(args.expectedCurrency)) {
    throw new ConvexError(mutationErrorData(MUTATION_ERRORS.currencyUnsupported));
  }
  if (args.expectedCurrency !== circleCurrency) {
    throw new ConvexError(mutationErrorData(MUTATION_ERRORS.currencyChanged));
  }

  const input = transactionCreateSchema.parse({
    type: args.type,
    title: args.title,
    note: args.note,
    amountMinorUnits: args.amountMinorUnits,
    date: args.date,
    categoryIds: args.categoryIds,
    paidByMemberId: args.paidByMemberId,
  });

  const recordedByMemberId = access.membership._id;

  let paidByMember = access.membership;
  if (args.paidByMemberId && args.paidByMemberId !== recordedByMemberId) {
    paidByMember = await requireCurrentMember(ctx, access.circle._id, args.paidByMemberId);
  }

  const categories = await resolveCategories(ctx, {
    circleId: access.circle._id,
    categoryIds: args.categoryIds,
    type: input.type,
    alreadyAttached: new Set<Id<"categories">>(),
  });

  const note = input.note && input.note.length > 0 ? input.note : undefined;
  const now = Date.now();

  const transactionId = await ctx.db.insert("transactions", {
    circleId: access.circle._id,
    type: input.type,
    title: input.title,
    ...(note ? { note } : {}),
    amountMinorUnits: input.amountMinorUnits,
    date: input.date,
    month: monthOf(input.date),
    recordedByMemberId,
    paidByMemberId: paidByMember._id,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });

  for (const category of categories) {
    await ctx.db.insert("transactionCategories", {
      circleId: access.circle._id,
      transactionId,
      categoryId: category._id,
      transactionDate: input.date,
      transactionCreatedAt: now,
    });
  }
  const createdTransaction = await ctx.db.get(transactionId);
  if (!createdTransaction) {
    throw new Error("Transaction not found");
  }
  await syncTransactionSearchDocument(ctx, createdTransaction, {
    categoryIds: categories.map((category) => category._id),
  });

  if (!access.circle.currencyLocked) {
    await ctx.db.patch(access.circle._id, { currencyLocked: true });
  }

  await markActivationMilestone(ctx, access.user._id, "transactionCreatedAt", now);

  const changes: HistoryChange[] = [
    { field: "type", to: input.type },
    { field: "title", to: input.title },
    moneyChange("amount", {
      minorUnits: input.amountMinorUnits,
      currency: toCurrencyCode(access.circle.currency),
    }),
    { field: "date", to: input.date },
    { field: "paidBy", to: paidByMember.displayName },
    { field: "categories", to: categories.map((category) => category.name).join(", ") },
  ];
  if (note) {
    changes.push({ field: "note", to: note });
  }

  await recordEvent(ctx, {
    entity: transactionEntity(transactionId, access.circle._id),
    actor: access.membership,
    action: "created",
    changes,
  });

  if (paidByMember._id !== recordedByMemberId) {
    await notifyPaidBySet(ctx, {
      paidByUserId: paidByMember.userId,
      actorUserId: access.user._id,
      actorDisplayName: access.membership.displayName,
      circle: access.circle,
      transaction: createdTransaction,
    });
  }

  return transactionId;
}

/**
 * Creates an Expense or Income Transaction in a Circle (the core write of the
 * product — PRD stories 27–37, 50–52). The money/date/identity/category
 * invariants are all enforced HERE server-side (ADR 0015); the form's filtering
 * is a courtesy on top.
 *
 * Flow: `requireCircleAccess` → `assertWritable` (archived Circle is read-only) →
 * validate the shared input (Zod) → resolve Recorded By = the caller's Member →
 * default Paid By to Recorded By, else assert it's a current active Member of THIS
 * Circle → validate each Category (this Circle, matching type, active, ≥1, no
 * dup) → insert the Transaction + its category links → flip the Circle's Currency
 * lock (CS-3 owns enforcement; creating the first Transaction is the trigger) →
 * record the create event with pre-formatted human strings (ADR 0018).
 */
export const createTransaction = mutation({
  args: {
    circleId: v.id("circles"),
    type: transactionType,
    title: v.string(),
    note: v.optional(v.string()),
    amountMinorUnits: v.number(),
    date: v.string(),
    categoryIds: v.array(v.id("categories")),
    paidByMemberId: v.optional(v.id("members")),
    /**
     * Currency the client observed when the Amount was drafted (Global Add #298).
     * Rejects when the Circle's Currency has changed underneath so a stale
     * denomination cannot freeze under the new code.
     */
    expectedCurrency: v.string(),
  },
  handler: async (ctx, args) => {
    const access = await requireCircleAccess(ctx, args.circleId);
    access.assertWritable();
    access.assertSetupComplete();
    return performCreateTransaction(ctx, access, args);
  },
});

/**
 * Edits a Transaction's fields, including a Transaction Type Change (TXN-2; PRD
 * stories 29, 30, 38, 42, 44). Every arg is optional — an absent field is left
 * unchanged — and only the fields that actually change are patched and recorded,
 * so a no-op submit writes nothing and leaves no spurious history.
 *
 * Flow: `requireTransactionAccess` (folds in `requireCircleAccess`, ADR 0015) →
 * `assertWritable` (an archived Circle is read-only) → **Recorded By check**: only
 * the Member who recorded it may edit fields — the Owner moderates lifecycle
 * (archive/restore — TXN-3) but cannot rewrite another Member's fields → reject an
 * **archived Transaction** (frozen — PRD 40) → validate changed fields against the
 * shared Zod schema → resolve a changed Paid By to a current Member → resolve
 * Categories → patch + bump `updatedAt`, rewriting Category links only when they
 * changed → `recordEvent` with per-field `from`/`to` (ADR 0018).
 *
 * Type Change is special (PRD 29, 30): it CLEARS the existing Categories (Expense
 * and Income Categories must never mix) and so requires the caller to supply ≥1
 * active Category of the NEW type in the SAME operation, keeping the "≥1 Category
 * of the matching type" invariant unbroken mid-edit. It records `action:"type
 * changed"` with the type from/to and the categories cleared→added; a plain field
 * edit records `action:"edited"`.
 *
 * Anti-enumeration (ADR 0016): a missing Transaction and one whose Circle the
 * caller can't access both throw the same "Transaction not found".
 */
export const updateTransaction = mutation({
  args: {
    transactionId: v.id("transactions"),
    type: v.optional(transactionType),
    title: v.optional(v.string()),
    note: v.optional(v.string()),
    amountMinorUnits: v.optional(v.number()),
    date: v.optional(v.string()),
    categoryIds: v.optional(v.array(v.id("categories"))),
    paidByMemberId: v.optional(v.id("members")),
  },
  handler: async (ctx, args) => {
    const access = await requireTransactionAccess(ctx, args.transactionId);
    access.assertWritable(); // an archived Circle is read-only (PRD story 79)
    access.assertSetupComplete();

    // Only the Recorded By Member edits fields (PRD story 38). The Owner's
    // moderation power is archive/restore (TXN-3), NOT field edits — so this gates
    // on `isRecorder`, not `canArchive`. A Removed Recorded By already failed access
    // above; a rejoined one matches their stable member row and passes (PRD 44).
    if (!access.isRecorder) {
      throw new Error("Only the member who recorded this transaction can edit it");
    }

    const txn = access.transaction;
    // An archived Transaction is frozen — block edits here, never rely on the UI
    // (PRD story 40). TXN-3 owns the archive/restore lifecycle.
    if (txn.status !== "active") {
      throw new Error("Archived transactions can't be edited");
    }

    return performUpdateTransaction(ctx, access, {
      type: args.type,
      title: args.title,
      note: args.note,
      date: args.date,
      amountMinorUnits: args.amountMinorUnits,
      categoryIds: args.categoryIds,
      paidByMemberId: args.paidByMemberId,
    });
  },
});

/**
 * Core archive-Transaction write shared by the browser mutation and MCP (#327).
 * Caller must already hold {@link AuthorizedTransaction} with writable,
 * setup-complete, canArchive, and active-transaction checks applied.
 */
export async function performArchiveTransaction(ctx: MutationCtx, access: AuthorizedTransaction) {
  const txn = access.transaction;
  await ctx.db.patch(txn._id, { status: "archived", archivedAt: Date.now() });
  const archivedTransaction = await ctx.db.get(txn._id);
  if (!archivedTransaction) {
    throw new Error("Transaction not found");
  }
  await syncTransactionSearchDocument(ctx, archivedTransaction);

  await recordEvent(ctx, {
    entity: transactionEntity(txn._id, txn.circleId),
    actor: access.membership,
    action: "archived",
    changes: [],
  });

  const recorder = await ctx.db.get(txn.recordedByMemberId);
  if (recorder) {
    await notifyTransactionLifecycleChange(ctx, {
      recorderUserId: recorder.userId,
      actorUserId: access.user._id,
      actorDisplayName: access.membership.displayName,
      circle: access.circle,
      transaction: archivedTransaction,
      action: "archived",
    });
  }

  return txn._id;
}

/**
 * Archives a Transaction — the moderation / void path that preserves the record
 * instead of deleting it (TXN-3; PRD stories 39, 40, 41, 46). An Archived
 * Transaction is frozen (edits rejected — TXN-2), excluded from Dashboard totals and
 * the default active Ledger/Search, and surfaced only in the dedicated archived view
 * (`listTransactions` with `status:"archived"`) until restored.
 *
 * Flow: `requireTransactionAccess` (folds in `requireCircleAccess`, ADR 0015) →
 * `assertWritable` (an archived Circle is read-only, so neither archive nor restore
 * works there) → permission: `canArchive` = the Recorded By Member OR the Owner.
 * This is deliberately a DIFFERENT predicate than `isRecorder` (which gates field
 * edits): the Owner moderates lifecycle here but `updateTransaction` still rejects an
 * Owner editing another Member's fields, so archiving never becomes a field-edit
 * backdoor (PRD story 39). A Removed creator already failed access above ("Transaction
 * not found"); a rejoined creator matches their stable member row and passes (PRD 44).
 *
 * Archiving an already-archived Transaction is REJECTED (not a silent no-op) so a
 * stale UI or a lost archive-vs-edit race surfaces rather than masquerading as success
 * (README §4 no silent failures; QA-1). Records an `"archived"` event with the
 * moderator as actor and no field changes (the lifecycle flip is the event — ADR 0018).
 *
 * Anti-enumeration (ADR 0016): a missing Transaction and one whose Circle the caller
 * can't access both throw the same "Transaction not found".
 */
export const archiveTransaction = mutation({
  args: { transactionId: v.id("transactions") },
  handler: async (ctx, args) => {
    const access = await requireTransactionAccess(ctx, args.transactionId);
    access.assertWritable(); // an archived Circle is read-only (PRD story 79)
    access.assertSetupComplete();

    // The Recorded By Member OR the Owner may archive (PRD story 39). This is NOT
    // `isRecorder`: the Owner moderates lifecycle without gaining field-edit rights.
    if (!access.canArchive) {
      throw new Error("Only the recorder or the owner can archive this transaction");
    }

    const txn = access.transaction;
    // Reject a redundant archive rather than silently succeeding — a no-op would hide a
    // stale UI or a concurrent edit/archive race (QA-1).
    if (txn.status !== "active") {
      throw new Error("Transaction is already archived");
    }

    return performArchiveTransaction(ctx, access);
  },
});

/**
 * Core restore-Transaction write shared by the browser mutation and MCP (#327).
 * Caller must already hold {@link AuthorizedTransaction} with writable,
 * setup-complete, canArchive, and archived-transaction checks applied.
 */
export async function performRestoreTransaction(ctx: MutationCtx, access: AuthorizedTransaction) {
  const txn = access.transaction;
  // Setting `archivedAt` to undefined removes the field (it is schema-optional).
  await ctx.db.patch(txn._id, { status: "active", archivedAt: undefined });
  const restoredTransaction = await ctx.db.get(txn._id);
  if (!restoredTransaction) {
    throw new Error("Transaction not found");
  }
  await syncTransactionSearchDocument(ctx, restoredTransaction);

  await recordEvent(ctx, {
    entity: transactionEntity(txn._id, txn.circleId),
    actor: access.membership,
    action: "restored",
    changes: [],
  });

  const recorder = await ctx.db.get(txn.recordedByMemberId);
  if (recorder) {
    await notifyTransactionLifecycleChange(ctx, {
      recorderUserId: recorder.userId,
      actorUserId: access.user._id,
      actorDisplayName: access.membership.displayName,
      circle: access.circle,
      transaction: restoredTransaction,
      action: "restored",
    });
  }

  return txn._id;
}

/**
 * Restores an Archived Transaction back to active (TXN-3; PRD stories 40, 41) — it
 * re-enters Dashboard totals and the default active Ledger/Search and becomes editable
 * by its Recorded By Member again. The mirror of {@link archiveTransaction}: same
 * `canArchive` permission (Recorded By creator or Owner — PRD story 41), same
 * `assertWritable` (an archived Circle must be restored first before any of its
 * Transactions can be), and the same anti-enumeration "Transaction not found".
 *
 * Restoring a Transaction that is already active is REJECTED for the same
 * no-silent-failure reason archiving a redundant one is. Records a `"restored"` event
 * with the moderator as actor and no field changes, and clears `archivedAt`.
 */
export const restoreTransaction = mutation({
  args: { transactionId: v.id("transactions") },
  handler: async (ctx, args) => {
    const access = await requireTransactionAccess(ctx, args.transactionId);
    access.assertWritable(); // an archived Circle is read-only (PRD story 79)
    access.assertSetupComplete();

    if (!access.canArchive) {
      throw new Error("Only the recorder or the owner can restore this transaction");
    }

    const txn = access.transaction;
    if (txn.status !== "archived") {
      throw new Error("Transaction is not archived");
    }

    return performRestoreTransaction(ctx, access);
  },
});
