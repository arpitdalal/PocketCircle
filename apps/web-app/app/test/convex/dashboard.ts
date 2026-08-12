import { api } from "@pocketcircle/convex";
import {
  comparisonWindowMonths,
  DEFAULT_COMPARISON_RANGE_MONTHS,
  isComparisonRangeMonths,
} from "@pocketcircle/domain";
import { getFunctionName } from "convex/server";
import type { CategoryAnalytics, Dashboard, MonthlyComparison } from "~/lib/data.js";
import type { EntityDouble } from "./contract.js";
import { resolveWith } from "./contract.js";

/** A zero Dashboard — the default for tests that don't drive Dashboard state. */
const EMPTY_DASHBOARD: Dashboard = {
  totals: { incomeMinor: 0, expenseMinor: 0, netMinor: 0 },
  recent: [],
  currency: "USD",
  month: "2026-06",
};

/**
 * A zero-filled comparison series for the queried window — the `getMonthlyComparison`
 * default, modelling the backend contract (chronological, zero-filled, ending at
 * `endMonth`) so Dashboard tests that don't drive the chart still render it over the
 * window the route actually requested. The window comes from the same domain helper
 * the backend uses (its math is covered by the domain + convex suites).
 */
function emptyMonthlyComparison(args: Record<string, unknown>): MonthlyComparison {
  const endMonth = typeof args.endMonth === "string" ? args.endMonth : "2026-06";
  const parsedRange = Number(args.rangeMonths);
  const rangeMonths = isComparisonRangeMonths(parsedRange)
    ? parsedRange
    : DEFAULT_COMPARISON_RANGE_MONTHS;
  return {
    series: comparisonWindowMonths(endMonth, rangeMonths).map((month) => ({
      month,
      incomeMinor: 0,
      expenseMinor: 0,
      netMinor: 0,
    })),
    currency: "USD",
  };
}

/** A zero category analytics result — the default for tests that don't drive RPT-5. */
const EMPTY_CATEGORY_ANALYTICS: CategoryAnalytics = {
  rows: [],
  currency: "USD",
};

export interface DashboardState {
  /** `getDashboard` result; `undefined` ≡ loading, `null` ≡ inaccessible Circle.
   * Defaults to a zero Dashboard so the totals cards render. A function resolves per
   * query args so a test can model arg-driven results without a loading gap. */
  dashboard?: Dashboard | null | ((args: Record<string, unknown>) => Dashboard | null | undefined);
  /** `getMonthlyComparison` result (RPT-4); `undefined` ≡ loading, `null` ≡ inaccessible
   * Circle. Defaults to a zero series over the queried window so the chart renders. A
   * function resolves per query args (e.g. by `rangeMonths`) so a test can model the
   * range selector reshaping the series. */
  monthlyComparison?:
    | MonthlyComparison
    | null
    | ((args: Record<string, unknown>) => MonthlyComparison | null | undefined);
  /** `getCategoryAnalytics` result (RPT-5); `undefined` ≡ loading, `null` ≡ inaccessible
   * Circle. Defaults to an empty ranked list so the section renders. */
  categoryAnalytics?:
    | CategoryAnalytics
    | null
    | ((args: Record<string, unknown>) => CategoryAnalytics | null | undefined);
}

export function dashboardDouble(state: DashboardState): EntityDouble {
  const {
    dashboard = EMPTY_DASHBOARD,
    monthlyComparison = emptyMonthlyComparison,
    categoryAnalytics = EMPTY_CATEGORY_ANALYTICS,
  } = state;
  return {
    queries: {
      [getFunctionName(api.dashboard.getDashboard)]: (args) => resolveWith(dashboard, args),
      [getFunctionName(api.dashboard.getMonthlyComparison)]: (args) =>
        resolveWith(monthlyComparison, args),
      [getFunctionName(api.dashboard.getCategoryAnalytics)]: (args) =>
        resolveWith(categoryAnalytics, args),
    },
  };
}
