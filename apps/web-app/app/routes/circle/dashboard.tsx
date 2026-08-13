import {
  COMPARISON_RANGE_OPTIONS,
  type ComparisonRangeMonths,
  currentMonth,
  formatMoney,
  isComparisonRangeMonths,
  money,
  type PlainMonth,
  toCurrencyCode,
} from "@pocketcircle/domain";
import { useEffect } from "react";
import { Link, useSearchParams } from "react-router";
import { ActivationChecklist } from "~/components/activation-checklist.js";
import { LoadingStatus, RowsSkeleton, Skeleton } from "~/components/skeleton.js";
import {
  canonicalDashboardParams,
  type DashboardSelection,
  readDashboardSelection,
} from "~/lib/dashboard-url.js";
import {
  type CategoryAnalytics,
  type Circle,
  type Dashboard,
  type DashboardTotals,
  type MonthlyComparison,
  type Transaction,
  useCategoryAnalytics,
  useDashboard,
  useMonthlyComparison,
} from "~/lib/data.js";
import { transactionDetailHref } from "~/lib/ledger-url.js";
import { viewerLocale } from "~/lib/locale.js";
import { useReturnToOrigin, withReturnTo } from "~/lib/return-to-url.js";
import { cn } from "~/lib/utils.js";
import { useCircle } from "~/routes/layouts/circle-layout.js";
import { DashboardCategoryAnalytics } from "./dashboard-category-analytics.js";
import { DashboardComparisonChart } from "./dashboard-comparison-chart.js";

/**
 * The per-Circle Dashboard (RPT-3; PRD stories 68, 75) — the Circle index route.
 * Shows the CURRENT month's Income / Expense / Net totals and a recent-Transactions
 * feed for all active Transactions in the Circle (archived excluded — TXN-3).
 *
 * The month is the User's LOCAL current month (`currentMonth(new Date())`) so the
 * Dashboard reads as "this month" for them; month navigation and month-over-month
 * comparison are RPT-4, category breakdown RPT-5, and drilldowns RPT-6 — this slice
 * is the totals + recent surface they build on.
 *
 * Totals and recent come from `getDashboard` (a bounded server-side aggregate over the
 * month — never summed on the client, ADR 0009).
 *
 * The Comparison Range and category analytics type live in the URL (`dashboard-url.ts` —
 * the Ledger's URL-as-state policy), so a narrowed Dashboard survives reload and can
 * be shared; selection changes push history entries so Back walks them. Legacy `paidBy`
 * deep links are stripped on load — the Dashboard is Circle-wide; Member-specific
 * investigation lives on the Monthly Ledger and Transaction Search.
 */
export default function CircleDashboard() {
  const circle = useCircle();
  const month = currentMonth(new Date());
  const [searchParams, setSearchParams] = useSearchParams();
  const selection = readDashboardSelection(searchParams);

  // Strip legacy ?paidBy= from deep links without disturbing range, type, or foreign params.
  // react-doctor-disable-next-line react-doctor/no-event-handler -- legacy URL cleanup on mount/param change, not a discrete UI event.
  useEffect(() => {
    if (searchParams.has("paidBy")) {
      setSearchParams(canonicalDashboardParams(selection, searchParams), { replace: true });
    }
  }, [selection, searchParams, setSearchParams]);

  const dashboard = useDashboard(circle.id, { month });
  const comparison = useMonthlyComparison(circle.id, {
    endMonth: month,
    rangeMonths: selection.range,
  });
  const categoryAnalytics = useCategoryAnalytics(circle.id, {
    month,
    type: selection.type,
  });

  const select = (next: DashboardSelection) => {
    setSearchParams(canonicalDashboardParams(next, searchParams), { replace: false });
  };

  return (
    <div className="space-y-6">
      {/* One polite announcement for the whole surface — the totals, comparison, and
          recent widgets carry only presentational placeholders, so a screen reader
          hears "Loading…" once rather than once per widget (issue #121). */}
      <LoadingStatus
        loading={
          dashboard === undefined || comparison === undefined || categoryAnalytics === undefined
        }
        label="Loading dashboard…"
      />
      <h2 className="font-display text-lg font-semibold tracking-tight">Dashboard</h2>
      {circle.kind === "personal" ? <ActivationChecklist circle={circle} /> : null}

      <DashboardTotalsCards dashboard={dashboard} fallbackCurrency={circle.currency} />
      <MonthlyComparisonSection
        comparison={comparison}
        rangeMonths={selection.range}
        onRangeChange={(range) => select({ ...selection, range })}
      />
      <CategoryAnalyticsSection
        analytics={categoryAnalytics}
        type={selection.type}
        onTypeChange={(type) => select({ ...selection, type })}
        circleRef={circle.ref}
        month={month}
      />
      <RecentTransactions dashboard={dashboard} circle={circle} />
    </div>
  );
}

