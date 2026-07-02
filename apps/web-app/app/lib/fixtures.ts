import {
  buildRef,
  type ComparisonRangeMonths,
  comparisonWindowMonths,
  PERSONAL_CIRCLE_COLOR_ID,
  type PlainMonth,
  type TransactionType,
  textIncludes,
  transactionSearchText,
  transactionTextMatches,
} from "@spend-circle/domain";
import { testId } from "../test/convex/ids.js";
import type { InvitationPreview } from "./data/invitations.js";
import type {
  Category,
  CategoryAnalytics,
  CategoryDetail,
  CategoryHistoryEvent,
  Circle,
  CircleHistoryEvent,
  Dashboard,
  Member,
  MonthlyComparison,
  MonthlySummary,
  Notification,
  PendingInvitation,
  Transaction,
  TransactionDetail,
  TransactionHistoryEvent,
} from "./data.js";

/**
 * Mock fixture data for E2E renders without a live backend (ADR 0006). These are
 * typed against the derived {@link Circle} contract, so a field change to
 * `toCircleView` (packages/convex/convex/circles.ts) fails typecheck here rather
 * than letting the mock path silently drift from the real path at runtime. The
 * synthetic ids are cast to the `Id<"circles">` brand — they never reach Convex.
 */

export const MOCK_CIRCLES: Circle[] = [
  {
    id: "mock-personal" as Circle["id"],
    ref: "personal-mock-personal",
    name: "Mock's Circle",
    kind: "personal",
    currency: "USD",
    color: PERSONAL_CIRCLE_COLOR_ID,
    mark: "M",
    status: "active",
    setupAnswers: undefined,
    setupComplete: true,
    currencyLocked: false,
    nameCustomized: false,
  },
];

/**
 * Mock Categories spanning both types, typed against the derived {@link Category}
 * contract so a shape change to `toCategoryView` fails typecheck here (ADR 0003).
 * `useCategories` filters these by the requested type.
 */
export const MOCK_CATEGORIES: Category[] = [
  {
    id: "mock-cat-groceries" as Category["id"],
    name: "Groceries",
    type: "expense",
    color: "green",
    status: "active",
    creator: { displayName: "You", image: undefined },
    canEditFields: true,
    canArchive: true,
  },
  {
    id: "mock-cat-rent" as Category["id"],
    name: "Rent",
    type: "expense",
    color: "amber",
    status: "active",
    creator: { displayName: "You", image: undefined },
    canEditFields: true,
    canArchive: true,
  },
  {
    id: "mock-cat-salary" as Category["id"],
    name: "Salary",
    type: "income",
    color: "teal",
    status: "active",
    creator: { displayName: "You", image: undefined },
    canEditFields: true,
    canArchive: true,
  },
  // An archived row so the Category Filter's status=all default renders the
  // muted-name + "Archived" treatment offline (CAT-4).
  {
    id: "mock-cat-subscriptions" as Category["id"],
    name: "Old Subscriptions",
    type: "expense",
    color: "rose",
    status: "archived",
    creator: { displayName: "You", image: undefined },
    canEditFields: false,
    canArchive: true,
  },
];

/**
 * Synthesizes a Category DETAIL view for the detail object route under MOCKS (issue #240).
 */
export function mockCategoryDetail(id: string): CategoryDetail {
  const base = MOCK_CATEGORIES.find((category) => category.id === id) ?? MOCK_CATEGORIES[0];
  if (!base) {
    throw new Error("mock categories missing");
  }
  return {
    ...base,
    ref: buildRef(base.name, id),
  };
}

/**
 * The `filterCategories` narrowing applied to the fixtures under MOCKS (CAT-4):
 * type-scoped, lifecycle-scoped, name-matched with the SAME domain `textIncludes`
 * the backend handler uses, so the mock path cannot drift from the real match
 * semantics (ADR 0006). Typed against the derived {@link Category} contract like
 * every other fixture.
 */
