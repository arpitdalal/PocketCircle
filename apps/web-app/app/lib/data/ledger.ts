import { api } from "@pocketcircle/convex";
import type { PlainMonth, TransactionType } from "@pocketcircle/domain";
import { formatMoneyAmount, money, toCurrencyCode } from "@pocketcircle/domain";
import { useConvex, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
// The stream-pagination variant of usePaginatedQuery. Queries that paginate a
// convex-helpers STREAM (Category Filter, Ledger Filter) have no journal to pin page
// bounds, so the reactive client must pass `endCursor` back itself or pages develop
// holes / duplicates at their boundaries once the underlying rows change after a
// loadMore. This hook does exactly that; convex/react's version is only correct for
// queries that call ctx.db's own .paginate(). Transaction Search (#97) uses numbered
// pages and `useQuery` instead.
import { usePaginatedQuery as useStreamPaginatedQuery } from "convex-helpers/react";
import { MOCKS } from "../env.js";
import {
  MOCK_CATEGORIES,
  MOCK_MEMBERS,
  MOCK_MONTHLY_SUMMARY,
  mockFilterTransactions,
} from "../fixtures.js";
import { useStableQuery } from "../use-stable-query.js";
import type { Circle } from "./circles.js";
import {
  type PaginatedTransactions,
  type PaginationStatus,
  TRANSACTIONS_PAGE_SIZE,
  type TransactionStatus,
  useTransactions,
} from "./transactions.js";

export type TransactionSearchPage = NonNullable<
  FunctionReturnType<typeof api.search.searchTransactions>
>;

export type TransactionSearchResult = TransactionSearchPage & { isLoading: boolean };

export type ExportTransactionsResult = NonNullable<
  FunctionReturnType<typeof api.export.exportTransactions>
>;

export type ExportTransactionRow = Extract<ExportTransactionsResult, { ok: true }>["rows"][number];

/**
 * The Monthly Ledger's per-month financial summary, derived from `getMonthlyLedger`
 * so it can't drift from the backend (ADR 0003): that month's Income / Expense / Net
 * in minor units plus the Circle Currency. `null` ≡ inaccessible Circle (ADR 0016);
 * `undefined` while loading.
 */
export type MonthlySummary = NonNullable<FunctionReturnType<typeof api.ledger.getMonthlyLedger>>;
export type MonthlyTotals = MonthlySummary["totals"];

export function useMonthlySummary(circleId: Circle["id"], month: PlainMonth) {
  // Stable across month arg changes so MonthScopeTotalsCards / NumberFlow stay
  // mounted and can bridge the ledger month change (ADR 0032). Reset on Circle
  // change so a reused route never bridges another Circle's totals.
  const retained = useStableQuery(
    api.ledger.getMonthlyLedger,
    MOCKS ? "skip" : { circleId, month },
    { resetKey: circleId },
  );
  if (MOCKS) {
    return { summary: MOCK_MONTHLY_SUMMARY, isPending: false };
  }
  return { summary: retained.value, isPending: retained.isPending };
}

/**
 * The Monthly Ledger surface for one Circle-month (RPT-1): the `summary` (totals +
 * Currency, computed server-side over the whole month) fused with the month-scoped,
 * paginated `transactions` list. They are two backend reads (a `usePaginatedQuery`
 * can't carry totals next to a page, and the totals must sum the entire month while
 * the list only resolves the visible page), recombined here into the one hook the
 * route consumes. Mock mode returns fixtures and skips both backend reads (ADR 0006).
 *
 * `status` selects the month's active list (default) or its archived list (TXN-3 — the
 * surface the Restore affordance reads). The `summary` totals are always the month's
 * ACTIVE Income/Expense/Net (archived Transactions never count — Dashboard contract),
 * independent of which list the toggle shows.
 */
export function useMonthlyLedger(
  circleId: Circle["id"],
  month: PlainMonth,
  options?: { status?: TransactionStatus },
) {
  const { summary: queried, isPending: summaryPending } = useMonthlySummary(circleId, month);
  const transactions = useTransactions(circleId, month, { status: options?.status ?? "active" });
  return {
    summary: MOCKS ? MOCK_MONTHLY_SUMMARY : queried,
    summaryPending: MOCKS ? false : summaryPending,
    transactions,
  };
}

export type FilterType = "all" | TransactionType;
export type LifecycleFilter = "active" | "archived" | "all";

export type TransactionFilterOptions = NonNullable<
  FunctionReturnType<typeof api.search.getTransactionSearchOptions>
>;

interface BaseTransactionFilters {
  query?: string;
  type: FilterType;
  status: LifecycleFilter;
  categoryIds?: string[];
  recordedByMemberIds?: string[];
  paidByMemberIds?: string[];
}

export interface LedgerTransactionFilters extends BaseTransactionFilters {
  month: PlainMonth;
}

export interface TransactionSearchFilters extends BaseTransactionFilters {
  dateFrom?: string;
  dateTo?: string;
  amountMin?: number;
  amountMax?: number;
}

export function useLedgerTransactionFilter(
  circleId: Circle["id"],
  filters: LedgerTransactionFilters,
  options?: { enabled?: boolean },
): PaginatedTransactions {
  const enabled = options?.enabled ?? true;
  const paginated = useStreamPaginatedQuery(
    api.search.filterLedgerTransactions,
    MOCKS || !enabled ? "skip" : { circleId, ...filters },
    { initialNumItems: TRANSACTIONS_PAGE_SIZE },
  );
  if (MOCKS || !enabled) {
    const status: PaginationStatus = "Exhausted";
    return {
      transactions: MOCKS && enabled ? mockFilterTransactions(filters) : [],
      status,
      loadMore: () => {},
    };
  }
  return {
    transactions: paginated.results,
    status: paginated.status,
    loadMore: () => paginated.loadMore(TRANSACTIONS_PAGE_SIZE),
  };
}

export function useTransactionSearch(
  circleId: Circle["id"],
  filters: TransactionSearchFilters,
  opts?: { page?: number; pageSize?: number },
) {
  const page = opts?.page ?? 1;
  const pageSize = opts?.pageSize ?? TRANSACTIONS_PAGE_SIZE;
  const data = useQuery(
    api.search.searchTransactions,
    MOCKS
      ? "skip"
      : {
          circleId,
          ...filters,
          page,
          pageSize,
        },
  );
  if (MOCKS) {
    const all = mockFilterTransactions(filters);
    const start = (page - 1) * pageSize;
    return {
      transactions: all.slice(start, start + pageSize),
      pageNumber: page,
      pageSize,
      totalCount: all.length,
      totalCountCapped: false,
      isLoading: false,
    } satisfies TransactionSearchResult;
  }
  if (data === undefined) {
    return {
      transactions: [],
      pageNumber: page,
      pageSize,
      totalCount: 0,
      totalCountCapped: false,
      isLoading: true,
    } satisfies TransactionSearchResult;
  }
  return { ...data, isLoading: false } satisfies TransactionSearchResult;
}

/**
 * Ledger / Search filter pickers. Pass `enabled: false` while the panel is closed
 * and no Category/Member ids are applied, so the heavy options query stays off the
 * always-on path (RPT-8). Keep enabled when URL ids need scrubbing against options.
 */
export function useLedgerFilterOptions(
  circleId: Circle["id"],
  month: PlainMonth,
  type: FilterType,
  enabled = true,
): TransactionFilterOptions | null | undefined {
  const queried = useQuery(
    api.search.getLedgerFilterOptions,
    MOCKS || !enabled ? "skip" : { circleId, month, type },
  );
  return MOCKS ? { categories: MOCK_CATEGORIES, members: MOCK_MEMBERS } : queried;
}

export function useTransactionSearchOptions(
  circleId: Circle["id"],
  type: FilterType,
  enabled = true,
): TransactionFilterOptions | null | undefined {
  const queried = useQuery(
    api.search.getTransactionSearchOptions,
    MOCKS || !enabled ? "skip" : { circleId, type },
  );
  return MOCKS ? { categories: MOCK_CATEGORIES, members: MOCK_MEMBERS } : queried;
}

/** True when filter options must subscribe (panel open or URL has id filters). */
export function filterOptionsQueryEnabled(
  panelOpen: boolean,
  filters: {
    categories: readonly string[];
    recordedBy: readonly string[];
    paidBy: readonly string[];
  },
) {
  return (
    panelOpen ||
    filters.categories.length > 0 ||
    filters.recordedBy.length > 0 ||
    filters.paidBy.length > 0
  );
}

function mockExportRows(
  filters: TransactionSearchFilters,
): Extract<ExportTransactionsResult, { ok: true }> {
  const currency = toCurrencyCode(MOCK_MONTHLY_SUMMARY.currency);
  const rows = mockFilterTransactions(filters).map((transaction) => ({
    date: transaction.date,
    type: transaction.type,
    title: transaction.title,
    note: transaction.note ?? "",
    amount: formatMoneyAmount(money(transaction.amountMinorUnits, currency)),
    currency,
    categories: transaction.categories.map((category) => category.name).join(", "),
    recordedBy: transaction.recordedBy.displayName,
    paidBy: transaction.paidBy.displayName,
    status: transaction.status,
  }));
  return { ok: true, rows, currency };
}

/** One-shot export of the current Transaction Search filters (EXP-1). */
export function useExportTransactions(circleId: Circle["id"]) {
  const convex = useConvex();
  return async (filters: TransactionSearchFilters) => {
    if (MOCKS) {
      return mockExportRows(filters);
    }
    return await convex.query(api.export.exportTransactions, { circleId, ...filters });
  };
}
