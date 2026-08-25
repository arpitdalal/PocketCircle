import { api } from "@pocketcircle/convex";
import { type PlainMonth, TRANSACTION_LIST_PAGE_SIZE } from "@pocketcircle/domain";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { MOCKS } from "../env.js";
import { MOCK_TRANSACTIONS, mockTransactionDetail } from "../fixtures.js";
import type { Circle } from "./circles.js";

/**
 * The single Transaction view contract, derived from `listTransactions` so it
 * cannot drift from `toTransactionView` in `packages/convex/convex/transactions.ts`
 * (ADR 0003). The query returns a paginated result; this is one element of its
 * `page`.
 */
export type Transaction = FunctionReturnType<
  typeof api.transactions.listTransactions
>["page"][number];

/**
 * The single Transaction DETAIL view contract (TXN-4), derived from `getTransaction`
 * so it cannot drift from `toTransactionDetailView` in
 * `packages/convex/convex/transactions.ts` (ADR 0003). It is the full {@link Transaction}
 * view plus its Audit Metadata block. The query returns `TransactionDetailView | null`
 * (null ≡ inaccessible / missing / wrong-Circle — ADR 0016); this is the non-null shape.
 */
export type TransactionDetail = NonNullable<
  FunctionReturnType<typeof api.transactions.getTransaction>
>;

/**
 * One Transaction History event (TXN-4), derived from `listTransactionHistory` so it
 * cannot drift from `toHistoryEventView` (ADR 0003): the action, the acting Member's
 * display identity (or `null` for a system event), the event instant, and the frozen
 * display-safe `changes` (text `from`/`to`, typed `fromMoney`/`toMoney` — never a raw
 * id). It is one element of the query's paginated `page`.
 */
export type TransactionHistoryEvent = FunctionReturnType<
  typeof api.transactions.listTransactionHistory
>["page"][number];

/** One change line within a {@link TransactionHistoryEvent}. */
export type TransactionHistoryChange = TransactionHistoryEvent["changes"][number];

/** How many Transactions to fetch per page (initial load and each "load more"). */
export const TRANSACTIONS_PAGE_SIZE = TRANSACTION_LIST_PAGE_SIZE;

/** Convex's paginated-query lifecycle status, re-exported so the route needn't import Convex. */
export type PaginationStatus = "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";

export interface PaginatedTransactions {
  transactions: Transaction[];
  status: PaginationStatus;
  /** Loads the next page; a no-op unless `status` is "CanLoadMore". */
  loadMore: () => void;
}

/** A Transaction's lifecycle status — `"active"` by default, `"archived"` for the
 * dedicated archived view (TXN-3). Re-derived from the view type so it can't drift. */
export type TransactionStatus = Transaction["status"];

/**
 * A Circle's Transactions of one lifecycle status, most recent first, paginated at
 * the source so the client never holds an unbounded set — it loads one page and grows
 * on demand (ADR 0006 for the mock fork). An optional `month` ("YYYY-MM") scopes the
 * page to one month at the source — the Monthly Ledger list (RPT-1); omit it for the
 * all-status read. TXN-1 uses the unscoped active form to confirm a create landed;
 * `status: "archived"` is the archived view the Restore affordance reads (TXN-3),
 * which the backend ranges off the same index. `status` defaults to `"active"` — the
 * normal surface that excludes archived Transactions.
 */
export function useTransactions(
  circleId: Circle["id"],
  month?: PlainMonth,
  options?: { status?: TransactionStatus; enabled?: boolean },
): PaginatedTransactions {
  const status = options?.status ?? "active";
  const enabled = options?.enabled ?? true;
  const paginated = usePaginatedQuery(
    api.transactions.listTransactions,
    MOCKS || !enabled ? "skip" : { circleId, status, ...(month ? { month } : {}) },
    { initialNumItems: TRANSACTIONS_PAGE_SIZE },
  );
  if (MOCKS || !enabled) {
    return {
      transactions: MOCKS && enabled && status === "active" ? MOCK_TRANSACTIONS : [],
      status: "Exhausted",
      loadMore: () => {},
    };
  }
  return {
    transactions: paginated.results,
    status: paginated.status,
    loadMore: () => paginated.loadMore(TRANSACTIONS_PAGE_SIZE),
  };
}

/**
 * A single Transaction DETAIL by authoritative id inside a Circle (TXN-4 /
 * Duplicate source resolution). `undefined` while loading; `null` when missing,
 * inaccessible, or wrong-Circle — same anti-enumeration parity as the detail
 * object route. Skips the subscription while either id is absent (ordinary
 * Global Add has no source).
 */
export function useTransactionDetail(
  circleId: Circle["id"] | undefined,
  transactionId: string | undefined,
) {
  const queried = useQuery(
    api.transactions.getTransaction,
    MOCKS || circleId === undefined || transactionId === undefined
      ? "skip"
      : { circleId, transactionId },
  );
  if (MOCKS) {
    return circleId === undefined || transactionId === undefined
      ? undefined
      : mockTransactionDetail(transactionId);
  }
  return queried;
}

/**
 * The Create-Transaction mutation, exposed as the function the form awaits. Kept
 * behind this seam (rather than `useMutation` in the route) so the route imports
 * no Convex internals.
 */
export function useCreateTransaction() {
  return useMutation(api.transactions.createTransaction);
}

/**
 * The Edit-Transaction mutation (TXN-2), behind the same seam as create. The form
 * sends only the fields it manages; the server diffs against the stored Transaction,
 * records only what changed, and owns every invariant (Recorded By, type change,
 * archived-frozen — ADR 0015).
 */
export function useUpdateTransaction() {
  return useMutation(api.transactions.updateTransaction);
}

/**
 * The Archive-Transaction mutation (TXN-3), behind the same seam as create/edit. The
 * server enforces the permission (Recorded By creator or Owner — moderation, never a
 * field-edit backdoor) and that the Circle is writable; this hook just exposes the call
 * the ledger row awaits. Restoring is its mirror.
 */
export function useArchiveTransaction() {
  return useMutation(api.transactions.archiveTransaction);
}

/** The Restore-Transaction mutation (TXN-3): the mirror of {@link useArchiveTransaction}. */
export function useRestoreTransaction() {
  return useMutation(api.transactions.restoreTransaction);
}
