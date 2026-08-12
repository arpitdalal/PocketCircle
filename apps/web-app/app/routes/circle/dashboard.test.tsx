import { currentMonth } from "@pocketcircle/domain";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CategoryAnalytics,
  Dashboard,
  Member,
  MonthlyComparison,
  Transaction,
} from "~/lib/data.js";
import {
  configureConvex,
  makeCircleView,
  makeTransactionView,
  renderCircleRoutes,
  renderInCircle,
  testId,
} from "~/test/convex-react.js";

/**
 * Behavior test for the Dashboard route (jsdom). Doubles ONLY Convex's reactive client
 * (via the shared helper) and runs the REAL route + real `~/lib/data.js` hooks against
 * it (ADR 0006), so the totals cards and recent feed are exercised exactly as in the app.
 */
vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);

import CircleDashboard from "./dashboard.js";

function makeDashboard(over: Partial<Dashboard> = {}): Dashboard {
  return {
    totals: { incomeMinor: 500_000, expenseMinor: 8_750, netMinor: 491_250 },
    recent: [],
    currency: "USD",
    month: "2026-06",
    ...over,
  };
}

afterEach(() => {
  // restoreAllMocks (not just clear) so a per-test navigator.language spy does not
  // leak its locale into later tests.
  vi.restoreAllMocks();
});

