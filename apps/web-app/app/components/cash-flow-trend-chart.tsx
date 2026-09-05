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
import { SCOPE_CHART_ANIMATION_MS } from "~/lib/motion.js";
import { CASH_FLOW_CHART_SHELL_CLASSNAME } from "./cash-flow-trend-shell.js";

export interface CashFlowSeriesEntry {
  month: string;
  incomeMinor: number;
  expenseMinor: number;
  netMinor: number;
}

/** Recharts visual for CashFlowTrend — separate chunk so Home/Dashboard entry stays light (RPT-8). */
export function CashFlowTrendChart({
  currency,
  series,
  chartAnimationActive,
}: {
  currency: string;
  series: CashFlowSeriesEntry[];
  chartAnimationActive: boolean;
}) {
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

  return (
    <div
      aria-hidden="true"
      data-chart-animation-active={String(chartAnimationActive)}
      className={CASH_FLOW_CHART_SHELL_CLASSNAME}
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
  );
}
