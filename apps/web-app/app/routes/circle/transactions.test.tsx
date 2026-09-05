import { api } from "@pocketcircle/convex";
import { addMonths, currentMonth, MUTATION_ERRORS, mutationErrorData } from "@pocketcircle/domain";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { Route } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type Category,
  type Circle,
  type Member,
  type MonthlySummary,
  type PaginationStatus,
  TRANSACTIONS_PAGE_SIZE,
  type Transaction,
  type TransactionFilterOptions,
} from "~/lib/data.js";
import {
  assertFilterOptionsLiveForUrlFilters,
  assertFilterOptionsSkippedUntilPanelOpens,
  assertFilterPanelDiscardsDraftOnClose,
  configureConvex,
  convexReactMock,
  FILTER_OPTIONS_URL_ID_PARAMS,
  FILTER_PANEL_CLOSE_MEDIUMS,
  flushIntersectionObserverStub,
  installIntersectionObserverStub,
  makeCategoryView,
  makeCircleView,
  makeMemberView,
  makeTransactionView,
  pickCombobox,
  renderCircleRoutes,
  testId,
} from "~/test/convex-react.js";
import { archiveWithDoubleCheck, armArchive, confirmArchive } from "~/test/double-check.js";
import {
  posthogSdk,
  primeAnalyticsForTests,
  resetPostHogBoundary,
} from "~/test/posthog-boundary.js";

vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);
vi.mock(
  "convex-helpers/react",
  async () => (await import("~/test/convex-react.js")).convexHelpersReactMock,
);
vi.mock("posthog-js", async () => (await import("~/test/posthog-mock.js")).posthogModuleMock);

import CircleTransactions from "./transactions.js";

beforeEach(async () => {
  await primeAnalyticsForTests();
});

const REF = "trip-c1";
const NOW_MONTH = currentMonth(new Date());
const FILTER_LEDGER = getFunctionName(api.search.filterLedgerTransactions);
/** Matches `assertWritable` in `packages/convex/convex/guard.ts` — realistic prod rejection. */
const ARCHIVED_CIRCLE_ERROR = new ConvexError(mutationErrorData(MUTATION_ERRORS.circleArchived));

const createTransaction = vi.fn();
const archiveTransaction = vi.fn();
const restoreTransaction = vi.fn();
const paginatedLoadMore = vi.fn();

const ROUTES = (
  <>
    <Route path="circles/:circleRef/transactions" element={<CircleTransactions />} />
    {/* Static `new` outranks the dynamic ref (RR7), the create CTA / back-compat target. */}
    <Route path="circles/:circleRef/transactions/new" element={<div>new page</div>} />
    <Route
      path="circles/:circleRef/transactions/:transactionRef"
      element={<div>detail page</div>}
    />
    <Route
      path="circles/:circleRef/transactions/:transactionRef/edit"
      element={<div>edit page</div>}
    />
  </>
);

function setup(
  opts: {
    circle?: Partial<Circle>;
    transactions?: Transaction[];
    filteredTransactions?: Transaction[];
    status?: PaginationStatus;
    monthlySummary?: MonthlySummary | null;
    filterOptions?:
      | TransactionFilterOptions
      | null
      | ((args: Record<string, unknown>) => TransactionFilterOptions | null | undefined);
    initialEntries?: string[];
  } = {},
) {
  const circle = makeCircleView(opts.circle);
  createTransaction.mockReset();
  createTransaction.mockResolvedValue("new-id");
  archiveTransaction.mockReset();
  archiveTransaction.mockResolvedValue("t1");
  restoreTransaction.mockReset();
  restoreTransaction.mockResolvedValue("t1");
  paginatedLoadMore.mockReset();
  configureConvex({
    categories: [makeCategoryView()],
    members: [makeMemberView()],
    transactions: opts.transactions,
    transactionsStatus: opts.status,
    ledgerFilterTransactions: opts.filteredTransactions,
    ledgerFilterStatus: opts.status,
    ledgerFilterOptions: opts.filterOptions ?? makeFilterOptions(),
    ...(opts.monthlySummary === undefined ? {} : { monthlySummary: opts.monthlySummary }),
    loadMore: paginatedLoadMore,
    createTransaction,
    archiveTransaction,
    restoreTransaction,
  });
  const initialEntries = opts.initialEntries ?? [`/circles/${REF}/transactions?month=2026-05`];
  return { circle, ...renderCircleRoutes(circle, ROUTES, { initialEntries }) };
}