export function mockFilterCategories(filters: {
  type: "all" | TransactionType;
  status: "active" | "archived" | "all";
  query?: string;
}): Category[] {
  return MOCK_CATEGORIES.filter(
    (category) =>
      (filters.type === "all" || category.type === filters.type) &&
      (filters.status === "all" || category.status === filters.status) &&
      textIncludes(category.name, filters.query ?? ""),
  );
}

/**
 * Mock Members for the Paid By selector and Member List, typed against the
 * derived {@link Member} contract so a shape change to `toMemberView` fails
 * typecheck here (ADR 0003).
 */
export const MOCK_MEMBERS: Member[] = [
  {
    id: "mock-member-you" as Member["id"],
    displayName: "You",
    image: undefined,
    role: "owner",
    status: "active",
    joinedAt: 0,
    isSelf: true,
  },
  {
    id: "mock-member-alex" as Member["id"],
    displayName: "Alex",
    image: undefined,
    role: "member",
    status: "active",
    joinedAt: 1,
    isSelf: false,
  },
];

const now = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Mock pending invitations for the Owner's management list (MEM-4), typed against
 * the derived {@link PendingInvitation} contract so a shape change to
 * `listPendingInvitations` fails typecheck here (ADR 0003).
 */
export const MOCK_PENDING_INVITATIONS: PendingInvitation[] = [
  {
    id: "mock-invite-recent" as PendingInvitation["id"],
    email: "ada@example.com",
    createdAt: now - 2 * DAY_MS,
    expiresAt: now + 5 * DAY_MS,
    resendCount: 0,
  },
  {
    id: "mock-invite-expiring" as PendingInvitation["id"],
    email: "bob@example.com",
    createdAt: now - 6 * DAY_MS,
    expiresAt: now + DAY_MS,
    resendCount: 2,
  },
];

export const MOCK_INVITATION_PREVIEW: InvitationPreview = {
  circleName: "Mock Shared Circle",
  ownerDisplayName: "Alex",
  ownerImage: null,
  invitedEmail: "you@example.com",
};

/**
 * Mock Transactions, typed against the derived {@link Transaction} contract so a
 * shape change to `toTransactionView` fails typecheck here (ADR 0003). The list
 * starts empty so the Transactions surface renders its empty state under MOCKS;
 * a created Transaction is reflected optimistically by the form in mock mode.
 */
export const MOCK_TRANSACTIONS: Transaction[] = [];

function includesAny<T>(selected: T[] | undefined, value: T) {
  return !selected || selected.length === 0 || selected.includes(value);
}

function transactionHasCategory(transaction: Transaction, categoryIds: string[] | undefined) {
  return (
    !categoryIds ||
    categoryIds.length === 0 ||
    transaction.categories.some((category) => categoryIds.includes(category.id))
  );
}

function inInclusiveDateRange(
  transaction: Transaction,
  filters: { dateFrom?: string; dateTo?: string },
) {
  return (
    (!filters.dateFrom || transaction.date >= filters.dateFrom) &&
    (!filters.dateTo || transaction.date <= filters.dateTo)
  );
}

function inAmountRange(
  transaction: Transaction,
  filters: { amountMin?: number; amountMax?: number },
) {
  return (
    (filters.amountMin === undefined || transaction.amountMinorUnits >= filters.amountMin) &&
    (filters.amountMax === undefined || transaction.amountMinorUnits <= filters.amountMax)
  );
}

export function mockFilterTransactions(
  filters: {
    query?: string;
    type: "all" | TransactionType;
    status: "active" | "archived" | "all";
    categoryIds?: string[];
    recordedByMemberIds?: string[];
    paidByMemberIds?: string[];
    month?: PlainMonth;
    dateFrom?: string;
    dateTo?: string;
    amountMin?: number;
    amountMax?: number;
  },
  rows: Transaction[] = MOCK_TRANSACTIONS,
) {
  return rows.filter((transaction) => {
    const searchText = transactionSearchText({ title: transaction.title, note: transaction.note });
    return (
      (filters.type === "all" || transaction.type === filters.type) &&
      (filters.status === "all" || transaction.status === filters.status) &&
      (!filters.month || transaction.month === filters.month) &&
      inInclusiveDateRange(transaction, filters) &&
      inAmountRange(transaction, filters) &&
      transactionHasCategory(transaction, filters.categoryIds) &&
      includesAny(filters.recordedByMemberIds, transaction.recordedBy.id) &&
      includesAny(filters.paidByMemberIds, transaction.paidBy.id) &&
      transactionTextMatches(searchText, filters.query ?? "")
    );
  });
}