/**
 * The current month's Income / Expense / Net cards. Totals are minor units summed
 * server-side and formatted ONCE here in the Circle Currency (ADR 0009) — never summed
 * from formatted strings. `dashboard` is `undefined` while loading (placeholders shown)
 * and `null` only for an inaccessible Circle (the guard ejects before this renders);
 * the currency falls back to the Circle's until the Dashboard resolves.
 */
function DashboardTotalsCards({
  dashboard,
  fallbackCurrency,
}: {
  dashboard: Dashboard | null | undefined;
  fallbackCurrency: string;
}) {
  const currency = toCurrencyCode(dashboard?.currency ?? fallbackCurrency);
  const totals: DashboardTotals | undefined = dashboard?.totals;
  const stats: { label: string; amount: number | undefined; tone: string }[] = [
    { label: "Income", amount: totals?.incomeMinor, tone: "text-positive" },
    { label: "Expenses", amount: totals?.expenseMinor, tone: "text-foreground" },
    {
      label: "Net",
      amount: totals?.netMinor,
      tone: (totals?.netMinor ?? 0) >= 0 ? "text-positive" : "text-destructive",
    },
  ];

  return (
    <fieldset aria-busy={totals === undefined}>
      <legend className="sr-only">This month's totals</legend>
      <dl className="grid grid-cols-3 gap-3">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <dt className="text-xs text-muted-foreground">{stat.label}</dt>
            <dd
              className={cn(
                "mt-1 font-display text-lg font-semibold tabular-nums sm:text-2xl",
                stat.tone,
              )}
            >
              {stat.amount === undefined ? (
                <Skeleton className="mt-1 h-6 w-20" />
              ) : (
                formatMoney(money(stat.amount, currency), viewerLocale())
              )}
            </dd>
          </div>
        ))}
      </dl>
    </fieldset>
  );
}

/**
 * The month-over-month comparison (RPT-4; PRD stories 70, 71, 72): grouped Income /
 * Expense bars with a Net line overlay (Recharts — ADR 0005) over the selected
 * Comparison Range (1/3/6/12 months, default 6 — CONTEXT glossary), ending at the
 * current month. The series arrives chronological, zero-filled, and in minor units;
 * this surface only formats (ADR 0009) — axes/tooltips in the viewer locale and the
 * Circle Currency.
 *
 * The chart SVG is presentational (`aria-hidden`): its colors are a visual cue only
 * (CONTEXT: never identify by color alone — the legend and tooltip carry the names),
 * and the SAME series renders as a visually-hidden table — the accessible (and
 * jsdom-testable) reading of the chart, with month labels and formatted money.
 */
function MonthlyComparisonSection({
  comparison,
  rangeMonths,
  onRangeChange,
}: {
  comparison: MonthlyComparison | null | undefined;
  rangeMonths: ComparisonRangeMonths;
  onRangeChange: (rangeMonths: ComparisonRangeMonths) => void;
}) {
  return (
    <section className="space-y-3" aria-labelledby="dashboard-comparison-heading">
      <div className="flex items-center justify-between gap-3">
        <h3 id="dashboard-comparison-heading" className="text-sm font-semibold text-foreground">
          Month-over-month
        </h3>
        <div className="flex items-center gap-2">
          <label htmlFor="dashboard-comparison-range" className="text-xs text-muted-foreground">
            Range
          </label>
          <select
            id="dashboard-comparison-range"
            value={rangeMonths}
            onChange={(event) => {
              // The DOM emits a string; narrow it back to a supported Comparison
              // Range (the only values the options offer).
              const next = Number(event.target.value);
              if (isComparisonRangeMonths(next)) {
                onRangeChange(next);
              }
            }}
            className="rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm outline-none transition-[border-color,box-shadow] duration-150 focus:border-ring focus:ring-2 focus:ring-ring/30"
          >
            {COMPARISON_RANGE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option === 1 ? "1 month" : `${option} months`}
              </option>
            ))}
          </select>
        </div>
      </div>

      {comparison === undefined ? (
        // Presentational placeholder — the page-level LoadingStatus does the announcing.
        <div aria-hidden data-testid="comparison-skeleton">
          <Skeleton className="h-72 w-full rounded-xl" />
        </div>
      ) : !comparison ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No comparison available.
        </p>
      ) : (
        <DashboardComparisonChart comparison={comparison} />
      )}
    </section>
  );
}

