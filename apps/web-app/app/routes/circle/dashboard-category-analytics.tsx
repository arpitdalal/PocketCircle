import {
  colorHex,
  formatMoney,
  money,
  type PlainMonth,
  type TransactionType,
  toCurrencyCode,
} from "@pocketcircle/domain";
import { Link } from "react-router";
import type { CategoryAnalytics, CategoryAnalyticsRow } from "~/lib/data.js";
import { ledgerDrilldownHref } from "~/lib/ledger-url.js";
import { viewerLocale } from "~/lib/locale.js";
import { cn } from "~/lib/utils.js";

/**
 * Ranked, non-additive category tagged spend (RPT-5; PRD stories 58, 73). Each row
 * shows one Category's tagged total for the month; a multi-Category Transaction
 * contributes its full amount to every Category it carries, so these totals must
 * NOT be read as an additive breakdown. Money is formatted once in the Circle
 * Currency (ADR 0009); Categories are identified by name (and an Archived badge),
 * not color alone (CONTEXT a11y).
 */
export function DashboardCategoryAnalytics({
  analytics,
  circleRef,
  month,
  type,
}: {
  analytics: CategoryAnalytics;
  circleRef: string;
  month: PlainMonth;
  type: TransactionType;
}) {
  const currency = toCurrencyCode(analytics.currency);
  const locale = viewerLocale();
  const formatMinor = (minorUnits: number) => formatMoney(money(minorUnits, currency), locale);
  const maxTagged = analytics.rows[0]?.taggedTotalMinor ?? 0;

  return (
    <section className="space-y-3" aria-labelledby="dashboard-category-analytics-heading">
      <div className="space-y-1">
        <h3
          id="dashboard-category-analytics-heading"
          className="text-sm font-semibold text-foreground"
        >
          Tagged spend by category
        </h3>
        <p className="text-xs text-muted-foreground">
          A transaction tagged with multiple categories counts its full amount toward each category.
          Totals are not additive.
        </p>
      </div>

      {analytics.rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No tagged spend for this period.
        </p>
      ) : (
        <ol className="space-y-3" aria-label="Ranked category tagged spend">
          {analytics.rows.map((row) => (
            <CategoryAnalyticsRowItem
              key={row.categoryId}
              row={row}
              maxTagged={maxTagged}
              formatMinor={formatMinor}
              drilldownHref={ledgerDrilldownHref(
                { ref: circleRef },
                { month, categoryId: row.categoryId, type },
              )}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function CategoryAnalyticsRowItem({
  row,
  maxTagged,
  formatMinor,
  drilldownHref,
}: {
  row: CategoryAnalyticsRow;
  maxTagged: number;
  formatMinor: (minorUnits: number) => string;
  drilldownHref: string;
}) {
  const barWidth = maxTagged > 0 ? Math.round((row.taggedTotalMinor / maxTagged) * 100) : 0;
  const isArchived = row.status === "archived";

  return (
    <li className="space-y-1.5 rounded-lg border border-border bg-card px-3 py-2.5 shadow-sm">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "min-w-0 truncate text-sm font-medium",
            isArchived && "text-muted-foreground",
          )}
        >
          <Link
            to={drilldownHref}
            className="hover:underline"
            aria-label={`View ${row.name} transactions`}
          >
            {row.name}
          </Link>
        </span>
        {isArchived ? (
          <span className="shrink-0 rounded-full border border-border bg-muted px-2 py-px text-xs text-muted-foreground">
            Archived
          </span>
        ) : null}
        <span className="ml-auto shrink-0 text-sm font-semibold tabular-nums">
          {formatMinor(row.taggedTotalMinor)}
        </span>
      </div>
      <div
        aria-hidden="true"
        className="h-2 overflow-hidden rounded-full bg-muted"
        title={`${row.txnCount} transaction${row.txnCount === 1 ? "" : "s"}`}
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${barWidth}%`, backgroundColor: colorHex(row.color) }}
        />
      </div>
      <p className="sr-only">
        {row.name}
        {isArchived ? " (archived)" : ""}: {formatMinor(row.taggedTotalMinor)} across {row.txnCount}{" "}
        transaction{row.txnCount === 1 ? "" : "s"}
      </p>
    </li>
  );
}
