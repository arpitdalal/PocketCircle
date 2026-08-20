import { formatMoney, getCurrency, money, toCurrencyCode } from "@pocketcircle/domain";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatMonthLabel, formatMonthTick } from "~/lib/datetime.js";
import { viewerLocale } from "~/lib/locale.js";
import { SCOPE_CHART_ANIMATION_MS, usePrefersReducedMotion } from "~/lib/motion.js";

export interface CashFlowSeriesEntry {
  month: string;
  incomeMinor: number;
  expenseMinor: number;
  netMinor: number;
}

/**
 * Reusable accessible Cash Flow Trend chart (GH-273 req 4). Accepts a currency,
 * chronological series, and optional caption. Renders an aria-hidden visual
 * `ComposedChart` (bars for Income/Expense, line for Net) plus a real sr-only
 * data table for screen readers. Fast scope-change animation (~200ms, ADR 0032);
 * disabled when the user prefers reduced motion.
 */
export function CashFlowTrend({
  currency,
  series,
  caption,
}: {
  currency: string;
  series: CashFlowSeriesEntry[];
  caption?: string;
}) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const chartAnimationActive = !prefersReducedMotion;
  const currencyCode = toCurrencyCode(currency);
  const locale = viewerLocale();
  const formatMinor = (minorUnits: number) => formatMoney(money(minorUnits, currencyCode), locale);
  const compactTick = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currencyCode,
    notation: "compact",
  });
  const formatTick = (minorUnits: number) =>
    compactTick.format(minorUnits / 10 ** getCurrency(currencyCode).decimals);

  const tableCaption = caption ?? "Month-over-month Income, Expense, and Net";

  return (
    <>
      <div
        aria-hidden="true"
        data-chart-animation-active={String(chartAnimationActive)}
        className="h-72 rounded-xl border border-border bg-card p-3 shadow-sm"
      >
        <ResponsiveContainer
          width="100%"
          height="100%"
          initialDimension={{ width: 600, height: 260 }}
        >
          <ComposedChart data={series} barGap={2}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis
              dataKey="month"
              tickFormatter={formatMonthTick}
              tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
              tickLine={false}
              axisLine={{ stroke: "var(--border)" }}
            />
            <YAxis
              tickFormatter={formatTick}
              tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
              tickLine={false}
              axisLine={false}
              width={64}
            />
            <Tooltip
              formatter={(value: unknown, name: unknown) => [
                typeof value === "number" ? formatMinor(value) : "",
                typeof name === "string" ? name : "",
              ]}
              labelFormatter={(label: unknown) =>
                typeof label === "string" ? formatMonthLabel(label) : ""
              }
              cursor={{ fill: "var(--muted)" }}
              contentStyle={{
                backgroundColor: "var(--card)",
                border: "1px solid var(--border)",
                borderRadius: "0.5rem",
                color: "var(--foreground)",
              }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar
              dataKey="incomeMinor"
              name="Income"
              fill="var(--positive)"
              radius={[3, 3, 0, 0]}
              isAnimationActive={chartAnimationActive}
              animationDuration={SCOPE_CHART_ANIMATION_MS}
              animationEasing="ease-out"
            />
            <Bar
              dataKey="expenseMinor"
              name="Expense"
              fill="var(--destructive)"
              radius={[3, 3, 0, 0]}
              isAnimationActive={chartAnimationActive}
              animationDuration={SCOPE_CHART_ANIMATION_MS}
              animationEasing="ease-out"
            />
            <Line
              type="monotone"
              dataKey="netMinor"
              name="Net"
              stroke="var(--primary)"
              strokeWidth={2}
              dot={{ r: 3, fill: "var(--primary)" }}
              isAnimationActive={chartAnimationActive}
              animationDuration={SCOPE_CHART_ANIMATION_MS}
              animationEasing="ease-out"
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

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
