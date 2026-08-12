import { api } from "@pocketcircle/convex";
import {
  clampSearchPage,
  clampSearchPageSize,
  formatMoneyAmount,
  money,
} from "@pocketcircle/domain";
import { getFunctionName } from "convex/server";
import type {
  MonthlySummary,
  PaginationStatus,
  Transaction,
  TransactionFilterOptions,
} from "~/lib/data.js";
import type { EntityDouble } from "./contract.js";
import { resolveWith } from "./contract.js";

/** A zero Monthly Ledger summary — the default for tests that don't drive totals. */
const EMPTY_MONTHLY_SUMMARY: MonthlySummary = {
  totals: { incomeMinor: 0, expenseMinor: 0, netMinor: 0 },
  currency: "USD",
};

export interface LedgerState {
  /** `getMonthlyLedger` summary (totals + currency); `undefined` ≡ loading, `null` ≡
   * inaccessible Circle. Defaults to a zero summary so the totals header renders. */
  monthlySummary?: MonthlySummary | null;
  ledgerFilterTransactions?: Transaction[];
  ledgerFilterStatus?: PaginationStatus;
  /** {@link api.search.searchTransactions} rows before page slicing. A function resolves
   * per query args (e.g. by `page`); returning `undefined` models that page in flight. */
  searchTransactions?:
    | Transaction[]
    | ((args: Record<string, unknown>) => Transaction[] | undefined);
  /** {@link api.export.exportTransactions} result; a function resolves per query args. */
  exportTransactions?:
    | {
        ok: true;
        rows: Array<{
          date: string;
          type: "expense" | "income";
          title: string;
          note: string;
          amount: string;
          currency: string;
          categories: string;
          recordedBy: string;
          paidBy: string;
          status: "active" | "archived";
        }>;
        currency: string;
      }
    | { ok: false; reason: "tooMany" | "inaccessible"; limit?: number }
    | ((args: Record<string, unknown>) =>
        | {
            ok: true;
            rows: Array<{
              date: string;
              type: "expense" | "income";
              title: string;
              note: string;
              amount: string;
              currency: string;
              categories: string;
              recordedBy: string;
              paidBy: string;
              status: "active" | "archived";
            }>;
            currency: string;
          }
        | { ok: false; reason: "tooMany" | "inaccessible"; limit?: number });
  /** When true, doubles {@link api.search.searchTransactions} `totalCountCapped`. */
  searchTotalCountCapped?: boolean;
  /** `getLedgerFilterOptions` / `getTransactionSearchOptions` result; `undefined` ≡ loading,
   * `null` ≡ inaccessible. A function resolves per query args (e.g. by `type`) so a test can
   * model the type-scoped Category option set the panel narrows to as the draft type flips. */
  ledgerFilterOptions?:
    | TransactionFilterOptions
    | null
    | ((args: Record<string, unknown>) => TransactionFilterOptions | null | undefined);
  transactionSearchOptions?:
    | TransactionFilterOptions
    | null
    | ((args: Record<string, unknown>) => TransactionFilterOptions | null | undefined);
  /** Paginated `loadMore` for ledger filter doubles — same knob as the TXN list's
   * `loadMore` in merged test state. */
  loadMore?: () => void;
}

export function ledgerDouble(state: LedgerState): EntityDouble {
  const {
    monthlySummary = EMPTY_MONTHLY_SUMMARY,
    ledgerFilterTransactions = [],
    ledgerFilterStatus = "Exhausted",
    searchTransactions = [],
    exportTransactions,
    searchTotalCountCapped = false,
    ledgerFilterOptions,
    transactionSearchOptions,
    loadMore = () => {},
  } = state;
  return {
    queries: {
      [getFunctionName(api.ledger.getMonthlyLedger)]: () => monthlySummary,
      [getFunctionName(api.search.getLedgerFilterOptions)]: (args) =>
        resolveWith(ledgerFilterOptions, args),
      [getFunctionName(api.search.getTransactionSearchOptions)]: (args) =>
        resolveWith(transactionSearchOptions, args),
      [getFunctionName(api.search.searchTransactions)]: (args) => {
        const rows = resolveWith(searchTransactions, args);
        if (rows === undefined) {
          return undefined;
        }
        const page = clampSearchPage(
          typeof args.page === "number" && Number.isFinite(args.page) ? args.page : 1,
        );
        const pageSize = clampSearchPageSize(
          typeof args.pageSize === "number" ? args.pageSize : undefined,
        );
        const start = (page - 1) * pageSize;
        return {
          transactions: rows.slice(start, start + pageSize),
          pageNumber: page,
          pageSize,
          totalCount: rows.length,
          totalCountCapped: searchTotalCountCapped,
        };
      },
      [getFunctionName(api.export.exportTransactions)]: (args) => {
        if (exportTransactions !== undefined) {
          return resolveWith(exportTransactions, args);
        }
        const rows = resolveWith(searchTransactions, args);
        if (!rows) {
          return { ok: false, reason: "inaccessible" };
        }
        return {
          ok: true,
          rows: rows.map((transaction) => ({
            date: transaction.date,
            type: transaction.type,
            title: transaction.title,
            note: transaction.note ?? "",
            amount: formatMoneyAmount(money(transaction.amountMinorUnits, "USD")),
            currency: "USD",
            categories: transaction.categories.map((category) => category.name).join(", "),
            recordedBy: transaction.recordedBy.displayName,
            paidBy: transaction.paidBy.displayName,
            status: transaction.status,
          })),
          currency: "USD",
        };
      },
    },
    paginatedQueries: {
      [getFunctionName(api.search.filterLedgerTransactions)]: () => ({
        results: ledgerFilterTransactions,
        status: ledgerFilterStatus,
        loadMore,
      }),
    },
  };
}