/**
 * Mock Monthly Ledger summary, typed against the derived {@link MonthlySummary}
 * contract so a shape change to `getMonthlyLedger` fails typecheck here (ADR 0003).
 * Zeros match the empty {@link MOCK_TRANSACTIONS} so the Ledger renders a coherent
 * empty month under MOCKS.
 */
export const MOCK_MONTHLY_SUMMARY: MonthlySummary = {
  totals: { incomeMinor: 0, expenseMinor: 0, netMinor: 0 },
  currency: "USD",
};

/**
 * Mock per-Circle Dashboard, typed against the derived {@link Dashboard} contract so
 * a shape change to `getDashboard` fails typecheck here (ADR 0003). A couple of recent
 * rows and matching totals so the Dashboard renders a populated surface under MOCKS /
 * offline UI dev; the Paid By filter options come from {@link MOCK_MEMBERS}.
 */
const MOCK_DASHBOARD_RECENT: Transaction[] = [
  {
    id: "mock-dash-income" as Transaction["id"],
    ref: "paycheck-mock-dash-income",
    type: "income",
    title: "Paycheck",
    note: undefined,
    amountMinorUnits: 500_000,
    date: "2026-06-01",
    month: "2026-06",
    status: "active",
    recordedBy: { id: "mock-member-you" as Member["id"], displayName: "You", image: undefined },
    paidBy: { id: "mock-member-you" as Member["id"], displayName: "You", image: undefined },
    categories: [{ id: "mock-cat-salary" as Category["id"], name: "Salary", color: "teal" }],
    canEditFields: true,
    canArchive: true,
  },
  {
    id: "mock-dash-expense" as Transaction["id"],
    ref: "groceries-mock-dash-expense",
    type: "expense",
    title: "Groceries",
    note: undefined,
    amountMinorUnits: 7_350,
    date: "2026-06-02",
    month: "2026-06",
    status: "active",
    recordedBy: { id: "mock-member-you" as Member["id"], displayName: "You", image: undefined },
    paidBy: { id: "mock-member-alex" as Member["id"], displayName: "Alex", image: undefined },
    categories: [{ id: "mock-cat-groceries" as Category["id"], name: "Groceries", color: "green" }],
    canEditFields: true,
    canArchive: true,
  },
];

export const MOCK_DASHBOARD: Dashboard = {
  totals: { incomeMinor: 500_000, expenseMinor: 7_350, netMinor: 492_650 },
  recent: MOCK_DASHBOARD_RECENT,
  currency: "USD",
  month: "2026-06",
};

/**
 * Mock category analytics for offline UI dev (RPT-5). Ranked expense tagged spend
 * with a non-additive-friendly mix; typed against {@link CategoryAnalytics}.
 */
export const MOCK_CATEGORY_ANALYTICS: CategoryAnalytics = {
  currency: "USD",
  rows: [
    {
      categoryId: "mock-cat-groceries" as Category["id"],
      name: "Groceries",
      color: "green",
      status: "active",
      taggedTotalMinor: 7_350,
      txnCount: 1,
    },
    {
      categoryId: "mock-cat-dining" as Category["id"],
      name: "Dining",
      color: "orange",
      status: "active",
      taggedTotalMinor: 4_200,
      txnCount: 2,
    },
  ],
};

/**
 * Synthesizes the month-over-month comparison series for the requested Comparison
 * Range under MOCKS (RPT-4), so the Dashboard chart renders offline and the range
 * selector visibly reshapes the window (ADR 0006). Typed against the derived
 * {@link MonthlyComparison} contract, so a shape change to `getMonthlyComparison`
 * fails typecheck here. Amounts are deterministic per month index (no randomness)
 * and include an expense-heavy month so the negative-net rendering is exercised.
 */
