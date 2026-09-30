import { formatMoney, money, type PlainMonth, toCurrencyCode } from "@pocketcircle/domain";
import { lazy, Suspense } from "react";
import { Skeleton } from "~/components/skeleton.js";
import type { CategoryRankingRow } from "~/lib/data.js";
import { viewerLocale } from "~/lib/locale.js";
import {
  categoryRankingMotionKey,
  usePrefersReducedMotion,
  useScopeChangeMotion,
} from "~/lib/motion.js";
import { CHART_SHELL_CLASSNAME } from "./chart-shell.js";

const LedgerCategoryRankingChart = lazy(async () => {
  const mod = await import("./ledger-category-ranking-chart.js");
  return { default: mod.LedgerCategoryRankingChart };
});

function ChartShellFallback() {
  return (
    <div
      aria-hidden="true"
      data-chart-shell="fallback"
      data-chart-animation-active="false"
      className={CHART_SHELL_CLASSNAME}
    />
  );
}

/**
 * The Monthly Ledger's Category Ranking (RPT-8; PRD story 95) — vertical bars diverging
 * from a zero baseline (income above, expense below), read-only and keyboard-inert.
 *
 * The ranking is LIST-DERIVED: it takes its scope from the Ledger Filter, so it describes
 * exactly the Transactions listed beneath it and deliberately disagrees with the
 * filter-blind Month Scope Totals cards above it (ADR 0036). Two captions make that
 * explicit rather than leaving the user to reconcile the two numbers: the non-additivity
 * of category totals, and the lifecycle scope in view.
 *
 * Like every chart in the app (ADR 0032), the visual is `aria-hidden` and the SAME rows
 * render as an sr-only table — the accessible, and jsdom-testable, reading. Recharts loads
 * in a separate chunk after first paint so that reading never waits on the chart bundle.
 */
export function LedgerCategoryRanking({
  month,
  ranking,
  currency,
  scope,
  scopeKey,
  pending = false,
}: {
  month: PlainMonth;
  ranking: CategoryRankingRow[];
  currency: string;
  /** The lifecycle scope in view, spelled out where the numbers are read. */
  scope: string;
  /** Reporting-scope identity; must change when the Ledger Filter narrows or the month moves. */
  scopeKey: string;
  /** True while a retained ranking bridges a scope reload (ADR 0032). */
  pending?: boolean;
}) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const scopeMotion = useScopeChangeMotion(
    scopeKey,
    categoryRankingMotionKey(ranking),
    "scope",
    pending,
  );
  const chartAnimationActive = scopeMotion && !prefersReducedMotion;
  const currencyCode = toCurrencyCode(currency);
  const locale = viewerLocale();
  const formatMinor = (minorUnits: number) => formatMoney(money(minorUnits, currencyCode), locale);

  return (
    <section
      className="space-y-3"
      aria-labelledby="ledger-category-ranking-heading"
      aria-busy={pending}
    >
      <div className="space-y-1">
        <h3 id="ledger-category-ranking-heading" className="text-sm font-semibold text-foreground">
          Tagged spend by category
        </h3>
        <p className="text-xs text-muted-foreground">
          {`A transaction tagged with multiple categories counts its full amount toward each category, so these totals are not additive. Showing ${scope} transactions.`}
        </p>
      </div>

      {ranking.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No tagged spend for this period.
        </p>
      ) : (
        <>
          <Suspense fallback={<ChartShellFallback />}>
            <LedgerCategoryRankingChart
              currency={currency}
              ranking={ranking}
              chartAnimationActive={chartAnimationActive}
            />
          </Suspense>

          {/* Wrap — WebKit ignores `sr-only` sizing on <table> itself and expands
              document scrollWidth (~58px at 390), breaking fixed bottom chrome. */}
          <div className="sr-only">
            <table>
              <caption>{`Tagged spend by category for ${month}`}</caption>
              <thead>
                <tr>
                  <th scope="col">Category</th>
                  <th scope="col">Type</th>
                  <th scope="col">Tagged total</th>
                  <th scope="col">Transactions</th>
                </tr>
              </thead>
              <tbody>
                {ranking.map((row) => (
                  <tr key={`${row.type}:${row.categoryId}`}>
                    <th scope="row">
                      {row.name}
                      {row.status === "archived" ? " (archived)" : ""}
                    </th>
                    <td>{row.type === "income" ? "Income" : "Expense"}</td>
                    <td>{formatMinor(row.taggedTotalMinor)}</td>
                    <td>{row.txnCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
