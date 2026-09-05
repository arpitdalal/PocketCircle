import { formatMoney, money, toCurrencyCode } from "@pocketcircle/domain";
import { lazy, Suspense } from "react";
import { formatMonthLabel } from "~/lib/datetime.js";
import { viewerLocale } from "~/lib/locale.js";
import {
  cashFlowSeriesMotionKey,
  usePrefersReducedMotion,
  useScopeChangeMotion,
} from "~/lib/motion.js";
import type { CashFlowSeriesEntry } from "./cash-flow-trend-chart.js";
import { CASH_FLOW_CHART_SHELL_CLASSNAME } from "./cash-flow-trend-shell.js";

export type { CashFlowSeriesEntry };

const CashFlowTrendChart = lazy(async () => {
  const mod = await import("./cash-flow-trend-chart.js");
  return { default: mod.CashFlowTrendChart };
});

function ChartShellFallback() {
  return (
    <div
      aria-hidden="true"
      data-chart-shell="fallback"
      data-chart-animation-active="false"
      className={CASH_FLOW_CHART_SHELL_CLASSNAME}
    />
  );
}

/**
 * Reusable accessible Cash Flow Trend chart (GH-273 req 4). Accepts a currency,
 * chronological series, and optional caption. Renders an aria-hidden visual
 * `ComposedChart` (bars for Income/Expense, line for Net) plus a real sr-only
 * data table for screen readers. Fast scope-change animation (~200ms, ADR 0032);
 * disabled when the user prefers reduced motion. `scopeKey` must change only when
 * reporting controls change — not on live series refreshes.
 *
 * Recharts loads in a separate chunk after first paint (RPT-8); the sr-only table
 * renders immediately so accessibility does not wait on the chart bundle.
 */
export function CashFlowTrend({
  currency,
  series,
  scopeKey,
  caption,
  pending = false,
}: {
  currency: string;
  series: CashFlowSeriesEntry[];
  /** Reporting-scope identity (Home currency/range/inclusion, Dashboard range). */
  scopeKey: string;
  caption?: string;
  /** True while retained series bridges a scope reload (ADR 0032). */
  pending?: boolean;
}) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const scopeMotion = useScopeChangeMotion(
    scopeKey,
    cashFlowSeriesMotionKey(series),
    "scope",
    pending,
  );
  const chartAnimationActive = scopeMotion && !prefersReducedMotion;
  const currencyCode = toCurrencyCode(currency);
  const locale = viewerLocale();
  const formatMinor = (minorUnits: number) => formatMoney(money(minorUnits, currencyCode), locale);

  const tableCaption = caption ?? "Month-over-month Income, Expense, and Net";

  return (
    <>
      <Suspense fallback={<ChartShellFallback />}>
        <CashFlowTrendChart
          currency={currency}
          series={series}
          chartAnimationActive={chartAnimationActive}
        />
      </Suspense>

      <table className="sr-only">
        <caption>{tableCaption}</caption>
        <thead>
          <tr>
            <th scope="col">Month</th>
            <th scope="col">Income</th>
            <th scope="col">Expense</th>
            <th scope="col">Net</th>
          </tr>
        </thead>
        <tbody>
          {series.map((entry) => (
            <tr key={entry.month}>
              <th scope="row">{formatMonthLabel(entry.month)}</th>
              <td>{formatMinor(entry.incomeMinor)}</td>
              <td>{formatMinor(entry.expenseMinor)}</td>
              <td>{formatMinor(entry.netMinor)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
