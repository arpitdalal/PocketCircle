import { api } from "@spend-circle/convex";
import { textIncludes } from "@spend-circle/domain";
import { getFunctionName } from "convex/server";
import type { Mock } from "vitest";
import type { Category, CategoryDetail, PaginationStatus, Transaction } from "~/lib/data.js";
import type { EntityDouble } from "./contract.js";
import { resolveWith } from "./contract.js";
import { testId } from "./ids.js";

/** Models the `listCategories` backend contract: filter by type, optionally include
 * archived. The single definition the doubles share so it cannot drift per file. */
function fakeListCategories(rows: Category[], args: Record<string, unknown>) {
  const includeArchived = args.includeArchived === true;
  return rows.filter((c) => c.type === args.type && (includeArchived || c.status === "active"));
}

/** Models the `filterCategories` backend contract (CAT-4; issue #138): type-scoped
 * (or all types when `type: "all"`), lifecycle-scoped, name-matched with the SAME
 * domain `textIncludes` the real handler uses — so a route test exercises real
 * narrowing semantics, not a per-file approximation. */
function fakeFilterCategories(rows: Category[], args: Record<string, unknown>) {
  const query = typeof args.query === "string" ? args.query : "";
  return rows.filter(
    (c) =>
      (args.type === "all" || c.type === args.type) &&
      (args.status === "all" || c.status === args.status) &&
      textIncludes(c.name, query),
  );
}

export interface CategoriesState {
  /** `listCategories` source rows (filtered per query args); `undefined` ≡ loading,
   * `null` ≡ inaccessible Circle (ADR 0016). The same rows feed the paginated
   * `filterCategories` double (CAT-4), narrowed per ITS query args. */
  categories?: Category[] | null;
  /** `getCategory` detail target (issue #240); `undefined` ≡ loading, `null` ≡ unavailable. */
  categoryDetail?:
    | CategoryDetail
    | null
    | ((args: Record<string, unknown>) => CategoryDetail | null | undefined);
  /** `listRecentCategoryTransactions` rows for Category Detail preview. */
  recentCategoryTransactions?: Transaction[];
  /** The `filterCategories` pagination lifecycle (CAT-4); defaults to "Exhausted". */
  categoriesPageStatus?: PaginationStatus;
  /** The `filterCategories` `loadMore`; assert against it for the Categories
   * infinite-scroll / intersection wiring. */
  categoriesLoadMore?: () => void;
  /** The category mutation spies the test owns (`createCategory`, `updateCategory`, …).
   *
   * Plain spies the caller configures. To assert a backend-guard *rejection* path
   * (`assertWritable` / `requireCircleAccess` throws because the Circle was archived or
   * went inaccessible mid-submit), pass a rejecting spy on the mutation under test, e.g.
   * `createCategory: vi.fn().mockRejectedValue(new ConvexError(mutationErrorData(...)))`
   * (from `convex/values` + domain error data, matching production) and assert the
   * route's error handling.
   * Intentionally NOT abstracted into a dedicated `rejects` knob: the spy already exposes
   * the full mock surface; add a typed helper only when a shared rejection contract emerges. */
  createCategory?: Mock;
  updateCategory?: Mock;
  archiveCategory?: Mock;
  restoreCategory?: Mock;
}

export function categoriesDouble(state: CategoriesState): EntityDouble {
  const {
    categories,
    categoryDetail,
    recentCategoryTransactions = [],
    categoriesPageStatus = "Exhausted",
    categoriesLoadMore = () => {},
    createCategory,
    updateCategory,
    archiveCategory,
    restoreCategory,
  } = state;
  return {
    queries: {
      [getFunctionName(api.categories.listCategories)]: (args) =>
        categories == null ? categories : fakeListCategories(categories, args),
      [getFunctionName(api.categories.getCategory)]: (args) => resolveWith(categoryDetail, args),
      [getFunctionName(api.categories.listRecentCategoryTransactions)]: () =>
        recentCategoryTransactions,
    },
    paginatedQueries: {
      [getFunctionName(api.categories.filterCategories)]: (args) => ({
        results: fakeFilterCategories(categories ?? [], args),
        status: categoriesPageStatus,
        loadMore: categoriesLoadMore,
      }),
    },
    mutations: {
      [getFunctionName(api.categories.createCategory)]: createCategory,
      [getFunctionName(api.categories.updateCategory)]: updateCategory,
      [getFunctionName(api.categories.archiveCategory)]: archiveCategory,
      [getFunctionName(api.categories.restoreCategory)]: restoreCategory,
    },
  };
}

export function makeCategoryView(over: Partial<Category> = {}): Category {
  return {
    id: testId<Category["id"]>("cat-groceries"),
    name: "Groceries",
    type: "expense",
    color: "green",
    status: "active",
    creator: { displayName: "You", image: undefined },
    canEditFields: true,
    canArchive: true,
    ...over,
  };
}

export function makeCategoryDetailView(over: Partial<CategoryDetail> = {}): CategoryDetail {
  const base = makeCategoryView(over);
  return {
    ...base,
    ref: over.ref ?? "groceries-cat-groceries",
    ...over,
  };
}
