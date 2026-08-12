import { api } from "@pocketcircle/convex";
import type { TransactionType } from "@pocketcircle/domain";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
// The stream-pagination variant of usePaginatedQuery. Queries that paginate a
// convex-helpers STREAM (Category Filter, Ledger Filter, Transaction Search) have
// no journal to pin page bounds, so the reactive client must pass `endCursor`
// back itself or pages develop holes / duplicates at their boundaries once the
// underlying rows change after a loadMore. This hook does exactly that;
// convex/react's version is only correct for queries that call ctx.db's own
// .paginate().
import { usePaginatedQuery as useStreamPaginatedQuery } from "convex-helpers/react";
import { MOCKS } from "../env.js";
import {
  MOCK_CATEGORIES,
  MOCK_TRANSACTIONS,
  mockCategoryDetail,
  mockFilterCategories,
} from "../fixtures.js";
import type { Circle } from "./circles.js";
import type { PaginationStatus } from "./transactions.js";

/**
 * The single Category view contract, derived from `listCategories` so it cannot
 * drift from `toCategoryView` in `packages/convex/convex/categories.ts` (ADR
 * 0003). The query returns `CategoryView[] | null` (null ≡ inaccessible Circle —
 * ADR 0016); this is one element of that array.
 */
export type Category = NonNullable<
  FunctionReturnType<typeof api.categories.listCategories>
>[number];

/**
 * The single Category DETAIL view contract (issue #240), derived from `getCategory`
 * so it cannot drift from `toCategoryDetailView` (ADR 0003).
 */
export type CategoryDetail = NonNullable<FunctionReturnType<typeof api.categories.getCategory>>;

/**
 * A Circle's Categories of one type — active only by default, or active + archived
 * when `includeArchived` is set (each carries its `status`, so the caller can tell
 * them apart). `undefined` while loading; `null` when the Circle is inaccessible
 * (anti-enumeration — ADR 0016). In mock mode it filters fixtures and skips the
 * backend so E2E renders without a live deployment (ADR 0006); in real mode it is
 * the reactive Convex query.
 */
export function useCategories(
  circleId: Circle["id"],
  type: TransactionType,
  options?: { includeArchived?: boolean },
) {
  const includeArchived = options?.includeArchived ?? false;
  const queried = useQuery(
    api.categories.listCategories,
    MOCKS ? "skip" : { circleId, type, includeArchived },
  );
  return MOCKS
    ? MOCK_CATEGORIES.filter(
        (category) => category.type === type && (includeArchived || category.status === "active"),
      )
    : queried;
}

/** How many Categories to fetch per page (initial load and each "load more"). */
export const CATEGORIES_PAGE_SIZE = 25;

/**
 * One row of the paginated Category Filter read (CAT-4), derived from
 * `filterCategories` so it cannot drift from `toCategoryView` (ADR 0003). The
 * backend shapes both queries with the same view builder, so this is the same
 * shape as {@link Category} — deriving it (rather than aliasing) keeps that true
 * by construction if the queries ever diverge.
 */
export type CategoryPageRow = FunctionReturnType<
  typeof api.categories.filterCategories
>["page"][number];

export interface CategoriesPage {
  categories: CategoryPageRow[];
  status: PaginationStatus;
  /** Loads the next page; a no-op unless `status` is "CanLoadMore". */
  loadMore: () => void;
}

/**
 * The Categories management list (CAT-4): one type's Categories narrowed by the
 * Category Filter (lifecycle scope + name search), newest first, paginated at the
 * source so the page never holds an unbounded set (README §4) — the mirror of
 * {@link useLedgerTransactionFilter} for Categories. An inaccessible Circle reads
 * as an empty, exhausted page (anti-enumeration parity with the history reads —
 * the Circle guard already gated entry). Mock mode narrows the fixtures with the
 * same domain text-match the backend uses and skips the backend (ADR 0006).
 *
 * `filterCategories` paginates a convex-helpers stream, so this MUST go through
 * the stream-aware {@link useStreamPaginatedQuery} (it pins each page's
 * `endCursor` on loadMore) — the convex/react hook would let reactive
 * inserts/archives shift page boundaries and skip or duplicate rows.
 */
export function useCategoriesPage(
  circleId: Circle["id"],
  filters: { type: "all" | TransactionType; status: "active" | "archived" | "all"; query?: string },
): CategoriesPage {
  const paginated = useStreamPaginatedQuery(
    api.categories.filterCategories,
    MOCKS ? "skip" : { circleId, ...filters },
    { initialNumItems: CATEGORIES_PAGE_SIZE },
  );
  if (MOCKS) {
    return {
      categories: mockFilterCategories(filters),
      status: "Exhausted",
      loadMore: () => {},
    };
  }
  return {
    categories: paginated.results,
    status: paginated.status,
    loadMore: () => paginated.loadMore(CATEGORIES_PAGE_SIZE),
  };
}

/**
 * The Create-Category mutation, exposed as the function the form awaits. Kept
 * behind this seam (rather than `useMutation` in the route) so the route imports
 * no Convex internals.
 */
export function useCreateCategory() {
  return useMutation(api.categories.createCategory);
}

/**
 * The Edit-Category mutation (CAT-2), behind the same seam as create. The form
 * sends only the fields it manages; the server diffs against the stored Category,
 * records only what changed, and owns every invariant (creator-only field edits,
 * rename uniqueness incl. archived names, archived-frozen — ADR 0015).
 */
export function useUpdateCategory() {
  return useMutation(api.categories.updateCategory);
}

/**
 * The Archive-Category mutation (CAT-2), behind the same seam. The server enforces
 * the permission (creator or Owner — moderation, never a field-edit backdoor) and
 * that the Circle is writable; this hook just exposes the call the row awaits.
 * Restoring is its mirror.
 */
export function useArchiveCategory() {
  return useMutation(api.categories.archiveCategory);
}

/** The Restore-Category mutation (CAT-2): the mirror of {@link useArchiveCategory}. */
export function useRestoreCategory() {
  return useMutation(api.categories.restoreCategory);
}

/**
 * The Category DETAIL read (issue #240): one Category shaped for its object route.
 * `undefined` while loading; `null` when inaccessible (ADR 0016).
 */
export function useCategoryDetail(circleId: Circle["id"], categoryId: Category["id"]) {
  const queried = useQuery(api.categories.getCategory, MOCKS ? "skip" : { circleId, categoryId });
  if (MOCKS) {
    return mockCategoryDetail(categoryId);
  }
  return queried;
}

/**
 * Up to five recent Transactions for a Category Detail preview (issue #240).
 * `undefined` while loading; `[]` when the supporting read is empty.
 */
export function useRecentCategoryTransactions(circleId: Circle["id"], categoryId: Category["id"]) {
  const queried = useQuery(
    api.categories.listRecentCategoryTransactions,
    MOCKS ? "skip" : { circleId, categoryId },
  );
  if (MOCKS) {
    return MOCK_TRANSACTIONS.filter((txn) =>
      txn.categories.some((category) => category.id === categoryId),
    ).slice(0, 5);
  }
  return queried;
}
