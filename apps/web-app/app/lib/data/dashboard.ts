import { api } from "@pocketcircle/convex";
import type { ComparisonRangeMonths, PlainMonth, TransactionType } from "@pocketcircle/domain";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { MOCKS } from "../env.js";
import { MOCK_CATEGORY_ANALYTICS, MOCK_DASHBOARD, mockMonthlyComparison } from "../fixtures.js";
import { useStableQuery } from "../use-stable-query.js";
import type { Circle } from "./circles.js";

/**
 * The per-Circle Dashboard view contract, derived from `getDashboard` so it can't
 * drift from the backend (ADR 0003): the selected month's Income / Expense / Net in
 * minor units, the recent Transactions feed, the Circle Currency, and the resolved
 * month. `null` ≡ inaccessible Circle (ADR 0016); `undefined` while loading.
 */
export type Dashboard = NonNullable<FunctionReturnType<typeof api.dashboard.getDashboard>>;
export type DashboardTotals = Dashboard["totals"];

/**
 * The per-Circle Dashboard (RPT-3): current-month (or an explicit `month`) Income /
 * Expense / Net totals plus a recent-Transactions feed for all active Transactions
 * in the Circle. `undefined` while loading; `null` for an inaccessible Circle (the
 * guard ejects before this renders). Mock mode returns fixtures and skips the
 * backend (ADR 0006).
 */
export function useDashboard(circleId: Circle["id"], options?: { month?: PlainMonth }) {
  const queried = useQuery(
    api.dashboard.getDashboard,
    MOCKS
      ? "skip"
      : {
          circleId,
          ...(options?.month ? { month: options.month } : {}),
        },
  );
  return MOCKS ? MOCK_DASHBOARD : queried;
}

/**
 * The Dashboard's month-over-month comparison view contract, derived from
 * `getMonthlyComparison` so it can't drift from the backend (ADR 0003): a
 * chronological, zero-filled per-month series of Income / Expense / Net in minor
 * units plus the Circle Currency. `null` ≡ inaccessible Circle (ADR 0016);
 * `undefined` while loading.
 */
export type MonthlyComparison = NonNullable<
  FunctionReturnType<typeof api.dashboard.getMonthlyComparison>
>;
export type MonthlyComparisonEntry = MonthlyComparison["series"][number];

/**
 * The Dashboard's month-over-month comparison (RPT-4): `rangeMonths` months (a
 * Comparison Range — 1/3/6/12) ending at `endMonth` for all active Circle
 * Transactions. `undefined` while loading; `null` for an inaccessible Circle (the
 * guard ejects before this renders). Mock mode derives a deterministic fixture
 * series for the requested window and skips the backend (ADR 0006).
 */
export function useMonthlyComparison(
  circleId: Circle["id"],
  options: {
    endMonth: PlainMonth;
    rangeMonths: ComparisonRangeMonths;
  },
) {
  // Stable across Comparison Range changes so CashFlowTrend stays mounted and
  // can run the fast Recharts transition (ADR 0032). Reset on Circle change.
  const retained = useStableQuery(
    api.dashboard.getMonthlyComparison,
    MOCKS
      ? "skip"
      : {
          circleId,
          endMonth: options.endMonth,
          rangeMonths: options.rangeMonths,
        },
    { resetKey: circleId },
  );
  if (MOCKS) {
    return {
      comparison: mockMonthlyComparison(options.endMonth, options.rangeMonths),
      isPending: false,
    };
  }
  return { comparison: retained.value, isPending: retained.isPending };
}

/**
 * The Dashboard's category analytics view contract, derived from
 * `getCategoryAnalytics` so it can't drift from the backend (ADR 0003): ranked
 * tagged spend per Category in minor units plus the Circle Currency. `null` ≡
 * inaccessible Circle (ADR 0016); `undefined` while loading.
 */
export type CategoryAnalytics = NonNullable<
  FunctionReturnType<typeof api.dashboard.getCategoryAnalytics>
>;
export type CategoryAnalyticsRow = CategoryAnalytics["rows"][number];

/**
 * Ranked, non-additive category tagged spend for one month (RPT-5), optionally
 * narrowed by transaction `type`. `undefined` while loading; `null` for an
 * inaccessible Circle. Mock mode returns fixtures and skips the backend (ADR 0006).
 */
export function useCategoryAnalytics(
  circleId: Circle["id"],
  options?: {
    month?: PlainMonth;
    type?: TransactionType;
  },
) {
  const queried = useQuery(
    api.dashboard.getCategoryAnalytics,
    MOCKS
      ? "skip"
      : {
          circleId,
          ...(options?.month ? { month: options.month } : {}),
          ...(options?.type ? { type: options.type } : {}),
        },
  );
  return MOCKS ? MOCK_CATEGORY_ANALYTICS : queried;
}
