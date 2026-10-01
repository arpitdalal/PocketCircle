import { formatMoney, money, toCurrencyCode } from "@pocketcircle/domain";
import { lazy, Suspense } from "react";
import { Skeleton, SkeletonRegion } from "~/components/skeleton.js";
import type { CategoryRankingRow } from "~/lib/data.js";
import { viewerLocale } from "~/lib/locale.js";
import {
  categoryRankingMotionKey,
  usePrefersReducedMotion,
  useScopeChangeMotion,
} from "~/lib/motion.js";
import { ChartShellFallback } from "./chart-shell.js";

const LedgerCategoryRankingChart = lazy(async () => {
  const mod = await import("./ledger-category-ranking-chart.js");
  return { default: mod.LedgerCategoryRankingChart };
});

/**
 * The Monthly Ledger's Category Ranking (RPT-8; PRD story 95) — vertical bars diverging
 * from a zero baseline (income above, expense below), read-only and keyboard-inert.
 *
 * The ranking is LIST-DERIVED: it follows the Ledger Filter's month, type, lifecycle
 * scope, and Category selection (ADR 0036), so it deliberately disagrees with the
 * filter-blind Month Scope Totals cards above it. Its caption names that scope — and the
 * filter dimensions it does NOT follow — so the user never has to reconcile the two
 * numbers, or the ranking against a narrower list, by guesswork.
 *
 * Like every chart in the app (ADR 0032), the visual is `aria-hidden` and the SAME rows
 * render as an sr-only table — the accessible reading. Recharts loads in a separate chunk
 * after first paint so that reading never waits on the chart bundle.
 *
 * `ranking: undefined` is the first load of a scope: the section keeps its heading and
 * caption (so nothing below shifts) and only the chart area is a placeholder.
 */
export function LedgerCategoryRanking({
  ranking,
  currency,
  scope,
  scopeKey,
  pending = false,
}: {
  ranking: CategoryRankingRow[] | undefined;
  currency: string;
  /** The lifecycle scope in view, spelled out where the numbers are read. */
  scope: string;
  /** Reporting-scope identity; must change when the Ledger Filter narrows or the month moves. */
  scopeKey: string;
  /** True while a retained (previous-scope) ranking bridges a reload (ADR 0032). */
  pending?: boolean;
}) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const rows = ranking ?? [];
  const scopeMotion = useScopeChangeMotion(
    scopeKey,
    categoryRankingMotionKey(rows),
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
      aria-busy={pending || ranking === undefined}
    >
      <div className="space-y-1">
        <h3 id="ledger-category-ranking-heading" className="text-sm font-semibold text-foreground">
          Tagged spend by category
        </h3>
        <p className="text-xs text-muted-foreground">
          A transaction tagged with multiple categories counts its full amount toward each category,
          so these totals are not additive.
          {/* While a retained ranking is on screen it belongs to the PREVIOUS scope, so the
              scope clause waits for the current one rather than mislabelling stale rows. */}
          {pending
            ? null
            : ` Showing ${scope} transactions, not narrowed by search text or Member.`}
        </p>
      </div>

      {ranking === undefined ? (
        <SkeletonRegion label="Loading tagged spend…" testId="category-ranking-skeleton">
          <Skeleton className="h-72 w-full rounded-xl" />
        </SkeletonRegion>
      ) : ranking.length === 0 ? (
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
              <caption>Tagged spend by category</caption>
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
                      {row.status === "archived" ? " (Archived)" : ""}
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