function makeFilterOptions(): TransactionFilterOptions {
  return {
    categories: [
      makeCategoryView({ id: testId<Category["id"]>("cat-grocery"), name: "Groceries" }),
      makeCategoryView({
        id: testId<Category["id"]>("cat-rent"),
        name: "Rent",
        status: "archived",
      }),
    ],
    members: [
      makeMemberView({ id: testId<Member["id"]>("mem-you"), displayName: "You" }),
      makeMemberView({
        id: testId<Member["id"]>("mem-alex"),
        displayName: "Alex",
        status: "removed",
      }),
    ],
  };
}

afterEach(() => {
  resetPostHogBoundary();
  vi.useRealTimers();
});

describe("CircleTransactions", () => {
  it("skips ledger filter-options until the filter panel opens", async () => {
    setup();
    await assertFilterOptionsSkippedUntilPanelOpens(api.search.getLedgerFilterOptions);
  });

  it.each(FILTER_OPTIONS_URL_ID_PARAMS)(
    "subscribes ledger filter-options when URL already has %s ids",
    async (param) => {
      const id =
        param === "categories"
          ? testId<Category["id"]>("cat-grocery")
          : testId<Member["id"]>("mem-you");
      setup({
        initialEntries: [`/circles/${REF}/transactions?month=2026-05&${param}=${id}`],
      });
      await assertFilterOptionsLiveForUrlFilters(api.search.getLedgerFilterOptions);
    },
  );

  it("normalizes the bare route to month + default ledger filter params", async () => {
    const { location } = setup({ initialEntries: [`/circles/${REF}/transactions`] });
    await waitFor(() =>
      expect(location()).toBe(
        `/circles/${REF}/transactions?month=${NOW_MONTH}&type=all&status=all`,
      ),
    );
    expect(screen.getByLabelText("Month")).toHaveValue(NOW_MONTH);
  });

  it("shows a row skeleton while the first page loads, then content replaces it", async () => {
    const view = setup({ status: "LoadingFirstPage", filteredTransactions: [] });
    const skeleton = await screen.findByTestId("transactions-skeleton");
    expect(skeleton).toHaveAttribute("aria-busy", "true");
    expect(within(skeleton).getByText(/loading transactions/i)).toBeInTheDocument();

    // Resolve the first page (reconfigure the doubles, re-render the same tree): the
    // skeleton gives way to the real rows.
    configureConvex({
      categories: [makeCategoryView()],
      members: [makeMemberView()],
      ledgerFilterTransactions: [makeTransactionView({ title: "Weekly shop" })],
      ledgerFilterStatus: "Exhausted",
      ledgerFilterOptions: makeFilterOptions(),
      monthlySummary: null,
    });
    view.rerender();
    expect(await screen.findByText("Weekly shop")).toBeInTheDocument();
    expect(screen.queryByTestId("transactions-skeleton")).not.toBeInTheDocument();
  });

  it("drives the list from the ledger filter query with status=all by default", async () => {
    setup({ filteredTransactions: [makeTransactionView({ title: "Weekly shop" })] });

    expect(screen.getByText("Weekly shop")).toBeInTheDocument();
    // One query owns the list — no active-only base-list shortcut — so the unfiltered
    // default is a live status=all read, not skipped.
    await waitFor(() => {
      const filterCall = convexReactMock.usePaginatedQuery.mock.calls.find(
        ([fn]) => getFunctionName(fn) === FILTER_LEDGER,
      );
      expect(filterCall?.[1]).toMatchObject({ status: "all" });
    });
  });

  it("applies ledger filters only when Apply is clicked and leaves monthly totals unchanged", async () => {
    const user = userEvent.setup();
    const { location } = setup({
      filteredTransactions: [makeTransactionView({ title: "Rent payment" })],
      monthlySummary: {
        totals: { incomeMinor: 0, expenseMinor: 12_500, netMinor: -12_500 },
        currency: "USD",
      },
    });

    await user.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search title or note" }), {
      target: { value: "rent" },
    });
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(location()).toBe(
      `/circles/${REF}/transactions?month=2026-05&type=all&status=all&q=rent`,
    );
    expect(posthogSdk.capture).toHaveBeenCalledWith(
      "ledger_filter_applied",
      expect.objectContaining({
        type: "all",
        status: "all",
        hasQuery: true,
        categoryCount: 0,
      }),
    );
    expect(screen.getByText("Rent payment")).toBeInTheDocument();
    // Expense + Net both contain `$125.00`; assert the accessible totals stay put.
    expect(screen.getAllByText(/\$125\.00/, { selector: ".sr-only" })).toHaveLength(2);
  });

  it("applies a category filter from the combobox to the URL", async () => {
    const user = userEvent.setup();
    const { location } = setup({
      initialEntries: [`/circles/${REF}/transactions?month=2026-05`],
    });

    await user.click(screen.getByRole("button", { name: "Filters" }));
    const dialog = screen.getByRole("dialog", { name: "Filters" });
    await pickCombobox(user, dialog, "Categories", "Groceries");
    await user.click(within(dialog).getByRole("button", { name: "Apply" }));

    expect(location()).toMatch(/categories=cat-grocery/);
  });

  it("filters category options by detail text, not just label", async () => {
    const user = userEvent.setup();
    setup({ initialEntries: [`/circles/${REF}/transactions?month=2026-05`] });

    await user.click(screen.getByRole("button", { name: "Filters" }));
    const dialog = screen.getByRole("dialog", { name: "Filters" });
    const combobox = within(dialog).getByRole("combobox", { name: "Categories" });
    await user.click(combobox);
    await user.type(combobox, "archived");

    // "archived" matches Rent's detail marker only — its label doesn't contain it.
    expect(await screen.findByRole("option", { name: /Rent/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Groceries/ })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
  });

  it("labels removed vs deleted account members in Paid by filters", async () => {
    const user = userEvent.setup();
    setup({
      filterOptions: {
        ...makeFilterOptions(),
        members: [
          makeMemberView({ id: testId<Member["id"]>("mem-you"), displayName: "You" }),
          makeMemberView({
            id: testId<Member["id"]>("mem-alex"),
            displayName: "Alex",
            status: "removed",
          }),
          makeMemberView({
            id: testId<Member["id"]>("mem-rex"),
            displayName: "Rex",
            status: "deleted",
          }),
        ],
      },
      initialEntries: [`/circles/${REF}/transactions?month=2026-05`],
    });

    await user.click(screen.getByRole("button", { name: "Filters" }));
    const dialog = screen.getByRole("dialog", { name: "Filters" });
    const combobox = within(dialog).getByRole("combobox", { name: "Paid by" });
    await user.click(combobox);

    expect(await screen.findByText("removed")).toBeInTheDocument();
    expect(screen.getByText("deleted account")).toBeInTheDocument();
    await user.keyboard("{Escape}");
  });

  it("resets filters when the selected month changes", async () => {
    const user = userEvent.setup();
    const { location } = setup({
      initialEntries: [
        `/circles/${REF}/transactions?month=2026-05&type=expense&status=archived&q=rent`,
      ],
    });

    await user.click(screen.getByRole("button", { name: "Previous month" }));
    expect(location()).toBe(
      `/circles/${REF}/transactions?month=${addMonths("2026-05", -1)}&type=all&status=all`,
    );
  });

  it("resets from the panel immediately to canonical defaults", async () => {
    const user = userEvent.setup();
    const { location } = setup({
      initialEntries: [
        `/circles/${REF}/transactions?month=2026-05&type=expense&status=archived&q=rent`,
      ],
    });

    await user.click(screen.getByRole("button", { name: /Filters/ }));
    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(location()).toBe(`/circles/${REF}/transactions?month=2026-05&type=all&status=all`);
  });

  it("carries the full ledger URL (filters + month) to the detail route as returnTo", async () => {
    const user = userEvent.setup();
    const origin = `/circles/${REF}/transactions?month=2026-05&type=expense&status=archived&q=rent`;
    const txn = makeTransactionView({ ref: "weekly-shop-t1", title: "Weekly shop" });
    const { location } = setup({ filteredTransactions: [txn], initialEntries: [origin] });

    await user.click(screen.getByRole("link", { name: "View Weekly shop" }));
    const dest = new URL(location(), "http://t");
    expect(dest.pathname).toBe(`/circles/${REF}/transactions/weekly-shop-t1`);
    // The exact origin (all of its filter state) round-trips so the detail's Back returns here.
    expect(dest.searchParams.get("returnTo")).toBe(origin);
  });

  it("navigates the add CTA to the dedicated create route, carrying month + ledger returnTo", async () => {
    const user = userEvent.setup();
    const origin = `/circles/${REF}/transactions?month=2026-05&type=expense&status=archived&q=rent`;
    const { location } = setup({ initialEntries: [origin] });
    await user.click(screen.getByRole("link", { name: "Add expense" }));
    const dest = new URL(location(), "http://t");
    expect(dest.pathname).toBe(`/circles/${REF}/transactions/new`);
    expect(dest.searchParams.get("type")).toBe("expense");
    // The selected month feeds the create form's date default.
    expect(dest.searchParams.get("month")).toBe("2026-05");
    // The exact filtered ledger round-trips so the create page's close returns here.
    expect(dest.searchParams.get("returnTo")).toBe(origin);
  });

  it("redirects an old ?new=expense deep link to the create route (back-compat)", async () => {
    const { location } = setup({
      initialEntries: [
        `/circles/${REF}/transactions?month=2026-05&type=all&status=all&new=expense`,
      ],
    });
    await waitFor(() => {
      const dest = new URL(location(), "http://t");
      expect(dest.pathname).toBe(`/circles/${REF}/transactions/new`);
      expect(dest.searchParams.get("type")).toBe("expense");
      expect(dest.searchParams.get("month")).toBe("2026-05");
      // The returnTo origin is the clean ledger URL with `new` stripped.
      expect(dest.searchParams.get("returnTo")).toBe(
        `/circles/${REF}/transactions?month=2026-05&type=all&status=all`,
      );
    });
  });

  it("scrubs an invalid ?new value without redirecting", async () => {
    const { location } = setup({
      initialEntries: [`/circles/${REF}/transactions?month=2026-05&type=all&status=all&new=bogus`],
    });
    await waitFor(() =>
      expect(location()).toBe(`/circles/${REF}/transactions?month=2026-05&type=all&status=all`),
    );
  });

  it("archives and restores ledger rows through lifecycle actions", async () => {
    const user = userEvent.setup();
    setup({
      initialEntries: [`/circles/${REF}/transactions?month=2026-05&type=all&status=archived`],
      filteredTransactions: [
        makeTransactionView({ title: "Old buy", status: "archived", canArchive: true }),
      ],
    });

    await user.click(screen.getByRole("button", { name: "Restore Old buy" }));
    expect(restoreTransaction).toHaveBeenCalledWith({
      transactionId: testId<Transaction["id"]>("t1"),
    });
  });

  it("clears the busy label after a lifecycle action when the row flips in place (#82)", async () => {
    const user = userEvent.setup();
    // The mixed status=all view keeps the row mounted across the archive: its `<li key>`
    // is the stable id, so the LifecycleButton instance (and its in-flight flag) survives
    // the reactive flip from active→archived.
    const { rerender } = setup({
      initialEntries: [`/circles/${REF}/transactions?month=2026-05&type=all&status=all`],
      filteredTransactions: [
        makeTransactionView({ title: "Weekly shop", status: "active", canArchive: true }),
      ],
    });

    await archiveWithDoubleCheck(user, "Weekly shop");
    expect(archiveTransaction).toHaveBeenCalledWith({
      transactionId: testId<Transaction["id"]>("t1"),
    });

    // The reactive ledger query pushes the now-archived row; Convex delivers a fresh page
    // snapshot (new array reference), so re-seed the mock before rerendering.
    configureConvex({
      categories: [makeCategoryView()],
      members: [makeMemberView()],
      ledgerFilterTransactions: [
        makeTransactionView({ title: "Weekly shop", status: "archived", canArchive: true }),
      ],
      ledgerFilterOptions: makeFilterOptions(),
      loadMore: paginatedLoadMore,
      createTransaction,
      archiveTransaction,
      restoreTransaction,
    });
    rerender();

    // The button must settle on the new action's IDLE label — not strand on the opposite
    // action's busy label ("Restoring…"/"Archiving…") because the in-flight flag was never
    // cleared on success (#82). Accessible name is always the idle copy, so assert the
    // VISIBLE text and that the button is interactive again.
    const button = await screen.findByRole("button", { name: "Restore Weekly shop" });
    await waitFor(() => expect(button).toBeEnabled());
    expect(button).toHaveTextContent(/^Restore$/);
  });

  it("offers per-row lifecycle actions and an archived marker in the mixed status=all view", () => {
    setup({
      initialEntries: [`/circles/${REF}/transactions?month=2026-05&type=all&status=all`],
      filteredTransactions: [
        makeTransactionView({ ref: "active-t", title: "Active buy", status: "active" }),
        makeTransactionView({
          id: testId<Transaction["id"]>("t2"),
          ref: "archived-t",
          title: "Archived buy",
          status: "archived",
        }),
      ],
    });

    // A row's action is derived from its own status, so the mixed list isn't a dead view:
    // active rows Archive, archived rows Restore.
    expect(screen.getByRole("button", { name: "Archive Active buy" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore Archived buy" })).toBeInTheDocument();

    // The archived row is distinguished by an "Archived" marker so the mixed default view
    // stays readable; the active row carries none, so exactly one marker shows. The marker
    // sits on the archived row (its `<li>` also holds that row's "Archived buy" title).
    const marker = screen.getByText("Archived", { exact: true });
    expect(screen.getAllByText("Archived", { exact: true })).toHaveLength(1);
    expect(marker.closest("li")).toHaveTextContent("Archived buy");
  });

  it("does not rewrite applied filters when the open panel's draft type changes the options", async () => {
    const user = userEvent.setup();
    const url = `/circles/${REF}/transactions?month=2026-05&type=expense&status=active&categories=cat-grocery`;
    const { location } = setup({
      initialEntries: [url],
      filteredTransactions: [makeTransactionView({ title: "Weekly shop" })],
      // Options narrow by type: the applied expense category vanishes from the income set.
      filterOptions: (args) =>
        args.type === "income"
          ? {
              categories: [
                makeCategoryView({ id: testId<Category["id"]>("cat-salary"), name: "Salary" }),
              ],
              members: [
                makeMemberView({ id: testId<Member["id"]>("mem-you"), displayName: "You" }),
              ],
            }
          : {
              categories: [
                makeCategoryView({ id: testId<Category["id"]>("cat-grocery"), name: "Groceries" }),
              ],
              members: [
                makeMemberView({ id: testId<Member["id"]>("mem-you"), displayName: "You" }),
              ],
            },
    });

    await waitFor(() => expect(location()).toBe(url));

    await user.click(screen.getByRole("button", { name: /Filters/ }));
    await user.click(screen.getByRole("button", { name: "Income" }));

    // Draft edits never touch the applied URL — the still-applied expense category survives
    // even though the income draft's option set no longer contains it.
    expect(location()).toBe(url);
  });

  it.each(FILTER_PANEL_CLOSE_MEDIUMS)(
    "discards unapplied panel edits when the panel is closed via %s",
    async (medium) => {
      const user = userEvent.setup();
      const { location } = setup({
        initialEntries: [`/circles/${REF}/transactions?month=2026-05&type=all&status=all`],
        filteredTransactions: [makeTransactionView({ title: "Weekly shop" })],
      });

      await assertFilterPanelDiscardsDraftOnClose({ user, medium, location });
    },
  );

  it("hides write actions in archived circles", () => {
    setup({ circle: { status: "archived" }, filteredTransactions: [makeTransactionView()] });
    expect(screen.queryByRole("link", { name: "Add expense" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Add income" })).not.toBeInTheDocument();
    expect(screen.getByText(/circle is archived/i)).toBeInTheDocument();
    expect(within(screen.getByRole("listitem")).queryByRole("link", { name: /Edit/ })).toBeNull();
  });

  it("surfaces archived-circle rejection on archive and re-enables the button", async () => {
    const user = userEvent.setup();
    setup({
      initialEntries: [`/circles/${REF}/transactions?month=2026-05&type=all&status=all`],
      filteredTransactions: [
        makeTransactionView({ title: "Weekly shop", status: "active", canArchive: true }),
      ],
    });
    archiveTransaction.mockRejectedValue(ARCHIVED_CIRCLE_ERROR);
    await archiveWithDoubleCheck(user, "Weekly shop");
    expect(await screen.findByText(MUTATION_ERRORS.circleArchived.message)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Archive Weekly shop" })).toBeEnabled(),
    );
    archiveTransaction.mockClear();
    await armArchive(user, "Weekly shop");
    await confirmArchive(user, "Weekly shop");
    expect(archiveTransaction).toHaveBeenCalledTimes(1);
  });

  it("requires arm then confirm before archiving a transaction", async () => {
    const user = userEvent.setup();
    setup({
      initialEntries: [`/circles/${REF}/transactions?month=2026-05&type=all&status=all`],
      filteredTransactions: [
        makeTransactionView({ title: "Weekly shop", status: "active", canArchive: true }),
      ],
    });

    await armArchive(user, "Weekly shop");
    expect(archiveTransaction).not.toHaveBeenCalled();
    const armed = screen.getByRole("button", { name: "Confirm archive Weekly shop" });
    expect(armed).toHaveTextContent("Confirm archive");
    expect(armed).toHaveClass("bg-destructive");

    await confirmArchive(user, "Weekly shop");
    expect(archiveTransaction).toHaveBeenCalledWith({
      transactionId: testId<Transaction["id"]>("t1"),
    });
  });

  it("auto-resets armed archive after the timeout", () => {
    vi.useFakeTimers();
    setup({
      initialEntries: [`/circles/${REF}/transactions?month=2026-05&type=all&status=all`],
      filteredTransactions: [
        makeTransactionView({ title: "Weekly shop", status: "active", canArchive: true }),
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "Archive Weekly shop" }));
    act(() => {
      vi.advanceTimersByTime(10_001);
    });
    expect(screen.getByRole("button", { name: "Archive Weekly shop" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Archive Weekly shop" }));
    expect(archiveTransaction).not.toHaveBeenCalled();
  });

  it("resets armed archive on blur", async () => {
    const user = userEvent.setup();
    setup({
      initialEntries: [`/circles/${REF}/transactions?month=2026-05&type=all&status=all`],
      filteredTransactions: [
        makeTransactionView({ title: "Weekly shop", status: "active", canArchive: true }),
      ],
    });

    await armArchive(user, "Weekly shop");
    fireEvent.blur(screen.getByRole("button", { name: "Confirm archive Weekly shop" }));
    expect(screen.getByRole("button", { name: "Archive Weekly shop" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Archive Weekly shop" }));
    expect(archiveTransaction).not.toHaveBeenCalled();
  });

  it("resets armed archive on Escape", async () => {
    const user = userEvent.setup();
    setup({
      initialEntries: [`/circles/${REF}/transactions?month=2026-05&type=all&status=all`],
      filteredTransactions: [
        makeTransactionView({ title: "Weekly shop", status: "active", canArchive: true }),
      ],
    });

    await armArchive(user, "Weekly shop");
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Archive Weekly shop" })).toBeInTheDocument();
  });

  it("surfaces archived-circle rejection on restore and re-enables the button", async () => {
    const user = userEvent.setup();
    setup({
      initialEntries: [`/circles/${REF}/transactions?month=2026-05&type=all&status=archived`],
      filteredTransactions: [
        makeTransactionView({ title: "Old buy", status: "archived", canArchive: true }),
      ],
    });
    restoreTransaction.mockRejectedValue(ARCHIVED_CIRCLE_ERROR);
    await user.click(screen.getByRole("button", { name: "Restore Old buy" }));
    expect(await screen.findByText(MUTATION_ERRORS.circleArchived.message)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Restore Old buy" })).toBeEnabled(),
    );
  });
});

describe("CircleTransactions — infinite scroll pagination", () => {
  installIntersectionObserverStub();

  it("loads the next page when the sentinel intersects (loadMore with page size)", () => {
    setup({ filteredTransactions: [makeTransactionView()], status: "CanLoadMore" });
    expect(screen.getByTestId("transactions-infinite-scroll-sentinel")).toBeInTheDocument();
    flushIntersectionObserverStub(true);
    expect(paginatedLoadMore).toHaveBeenCalledWith(TRANSACTIONS_PAGE_SIZE);
  });

  it("does not call loadMore when the observer reports no intersection", () => {
    setup({ filteredTransactions: [makeTransactionView()], status: "CanLoadMore" });
    flushIntersectionObserverStub(false);
    expect(paginatedLoadMore).not.toHaveBeenCalled();
  });

  it("shows loading status while LoadingMore; no sentinel and no Load more button", () => {
    setup({ filteredTransactions: [makeTransactionView()], status: "LoadingMore" });
    expect(screen.getByRole("status", { name: "Transaction list" })).toHaveTextContent(
      /loading more transactions/i,
    );
    expect(screen.queryByTestId("transactions-infinite-scroll-sentinel")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("hides sentinel when exhausted; live region without loading copy", () => {
    setup({ filteredTransactions: [makeTransactionView()], status: "Exhausted" });
    expect(screen.queryByTestId("transactions-infinite-scroll-sentinel")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Transaction list" })).not.toHaveTextContent(
      /loading more/i,
    );
  });
});