describe("Dashboard totals", () => {
  it("renders Income / Expenses / Net formatted in the Circle Currency", () => {
    configureConvex({ dashboard: makeDashboard() });
    renderInCircle(makeCircleView(), <CircleDashboard />);

    expect(screen.getByText("$5,000.00")).toBeInTheDocument(); // income
    expect(screen.getByText("$87.50")).toBeInTheDocument(); // expenses
    expect(screen.getByText("$4,912.50")).toBeInTheDocument(); // net
  });

  it("formats money in the viewer locale, disambiguating USD for a non-US viewer", () => {
    // The viewer's locale (navigator.language) drives presentation, NOT the
    // ambient runtime locale (ADR 0021). A Canadian-style viewer sees USD
    // qualified as US$ so it is not confused with the local dollar.
    vi.spyOn(window.navigator, "language", "get").mockReturnValue("en-CA");
    configureConvex({ dashboard: makeDashboard() });
    renderInCircle(makeCircleView(), <CircleDashboard />);

    expect(screen.getByText("US$5,000.00")).toBeInTheDocument(); // income
    expect(screen.getByText("US$87.50")).toBeInTheDocument(); // expenses
  });

  it("shows skeletons while the dashboard loads", () => {
    // A function returning `undefined` models the reactive query still loading
    // (passing `dashboard: undefined` would hit the helper's EMPTY_DASHBOARD default).
    configureConvex({
      dashboard: () => undefined,
      monthlyComparison: () => undefined,
      categoryAnalytics: () => undefined,
    });
    renderInCircle(makeCircleView(), <CircleDashboard />);

    // The totals grid reads as busy and the recent feed shows its skeleton placeholder.
    expect(screen.getByText(/this month's totals/i).closest("fieldset")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByTestId("recent-skeleton")).toBeInTheDocument();
    expect(screen.getByTestId("category-analytics-skeleton")).toBeInTheDocument();
    // Exactly ONE polite announcement covers the whole surface (not one per widget),
    // and the per-widget placeholders stay out of the a11y tree (aria-hidden).
    const statuses = screen.getAllByRole("status");
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toHaveTextContent(/loading dashboard/i);
  });
});

describe("Dashboard recent feed", () => {
  it("renders recent rows with title, paid-by, and signed amount", () => {
    const recent: Transaction[] = [
      makeTransactionView({
        id: testId<Transaction["id"]>("t-income"),
        type: "income",
        title: "Paycheck",
        ref: "paycheck-t1",
        amountMinorUnits: 500_000,
        paidBy: { id: testId<Member["id"]>("mem-you"), displayName: "You", image: undefined },
      }),
      makeTransactionView({
        id: testId<Transaction["id"]>("t-expense"),
        type: "expense",
        title: "Groceries",
        ref: "groceries-t1",
        amountMinorUnits: 7_350,
        paidBy: { id: testId<Member["id"]>("mem-alex"), displayName: "Alex", image: undefined },
      }),
    ];
    configureConvex({ dashboard: makeDashboard({ recent }) });
    // Seed the address bar with the Dashboard's own URL so each row's `returnTo` (#123) is
    // the realistic origin a detail Back would return to.
    const origin = "/circles/trip-c1";
    renderInCircle(makeCircleView(), <CircleDashboard />, { initialEntries: [origin] });

    const feed = screen.getByRole("region", { name: /recent activity/i });
    const paycheck = within(feed).getByRole("link", { name: /view paycheck/i });
    expect(new URL(paycheck.getAttribute("href") ?? "", "http://t").pathname).toBe(
      "/circles/trip-c1/transactions/paycheck-t1",
    );
    expect(
      new URL(paycheck.getAttribute("href") ?? "", "http://t").searchParams.get("returnTo"),
    ).toBe(origin);
    expect(within(feed).getByText("+$5,000.00")).toBeInTheDocument();
    expect(within(feed).getByText("Groceries")).toBeInTheDocument();
    expect(within(feed).getByText("-$73.50")).toBeInTheDocument();
    expect(within(feed).getByText(/Alex/)).toBeInTheDocument();
  });

  it("shows an empty state when there is no recent activity", () => {
    configureConvex({ dashboard: makeDashboard({ recent: [] }) });
    renderInCircle(makeCircleView(), <CircleDashboard />);
    expect(screen.getByText(/no recent activity/i)).toBeInTheDocument();
  });
});

describe("Dashboard month-over-month comparison (RPT-4)", () => {
  /** A fixed three-month series so labels/amounts are deterministic regardless of
   * the runner's clock (the route asks for the CURRENT month's window, but the
   * surface renders whatever series the backend returns). */
  const THREE_MONTHS: MonthlyComparison = {
    series: [
      { month: "2026-04", incomeMinor: 500_000, expenseMinor: 1_250, netMinor: 498_750 },
      { month: "2026-05", incomeMinor: 0, expenseMinor: 7_500, netMinor: -7_500 },
      { month: "2026-06", incomeMinor: 2_000, expenseMinor: 9_000, netMinor: -7_000 },
    ],
    currency: "USD",
  };

  it("renders the chronological series with money formatted in the Circle Currency", () => {
    configureConvex({ monthlyComparison: THREE_MONTHS });
    renderInCircle(makeCircleView(), <CircleDashboard />);

    const section = screen.getByRole("region", { name: /month-over-month/i });
    const rows = within(section).getAllByRole("row");
    // Header row + one row per month, chronological.
    expect(rows).toHaveLength(4);
    expect(rows[1]).toHaveTextContent("April 2026");
    expect(rows[1]).toHaveTextContent("$5,000.00");
    expect(rows[1]).toHaveTextContent("$12.50");
    expect(rows[1]).toHaveTextContent("$4,987.50");
    expect(rows[2]).toHaveTextContent("May 2026");
    expect(rows[2]).toHaveTextContent("-$75.00"); // negative net
    expect(rows[3]).toHaveTextContent("June 2026");
  });

  it("defaults the Comparison Range to 6 months and offers 1/3/6/12", () => {
    configureConvex({});
    renderInCircle(makeCircleView(), <CircleDashboard />);

    const select = screen.getByLabelText(/range/i);
    expect(select).toHaveValue("6");
    const labels = within(select)
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(labels).toEqual(["1 month", "3 months", "6 months", "12 months"]);
  });

  it("re-queries the series for the selected range", async () => {
    // The double's default models the backend: a zero series sized to the queried
    // rangeMonths — so the month count visible in the table tracks the selection.
    configureConvex({});
    renderInCircle(makeCircleView(), <CircleDashboard />);

    const section = screen.getByRole("region", { name: /month-over-month/i });
    expect(within(section).getAllByRole("row")).toHaveLength(7); // header + 6

    await userEvent.selectOptions(screen.getByLabelText(/range/i), "3");
    expect(within(section).getAllByRole("row")).toHaveLength(4); // header + 3

    await userEvent.selectOptions(screen.getByLabelText(/range/i), "12");
    expect(within(section).getAllByRole("row")).toHaveLength(13); // header + 12
  });

  it("shows a skeleton while the comparison loads", () => {
    configureConvex({ monthlyComparison: () => undefined });
    renderInCircle(makeCircleView(), <CircleDashboard />);
    expect(screen.getByTestId("comparison-skeleton")).toBeInTheDocument();
  });

  it("formats the series in the viewer locale", () => {
    vi.spyOn(window.navigator, "language", "get").mockReturnValue("en-CA");
    configureConvex({ monthlyComparison: THREE_MONTHS });
    renderInCircle(makeCircleView(), <CircleDashboard />);

    const section = screen.getByRole("region", { name: /month-over-month/i });
    expect(within(section).getAllByRole("row")[1]).toHaveTextContent("US$5,000.00");
  });
});

describe("Dashboard category analytics (RPT-5)", () => {
  const SAMPLE: CategoryAnalytics = {
    currency: "USD",
    rows: [
      {
        categoryId: testId<CategoryAnalytics["rows"][number]["categoryId"]>("cat-groceries"),
        name: "Groceries",
        color: "green",
        status: "active",
        taggedTotalMinor: 7_350,
        txnCount: 2,
      },
      {
        categoryId: testId<CategoryAnalytics["rows"][number]["categoryId"]>("cat-dining"),
        name: "Dining",
        color: "orange",
        status: "archived",
        taggedTotalMinor: 4_200,
        txnCount: 1,
      },
    ],
  };

  it("renders ranked tagged spend with money formatted and archived badge", () => {
    configureConvex({ categoryAnalytics: SAMPLE });
    renderInCircle(makeCircleView(), <CircleDashboard />);

    const section = screen.getByRole("region", { name: /tagged spend by category/i });
    expect(within(section).getByText("Groceries")).toBeInTheDocument();
    expect(within(section).getByText("$73.50")).toBeInTheDocument();
    expect(within(section).getByText("Dining")).toBeInTheDocument();
    expect(within(section).getByText("Archived")).toBeInTheDocument();
    expect(within(section).getByText(/totals are not additive/i)).toBeInTheDocument();
  });

  it("defaults the type toggle to expenses and offers income", () => {
    configureConvex({ categoryAnalytics: SAMPLE });
    renderInCircle(makeCircleView(), <CircleDashboard />);

    const select = screen.getByLabelText(/^type$/i);
    expect(select).toHaveValue("expense");
    const labels = within(select)
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(labels).toEqual(["Expenses", "Income"]);
  });

  it("re-queries category analytics for the selected type", async () => {
    configureConvex({
      categoryAnalytics: (args) =>
        args.type === "income"
          ? {
              currency: "USD",
              rows: [
                {
                  categoryId: testId<CategoryAnalytics["rows"][number]["categoryId"]>("cat-salary"),
                  name: "Salary",
                  color: "teal",
                  status: "active",
                  taggedTotalMinor: 500_000,
                  txnCount: 1,
                },
              ],
            }
          : SAMPLE,
    });
    renderInCircle(makeCircleView(), <CircleDashboard />);

    expect(screen.getByText("$73.50")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText(/^type$/i), "income");
    expect(screen.getByText("$5,000.00")).toBeInTheDocument();
    expect(screen.queryByText("$73.50")).not.toBeInTheDocument();
  });

  it("shows a skeleton while category analytics loads", () => {
    configureConvex({ categoryAnalytics: () => undefined });
    renderInCircle(makeCircleView(), <CircleDashboard />);
    expect(screen.getByTestId("category-analytics-skeleton")).toBeInTheDocument();
  });

  it("shows an empty state when there is no tagged spend", () => {
    configureConvex({ categoryAnalytics: { currency: "USD", rows: [] } });
    renderInCircle(makeCircleView(), <CircleDashboard />);
    expect(screen.getByText(/no tagged spend for this period/i)).toBeInTheDocument();
  });
});

describe("Dashboard URL state (range + type)", () => {
  const ROUTES = <Route path="circles/:circleRef" element={<CircleDashboard />} />;

  function setup(initialSearch = "") {
    return renderCircleRoutes(makeCircleView(), ROUTES, {
      initialEntries: [`/circles/trip-c1${initialSearch}`],
    });
  }

  it("restores a deep-linked range and queries with it", () => {
    configureConvex({
      monthlyComparison: (args) =>
        args.rangeMonths === 3
          ? {
              series: [{ month: "2026-06", incomeMinor: 0, expenseMinor: 4_200, netMinor: -4_200 }],
              currency: "USD",
            }
          : { series: [], currency: "USD" },
    });
    setup("?range=3");

    expect(screen.getByLabelText(/range/i)).toHaveValue("3");
    const section = screen.getByRole("region", { name: /month-over-month/i });
    expect(within(section).getByText("-$42.00")).toBeInTheDocument();
  });

  it("writes selections to the URL and clears them back to a bare URL on defaults", async () => {
    configureConvex({});
    const view = setup();

    await userEvent.selectOptions(screen.getByLabelText(/range/i), "12");
    expect(view.location()).toBe("/circles/trip-c1?range=12");

    await userEvent.selectOptions(screen.getByLabelText(/^type$/i), "income");
    expect(view.location()).toBe("/circles/trip-c1?range=12&type=income");

    // Back to the defaults: the params drop, leaving the canonical bare URL.
    await userEvent.selectOptions(screen.getByLabelText(/range/i), "6");
    await userEvent.selectOptions(screen.getByLabelText(/^type$/i), "expense");
    expect(view.location()).toBe("/circles/trip-c1");
  });

  it("falls back to the default range for an unsupported range param", () => {
    configureConvex({});
    setup("?range=9");
    expect(screen.getByLabelText(/range/i)).toHaveValue("6");
  });

  it("strips legacy paidBy from the URL while preserving range and type", async () => {
    configureConvex({});
    const view = setup("?paidBy=mem-ghost&range=3&type=income");

    await waitFor(() => expect(view.location()).toBe("/circles/trip-c1?range=3&type=income"));
    expect(screen.getByLabelText(/range/i)).toHaveValue("3");
    expect(screen.getByLabelText(/^type$/i)).toHaveValue("income");
  });

  it("strips legacy paidBy while preserving unrelated query params", async () => {
    configureConvex({});
    const view = setup("?paidBy=mem-ghost&utm=campaign");

    await waitFor(() => expect(view.location()).toBe("/circles/trip-c1?utm=campaign"));
  });

  it("restores a deep-linked category analytics type and queries with it", () => {
    configureConvex({
      categoryAnalytics: (args) =>
        args.type === "income"
          ? {
              currency: "USD",
              rows: [
                {
                  categoryId: testId<CategoryAnalytics["rows"][number]["categoryId"]>("cat-salary"),
                  name: "Salary",
                  color: "teal",
                  status: "active",
                  taggedTotalMinor: 500_000,
                  txnCount: 1,
                },
              ],
            }
          : { currency: "USD", rows: [] },
    });
    setup("?type=income");

    expect(screen.getByLabelText(/^type$/i)).toHaveValue("income");
    expect(screen.getByText("$5,000.00")).toBeInTheDocument();
  });
});

describe("Dashboard drilldowns (RPT-6)", () => {
  const THREE_MONTHS: MonthlyComparison = {
    series: [
      { month: "2026-04", incomeMinor: 500_000, expenseMinor: 1_250, netMinor: 498_750 },
      { month: "2026-05", incomeMinor: 0, expenseMinor: 7_500, netMinor: -7_500 },
      { month: "2026-06", incomeMinor: 2_000, expenseMinor: 9_000, netMinor: -7_000 },
    ],
    currency: "USD",
  };

  const SAMPLE: CategoryAnalytics = {
    currency: "USD",
    rows: [
      {
        categoryId: testId<CategoryAnalytics["rows"][number]["categoryId"]>("cat-groceries"),
        name: "Groceries",
        color: "green",
        status: "active",
        taggedTotalMinor: 7_350,
        txnCount: 2,
      },
    ],
  };

  function hrefOf(link: HTMLElement) {
    return new URL(link.getAttribute("href") ?? "", "http://t");
  }

  it("links a category name to the current-month Ledger filtered by category and type", () => {
    configureConvex({ categoryAnalytics: SAMPLE });
    renderInCircle(makeCircleView(), <CircleDashboard />);

    const link = screen.getByRole("link", { name: /view groceries transactions/i });
    const url = hrefOf(link);
    expect(url.pathname).toBe("/circles/trip-c1/transactions");
    expect(url.searchParams.get("month")).toBe(currentMonth(new Date()));
    expect(url.searchParams.get("categories")).toBe("cat-groceries");
    expect(url.searchParams.get("type")).toBe("expense");
  });

  it("keeps the comparison chart aria-hidden with a non-interactive sr-only data table", () => {
    configureConvex({ monthlyComparison: THREE_MONTHS });
    renderInCircle(makeCircleView(), <CircleDashboard />);

    const section = screen.getByRole("region", { name: /month-over-month/i });
    expect(
      section.querySelector('[aria-hidden="true"] .recharts-responsive-container'),
    ).toBeTruthy();
    expect(within(section).queryAllByRole("link")).toHaveLength(0);
    const dataTable = within(section).getByRole("table", {
      name: /month-over-month income, expense, and net/i,
    });
    expect(within(dataTable).queryByRole("link")).toBeNull();
    expect(within(dataTable).getByRole("row", { name: /may 2026/i })).toBeTruthy();
  });

  it("renders no drilldown links when comparison or category analytics are empty", () => {
    configureConvex({
      monthlyComparison: { series: [], currency: "USD" },
      categoryAnalytics: { currency: "USD", rows: [] },
    });
    renderInCircle(makeCircleView(), <CircleDashboard />);

    const comparison = screen.getByRole("region", { name: /month-over-month/i });
    expect(within(comparison).queryAllByRole("link")).toHaveLength(0);
    expect(screen.queryByRole("link", { name: /view .* transactions/i })).not.toBeInTheDocument();
  });
});