export function mockMonthlyComparison(
  endMonth: PlainMonth,
  rangeMonths: ComparisonRangeMonths,
): MonthlyComparison {
  const series = comparisonWindowMonths(endMonth, rangeMonths).map((month, index) => {
    const incomeMinor = 400_000 + index * 25_000;
    // Every third month spends past its income, so net flips negative in-fixture.
    const expenseMinor = index % 3 === 2 ? incomeMinor + 50_000 : 210_000 + index * 10_000;
    return { month, incomeMinor, expenseMinor, netMinor: incomeMinor - expenseMinor };
  });
  return { series, currency: "USD" };
}

export function mockCircle(id: string): Circle {
  return {
    id: id as Circle["id"],
    ref: `mock-circle-${id}`,
    name: "Mock Circle",
    kind: "regular",
    currency: "USD",
    color: "blue",
    mark: "M",
    status: "active",
    setupAnswers: undefined,
    // Mock-synthesized Circles stand in for fixture-backed routes offline (ADR 0006).
    // They are always past setup — there is no Convex `completeCircleSetup` in MOCKS.
    setupComplete: true,
    currencyLocked: false,
    nameCustomized: false,
  };
}

/**
 * Resolves a Circle for mock-mode route guards (`useResolvedCircle`). Prefer a
 * `MOCK_CIRCLES` list entry when the parsed id matches so the guard sees the same
 * Circle as `listMyCircles`; otherwise synthesize a complete ad-hoc Circle for deep
 * links into fixture routes.
 */
export function mockResolvedCircle(id: string) {
  return MOCK_CIRCLES.find((circle) => circle.id === id) ?? mockCircle(id);
}

/**
 * Synthesizes an editable Transaction for the edit object route under MOCKS, so
 * `/transactions/:transactionRef/edit` renders its prefilled form offline without a
 * live backend (the parallel of {@link mockCircle} for `getEditableTransaction` —
 * ADR 0006). Typed against the derived {@link Transaction} contract, so a shape
 * change to `toTransactionView` fails typecheck here. `canEditFields` is true: the
 * real query only ever returns a Transaction the viewer may field-edit.
 */
export function mockEditableTransaction(id: string): Transaction {
  const me = {
    id: "mock-member-you" as Member["id"],
    displayName: "You",
    image: undefined,
  };
  return {
    id: id as Transaction["id"],
    ref: `mock-txn-${id}`,
    type: "expense",
    title: "Mock transaction",
    note: undefined,
    amountMinorUnits: 1250,
    date: "2026-05-15",
    month: "2026-05",
    status: "active",
    recordedBy: me,
    paidBy: me,
    categories: [{ id: "mock-cat-groceries" as Category["id"], name: "Groceries", color: "green" }],
    canEditFields: true,
    canArchive: true,
  };
}

/**
 * Synthesizes a Transaction DETAIL view for the detail object route under MOCKS (TXN-4),
 * so `/transactions/:transactionRef` renders offline without a live backend (the parallel
 * of {@link mockEditableTransaction} for `getTransaction` — ADR 0006). Typed against the
 * derived {@link TransactionDetail} contract, so a shape change to `toTransactionDetailView`
 * fails typecheck here. It is an editable Transaction plus its Audit Metadata block.
 */
export function mockTransactionDetail(id: string): TransactionDetail {
  const me = {
    id: "mock-member-you" as Member["id"],
    displayName: "You",
    image: undefined,
  };
  return {
    ...mockEditableTransaction(id),
    audit: {
      createdBy: me,
      createdAt: Date.UTC(2026, 4, 15, 9, 30),
      updatedBy: me,
      updatedAt: Date.UTC(2026, 4, 16, 14, 5),
    },
  };
}

/**
 * Mock Transaction History, typed against the derived {@link TransactionHistoryEvent}
 * contract so a shape change to `toHistoryEventView` fails typecheck here (ADR 0003).
 * Newest-first (the query's order), spanning a money edit and the original create so the
 * offline detail surface renders a populated, ID-free history with both a text and a typed
 * money change.
 */