/**
 * Ranked category tagged spend (RPT-5). Uses the Dashboard's current month scope; the
 * expense/income toggle is URL-owned via `dashboard-url.ts`.
 */
function CategoryAnalyticsSection({
  analytics,
  type,
  onTypeChange,
  circleRef,
  month,
}: {
  analytics: CategoryAnalytics | null | undefined;
  type: DashboardSelection["type"];
  onTypeChange: (type: DashboardSelection["type"]) => void;
  circleRef: string;
  month: PlainMonth;
}) {
  return (
    <section className="space-y-3" aria-labelledby="dashboard-category-scope-heading">
      <div className="flex items-center justify-between gap-3">
        <h3 id="dashboard-category-scope-heading" className="sr-only">
          Category analytics scope
        </h3>
        <div className="flex items-center gap-2">
          <label htmlFor="dashboard-category-type" className="text-xs text-muted-foreground">
            Type
          </label>
          <select
            id="dashboard-category-type"
            value={type}
            onChange={(event) => {
              const next = event.target.value;
              if (next === "expense" || next === "income") {
                onTypeChange(next);
              }
            }}
            className="rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm outline-none transition-[border-color,box-shadow] duration-150 focus:border-ring focus:ring-2 focus:ring-ring/30"
          >
            <option value="expense">Expenses</option>
            <option value="income">Income</option>
          </select>
        </div>
      </div>

      {analytics === undefined ? (
        <div aria-hidden data-testid="category-analytics-skeleton">
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      ) : !analytics ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No category analytics available.
        </p>
      ) : (
        <DashboardCategoryAnalytics
          analytics={analytics}
          circleRef={circleRef}
          month={month}
          type={type}
        />
      )}
    </section>
  );
}

/**
 * The recent-Transactions feed (PRD 75): the latest active Transactions by record
 * time, money formatted in the Circle Currency. Each row's title links to the TXN-4
 * detail route, carrying the Dashboard's current URL as a validated `returnTo` origin
 * (issue #123) so close/back returns here — matching the Ledger row links. `dashboard`
 * is `undefined` while loading; an empty feed reads as "no recent activity".
 */
function RecentTransactions({
  dashboard,
  circle,
}: {
  dashboard: Dashboard | null | undefined;
  circle: Circle;
}) {
  const currency = toCurrencyCode(circle.currency);
  const origin = useReturnToOrigin();

  return (
    <section className="space-y-3" aria-labelledby="dashboard-recent-heading">
      <h3 id="dashboard-recent-heading" className="text-sm font-semibold text-foreground">
        Recent activity
      </h3>
      {dashboard === undefined ? (
        // Presentational placeholder — the page-level LoadingStatus does the announcing.
        <div aria-hidden data-testid="recent-skeleton">
          <RowsSkeleton rows={4} />
        </div>
      ) : !dashboard || dashboard.recent.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No recent activity.
        </p>
      ) : (
        <ul className="space-y-2">
          {dashboard.recent.map((txn) => (
            <RecentRow key={txn.id} circle={circle} txn={txn} currency={currency} origin={origin} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RecentRow({
  circle,
  txn,
  currency,
  origin,
}: {
  circle: Circle;
  txn: Transaction;
  currency: ReturnType<typeof toCurrencyCode>;
  origin: string;
}) {
  return (
    <li className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 shadow-sm">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">
          <Link
            to={withReturnTo(transactionDetailHref(circle, txn), origin)}
            className="hover:underline"
            aria-label={`View ${txn.title}`}
          >
            {txn.title}
          </Link>
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {txn.date} · {txn.categories.map((category) => category.name).join(", ")} ·{" "}
          {txn.paidBy.displayName}
        </p>
      </div>
      <span
        className={cn(
          "ml-auto text-sm font-semibold tabular-nums",
          txn.type === "income" ? "text-positive" : "text-foreground",
        )}
      >
        {txn.type === "income" ? "+" : "-"}
        {formatMoney(money(txn.amountMinorUnits, currency), viewerLocale())}
      </span>
    </li>
  );
}
