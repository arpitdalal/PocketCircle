import { api } from "@pocketcircle/convex";
import { usePaginatedQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { MOCKS } from "../env.js";
import {
  MOCK_CATEGORY_HISTORY,
  MOCK_CIRCLE_HISTORY,
  MOCK_TRANSACTION_HISTORY,
} from "../fixtures.js";
import type { Category } from "./categories.js";
import type { Circle } from "./circles.js";
import type {
  PaginationStatus,
  TransactionDetail,
  TransactionHistoryEvent,
} from "./transactions.js";

/** How many Transaction History events to fetch per page (initial load and each
 * "load more"). History is unbounded-growth, so the detail surface pages it (README §4). */
export const HISTORY_PAGE_SIZE = 20;

/** One paginated entity-History surface (Transaction History — TXN-4; Category
 * History — CAT-2). Both event views come from the same shared backend shape
 * (`historyView.ts`), so the parameter only pins which query the events derive from. */
export interface PaginatedHistory<Event = TransactionHistoryEvent> {
  events: Event[];
  status: PaginationStatus;
  /** Loads the next page; a no-op unless `status` is "CanLoadMore". */
  loadMore: () => void;
}

/**
 * A Transaction's History, newest first, paginated at the source so the detail surface
 * never holds an unbounded audit — it loads one page and grows on demand (TXN-4; ADR
 * 0006 for the mock fork). The detail route already resolved the Transaction through
 * `getTransaction` before this renders, so an inaccessible Circle never reaches here; the
 * backend still returns an empty page for one (anti-enumeration parity with the ledger).
 * Mock mode returns fixtures and skips the backend so E2E/offline render without a live
 * deployment (ADR 0006).
 */
export function useTransactionHistory(
  circleId: Circle["id"],
  transactionId: TransactionDetail["id"],
): PaginatedHistory {
  const paginated = usePaginatedQuery(
    api.transactions.listTransactionHistory,
    MOCKS ? "skip" : { circleId, transactionId },
    { initialNumItems: HISTORY_PAGE_SIZE },
  );
  if (MOCKS) {
    return { events: MOCK_TRANSACTION_HISTORY, status: "Exhausted", loadMore: () => {} };
  }
  return {
    events: paginated.results,
    status: paginated.status,
    loadMore: () => paginated.loadMore(HISTORY_PAGE_SIZE),
  };
}

/**
 * One Category History event (CAT-2), derived from `listCategoryHistory` so it
 * cannot drift from the shared `toHistoryEventView` (ADR 0003) — the same frozen,
 * ID-free shape Transaction History pages through. It is one element of the
 * query's paginated `page`.
 */
export type CategoryHistoryEvent = FunctionReturnType<
  typeof api.categories.listCategoryHistory
>["page"][number];

/**
 * A Category's History, newest first, paginated at the source so the panel never
 * holds an unbounded audit (CAT-2; README §4). The mirror of
 * {@link useTransactionHistory}: the categories route already gated entry through
 * the Circle guard, and the backend still returns an empty page for an
 * inaccessible Circle (anti-enumeration parity). Mock mode returns fixtures and
 * skips the backend so E2E/offline render without a live deployment (ADR 0006).
 */
export function useCategoryHistory(
  circleId: Circle["id"],
  categoryId: Category["id"],
): PaginatedHistory<CategoryHistoryEvent> {
  const paginated = usePaginatedQuery(
    api.categories.listCategoryHistory,
    MOCKS ? "skip" : { circleId, categoryId },
    { initialNumItems: HISTORY_PAGE_SIZE },
  );
  if (MOCKS) {
    return { events: MOCK_CATEGORY_HISTORY, status: "Exhausted", loadMore: () => {} };
  }
  return {
    events: paginated.results,
    status: paginated.status,
    loadMore: () => paginated.loadMore(HISTORY_PAGE_SIZE),
  };
}

/**
 * One Circle History event (CS-4), derived from `listCircleHistory` so it cannot
 * drift from the shared `toHistoryEventView` (ADR 0003).
 */
export type CircleHistoryEvent = FunctionReturnType<
  typeof api.circles.listCircleHistory
>["page"][number];

/**
 * A Circle's History, newest first, paginated at the source so the panel never
 * holds an unbounded audit (CS-4; README §4). Any current Member may read it;
 * the backend still returns an empty page for an inaccessible Circle
 * (anti-enumeration parity). Mock mode returns fixtures and skips the backend so
 * E2E/offline render without a live deployment (ADR 0006).
 */
export function useCircleHistory(circleId: Circle["id"]): PaginatedHistory<CircleHistoryEvent> {
  const paginated = usePaginatedQuery(
    api.circles.listCircleHistory,
    MOCKS ? "skip" : { circleId },
    { initialNumItems: HISTORY_PAGE_SIZE },
  );
  if (MOCKS) {
    return { events: MOCK_CIRCLE_HISTORY, status: "Exhausted", loadMore: () => {} };
  }
  return {
    events: paginated.results,
    status: paginated.status,
    loadMore: () => paginated.loadMore(HISTORY_PAGE_SIZE),
  };
}