/**
 * Mock Category History (CAT-2), typed against the derived {@link CategoryHistoryEvent}
 * contract so a shape change to the shared history event view fails typecheck here
 * (ADR 0003). Newest-first (the query's order): a rename/recolor edit over the original
 * create, so the offline panel renders a populated, ID-free history.
 */
export const MOCK_CATEGORY_HISTORY: CategoryHistoryEvent[] = [
  {
    id: "mock-cat-hist-edit" as CategoryHistoryEvent["id"],
    action: "edited",
    createdAt: Date.UTC(2026, 4, 20, 11, 15),
    actor: { displayName: "You", image: undefined },
    changes: [
      { field: "name", from: "Food", to: "Groceries" },
      { field: "color", from: "Teal", to: "Green" },
    ],
  },
  {
    id: "mock-cat-hist-create" as CategoryHistoryEvent["id"],
    action: "created",
    createdAt: Date.UTC(2026, 4, 12, 8, 0),
    actor: { displayName: "You", image: undefined },
    changes: [
      { field: "name", to: "Food" },
      { field: "color", to: "Teal" },
      { field: "type", to: "expense" },
    ],
  },
];

/**
 * Mock Circle History (CS-4), typed against the derived {@link CircleHistoryEvent}
 * contract so a shape change to the shared history event view fails typecheck here
 * (ADR 0003). Newest-first: an ownership transfer over the original create.
 */
export const MOCK_CIRCLE_HISTORY: CircleHistoryEvent[] = [
  {
    id: testId<CircleHistoryEvent["id"]>("mock-circle-hist-transfer"),
    action: "ownership transferred",
    createdAt: Date.UTC(2026, 5, 10, 16, 45),
    actor: { displayName: "You", image: undefined },
    changes: [{ field: "owner", from: "Olive Owner", to: "Maya Member" }],
  },
  {
    id: testId<CircleHistoryEvent["id"]>("mock-circle-hist-create"),
    action: "created",
    createdAt: Date.UTC(2026, 5, 1, 9, 0),
    actor: { displayName: "You", image: undefined },
    changes: [{ field: "name", to: "Trip Circle" }],
  },
];

export const MOCK_TRANSACTION_HISTORY: TransactionHistoryEvent[] = [
  {
    id: "mock-hist-edit" as TransactionHistoryEvent["id"],
    action: "edited",
    createdAt: Date.UTC(2026, 4, 16, 14, 5),
    actor: { displayName: "You", image: undefined },
    changes: [
      { field: "title", from: "Mock transaction", to: "Mock transaction" },
      {
        field: "amount",
        fromMoney: { minorUnits: 1000, currency: "USD" },
        toMoney: { minorUnits: 1250, currency: "USD" },
      },
    ],
  },
  {
    id: "mock-hist-create" as TransactionHistoryEvent["id"],
    action: "created",
    createdAt: Date.UTC(2026, 4, 15, 9, 30),
    actor: { displayName: "You", image: undefined },
    changes: [
      { field: "title", to: "Mock transaction" },
      { field: "amount", toMoney: { minorUnits: 1000, currency: "USD" } },
      { field: "date", to: "2026-05-15" },
      { field: "paidBy", to: "You" },
      { field: "categories", to: "Groceries" },
    ],
  },
];

/** Mock notifications for offline/E2E shell (NTF-1). Typed against the derived
 * {@link Notification} contract so a view-shape change fails typecheck here. */
export const MOCK_NOTIFICATIONS: Notification[] = [
  {
    id: "mock-notif-linked" as Notification["id"],
    type: "transaction.paid_by",
    title: "Paid By updated",
    body: "Alex set you as Paid By on Weekly shop.",
    link: "/circles/trip-mock-personal/transactions/weekly-shop-mock-txn",
    read: false,
    createdAt: Date.UTC(2026, 5, 18, 10, 0),
  },
  {
    id: "mock-notif-text" as Notification["id"],
    type: "member.removed",
    title: "Removed from Circle",
    body: "You were removed from Shared Apartment.",
    link: undefined,
    read: true,
    createdAt: Date.UTC(2026, 5, 17, 8, 30),
  },
];
