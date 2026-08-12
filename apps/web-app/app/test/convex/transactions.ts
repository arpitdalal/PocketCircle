import { api } from "@pocketcircle/convex";
import { getFunctionName } from "convex/server";
import type { Mock } from "vitest";
import type {
  Category,
  Member,
  PaginationStatus,
  Transaction,
  TransactionDetail,
} from "~/lib/data.js";
import type { EntityDouble } from "./contract.js";
import { resolveWith } from "./contract.js";
import { testId } from "./ids.js";

export interface TransactionsState {
  /** `listTransactions` page (paginated) — the ACTIVE-status page. */
  transactions?: Transaction[];
  /** `listTransactions` page for `status: "archived"` — the archived view's page
   * (TXN-3). Dispatched by the query's `status` arg so the active/archived toggle reads
   * two distinct lists; defaults to empty (an archived view with nothing in it). */
  archivedTransactions?: Transaction[];
  transactionsStatus?: PaginationStatus;
  /** The paginated `loadMore`; assert against it for "Load more" wiring. */
  loadMore?: () => void;
  /** `getEditableTransaction` edit target (TXN-5); `undefined` ≡ loading, `null` ≡
   * unavailable (missing / inaccessible / wrong-Circle / archived / not-editable —
   * all collapsed by the server). Drives the edit object route's resolution. A function
   * resolves per query args (e.g. by `transactionId`) so a test can model two distinct
   * cached targets while navigating edit→edit without a loading gap. */
  editableTransaction?:
    | Transaction
    | null
    | ((args: Record<string, unknown>) => Transaction | null | undefined);
  /** `getTransaction` detail target (TXN-4); `undefined` ≡ loading, `null` ≡ unavailable
   * (missing / inaccessible / wrong-Circle — collapsed by the server). Drives the detail
   * object route's resolution. A function resolves per query args (e.g. by `transactionId`)
   * so a test can model distinct cached targets without a loading gap. */
  transactionDetail?:
    | TransactionDetail
    | null
    | ((args: Record<string, unknown>) => TransactionDetail | null | undefined);
  /** The transaction mutation spies the test owns (`createTransaction`, `updateTransaction`, …).
   *
   * Plain spies the caller configures. To assert a backend-guard *rejection* path
   * (`assertWritable` / `requireCircleAccess` throws because the Circle was archived or
   * went inaccessible mid-submit), pass a rejecting spy on the mutation under test, e.g.
   * `createTransaction: vi.fn().mockRejectedValue(new ConvexError(mutationErrorData(...)))`
   * (from `convex/values` + domain error data, matching production) and assert the
   * route's error handling.
   * Intentionally NOT abstracted into a dedicated `rejects` knob: the spy already exposes
   * the full mock surface; add a typed helper only when a shared rejection contract emerges. */
  createTransaction?: Mock;
  updateTransaction?: Mock;
  archiveTransaction?: Mock;
  restoreTransaction?: Mock;
}

export function transactionsDouble(state: TransactionsState): EntityDouble {
  const {
    transactions = [],
    archivedTransactions = [],
    transactionsStatus = "Exhausted",
    loadMore = () => {},
    // No default: absent ≡ `undefined` ≡ loading (the codebase's reactive-query
    // convention); a test passes `null` to model an unavailable edit target.
    editableTransaction,
    transactionDetail,
    createTransaction,
    updateTransaction,
    archiveTransaction,
    restoreTransaction,
  } = state;
  const listTransactionsName = getFunctionName(api.transactions.listTransactions);
  return {
    queries: {
      [getFunctionName(api.transactions.getEditableTransaction)]: (args) =>
        resolveWith(editableTransaction, args),
      [getFunctionName(api.transactions.getTransaction)]: (args) =>
        resolveWith(transactionDetail, args),
    },
    paginatedQueries: {
      [listTransactionsName]: (args) => {
        // The active/archived toggle (TXN-3) reads two distinct pages by the query's
        // `status` arg, so the doubles dispatch on it just as the backend does.
        const archived = args.status === "archived";
        return {
          results: archived ? archivedTransactions : transactions,
          status: transactionsStatus,
          loadMore,
        };
      },
    },
    mutations: {
      [getFunctionName(api.transactions.createTransaction)]: createTransaction,
      [getFunctionName(api.transactions.updateTransaction)]: updateTransaction,
      [getFunctionName(api.transactions.archiveTransaction)]: archiveTransaction,
      [getFunctionName(api.transactions.restoreTransaction)]: restoreTransaction,
    },
  };
}

export function makeTransactionView(over: Partial<Transaction> = {}): Transaction {
  return {
    id: testId<Transaction["id"]>("t1"),
    ref: "weekly-shop-t1",
    type: "expense",
    title: "Weekly shop",
    note: undefined,
    amountMinorUnits: 1250,
    date: "2026-05-15",
    month: "2026-05",
    status: "active",
    recordedBy: { id: testId<Member["id"]>("mem-you"), displayName: "You", image: undefined },
    paidBy: { id: testId<Member["id"]>("mem-you"), displayName: "You", image: undefined },
    categories: [
      { id: testId<Category["id"]>("cat-groceries"), name: "Groceries", color: "green" },
    ],
    canEditFields: true,
    canArchive: true,
    ...over,
  };
}

/** A Transaction DETAIL view (TXN-4): the {@link makeTransactionView} shape plus an Audit
 * Metadata block. Defaults to a fixed-instant audit (UTC-rendered by the surface) so a
 * timestamp test reads deterministic values regardless of the runner's timezone. */
export function makeTransactionDetailView(
  over: Partial<TransactionDetail> = {},
): TransactionDetail {
  const me = { id: testId<Member["id"]>("mem-you"), displayName: "You", image: undefined };
  return {
    ...makeTransactionView(),
    audit: {
      createdBy: me,
      createdAt: Date.UTC(2026, 4, 15, 9, 30),
      updatedBy: me,
      updatedAt: Date.UTC(2026, 4, 16, 14, 5),
    },
    ...over,
  };
}
