import { z } from "zod";

/**
 * Transaction search (circle /search route) uses numbered pages in the URL (#97).
 * Convex caps how far we scan/count so reads stay bounded — keep these aligned with
 * `packages/convex/convex/search.ts`.
 */
export const TRANSACTION_SEARCH_MAX_PAGE = 40;

/**
 * Opaque Search page continuation (RPT-8 PR4). Carries totals so later pages need not
 * rescan for `totalCount`, plus the engine cursor (`c`) to continue the stream/search page.
 */
const searchContinuationSchema = z.object({
  v: z.literal(1),
  c: z.string().min(1),
  tc: z.number().int().nonnegative(),
  tcc: z.boolean(),
});

export type SearchContinuation = z.infer<typeof searchContinuationSchema>;

export function encodeSearchContinuation(value: SearchContinuation) {
  return JSON.stringify(searchContinuationSchema.parse(value));
}

export function decodeSearchContinuation(raw: string) {
  try {
    return searchContinuationSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Default page size for search and ledger transaction lists (Convex + client). */
export const TRANSACTION_LIST_PAGE_SIZE = 25;

/** Convex full-text `.paginate({ numItems })` hard ceiling for indexed search reads. */
export const TRANSACTION_SEARCH_INDEXED_RESULT_CEILING = 1024;

/** Largest `pageSize` accepted by `searchTransactions` (stream path can scan further). */
export const TRANSACTION_SEARCH_MAX_PUBLIC_PAGE_SIZE = 100;

export function clampSearchPageSize(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) {
    return TRANSACTION_LIST_PAGE_SIZE;
  }
  return Math.min(TRANSACTION_SEARCH_MAX_PUBLIC_PAGE_SIZE, Math.max(1, Math.floor(value)));
}

export function clampSearchPage(value: number) {
  if (!Number.isFinite(value) || value < 1) {
    return 1;
  }
  return Math.min(TRANSACTION_SEARCH_MAX_PAGE, Math.floor(value));
}

/** Rows scanned/counted for offset search — one past the last exposed page. */
export function searchOffsetTakeLimit(pageSize: number) {
  return TRANSACTION_SEARCH_MAX_PAGE * pageSize + 1;
}

/** Indexed text search cannot scan past the Convex search-result ceiling. */
export function indexedSearchOffsetTakeLimit(pageSize: number) {
  return Math.min(TRANSACTION_SEARCH_INDEXED_RESULT_CEILING, searchOffsetTakeLimit(pageSize));
}

/**
 * @param hasMoreBeyondTake Indexed search: true when `.paginate` is not done while under
 * `numItems` (more hits exist without filling the page). Stream `take()` path: omit — cap
 * is already `matchCount >= takeLimit`.
 */
export function searchOffsetTotalCount(
  matchCount: number,
  takeLimit: number,
  hasMoreBeyondTake = false,
) {
  const totalCountCapped = hasMoreBeyondTake || matchCount >= takeLimit;
  const totalCount = totalCountCapped ? takeLimit : matchCount;
  return { totalCount, totalCountCapped };
}

export function searchResultTotalPages(totalCount: number, pageSize: number) {
  if (totalCount <= 0) {
    return 0;
  }
  return Math.min(TRANSACTION_SEARCH_MAX_PAGE, Math.max(1, Math.ceil(totalCount / pageSize)));
}
