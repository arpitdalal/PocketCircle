import { colorHex, formatMoney, getCurrency, money, toCurrencyCode } from "@pocketcircle/domain";
import {
  Bar,
  BarChart,
  type BarShapeProps,
  CartesianGrid,
  Rectangle,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  type TooltipContentProps,
  XAxis,
  YAxis,
} from "recharts";
import type { CategoryRankingRow } from "~/lib/data.js";
import { viewerLocale } from "~/lib/locale.js";
import { SCOPE_CHART_ANIMATION_MS } from "~/lib/motion.js";
import { CHART_SHELL_CLASSNAME } from "./chart-shell.js";

/**
 * One bar: a Category's name, its magnitude SIGNED for the diverging baseline (income
 * above zero, expense below), and the fill it draws with.
 */
export interface RankingBarDatum {
  name: string;
  signedMinor: number;
  fill: string;
  archived: boolean;
}

/**
 * Hatched fill id for Archived Categories. An Archived Category's spending stays visible
 * (PRD 58) and stays distinguishable (CONTEXT: never identify by colour alone), so its bar
 * is hatched rather than dropped or silently recoloured.
 */
export const ARCHIVED_HATCH_ID = "ledger-category-ranking-archived-hatch";

/**
 * Projects ranking rows onto diverging bars. The sign is presentation only — the row's
 * `taggedTotalMinor` stays a positive magnitude — and an Archived Category draws in the
 * shared hatch instead of its Category colour.
 */
export function toCategoryRankingBars(ranking: CategoryRankingRow[]) {
  return ranking.map((row) => ({
    name: row.name,
    signedMinor: row.type === "income" ? row.taggedTotalMinor : -row.taggedTotalMinor,
    fill: row.status === "archived" ? `url(#${ARCHIVED_HATCH_ID})` : colorHex(row.color),
    archived: row.status === "archived",
  }));
}

/** X-axis label budget; the full name lives in the tooltip and the sr-only table. */
const CATEGORY_TICK_MAX_CHARS = 14;

function truncateCategoryTick(name: string) {
  return name.length > CATEGORY_TICK_MAX_CHARS
    ? `${name.slice(0, CATEGORY_TICK_MAX_CHARS - 1)}…`
    : name;
}

/**
 * Recharts visual for the Monthly Ledger's Category Ranking — its own chunk so the Ledger
 * route stays light. Vertical bars diverging from a zero baseline: income above, expense
 * below. Bars are independent magnitudes, NOT parts of a whole — a Transaction's full
 * amount counts toward every Category it carries, so the bars deliberately do not sum
 * (CONTEXT: Category Ranking).
 */
export function LedgerCategoryRankingChart({
  currency,
  ranking,
  chartAnimationActive,
}: {
  currency: string;
  ranking: CategoryRankingRow[];
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
    compactTick.format(Math.abs(minorUnits) / 10 ** getCurrency(currencyCode).decimals);

  const data = toCategoryRankingBars(ranking);

  return (
    <div
      aria-hidden="true"
      data-chart-animation-active={String(chartAnimationActive)}
      className={CHART_SHELL_CLASSNAME}
    >
      <ResponsiveContainer
        width="100%"
        height="100%"
        // Mobile budget (~390) — a wide initialDimension expands page scrollWidth
        // before measure and breaks fixed bottom chrome.
        initialDimension={{ width: 320, height: 260 }}
      >
        <BarChart
          data={data}
          margin={{ top: 8, right: 8, bottom: 8, left: 0 }}
          // The visual is `aria-hidden` and the sr-only table is its accessible reading,
          // so Recharts' own keyboard layer (a focusable role="application" surface that
          // duplicates that table) must stay off — an aria-hidden tab stop is a trap.
          // jsdom draws no chart surface, so `e2e/transactions.spec.ts` guards this.
          accessibilityLayer={false}
        >
          <defs>
            <pattern
              id={ARCHIVED_HATCH_ID}
              width="6"
              height="6"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <line x1="0" y1="0" x2="0" y2="6" stroke="var(--muted-foreground)" strokeWidth="2" />
            </pattern>
          </defs>
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis
            dataKey="name"
            tickFormatter={truncateCategoryTick}
            tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
            tickLine={false}
            axisLine={{ stroke: "var(--border)" }}
          />
          <YAxis
            // Always keep the zero baseline inside the domain. Left to itself Recharts fits
            // an all-expense (or all-income) month to its own extremes, which puts the
            // smallest bar exactly on an axis bound — zero height, so that Category silently
            // disappears from the chart.
            domain={([dataMin, dataMax]) => [Math.min(dataMin, 0), Math.max(dataMax, 0)]}
            tickFormatter={formatTick}
            tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
            tickLine={false}
            axisLine={false}
            width={64}
          />
          <ReferenceLine y={0} stroke="var(--border)" />
          <Tooltip
            content={<RankingTooltip formatMinor={formatMinor} />}
            cursor={{ fill: "var(--muted)" }}
          />
          <Bar
            dataKey="signedMinor"
            name="Tagged total"
            shape={renderRankingBar}
            maxBarSize={48}
            isAnimationActive={chartAnimationActive}
            animationDuration={SCOPE_CHART_ANIMATION_MS}
            animationEasing="ease-out"
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** The geometry Recharts hands a bar shape, plus the row it draws. */
export type RankingBarShapeProps = Pick<BarShapeProps, "x" | "y" | "width" | "height" | "payload">;

/**
 * Recharts renders each bar through `shape` with the row it draws, so the bar can carry
 * its own fill — the Category colour, or the Archived hatch — instead of one series colour.
 */
export function renderRankingBar({ x, y, width, height, payload }: RankingBarShapeProps) {
  const datum: RankingBarDatum | undefined = payload;
  return <Rectangle x={x} y={y} width={width} height={height} fill={datum?.fill} radius={3} />;
}

/**
 * Hover readout for one bar. The visual chart is `aria-hidden`, so this is a sighted
 * affordance only; the sr-only table in {@link LedgerCategoryRanking} is the accessible
 * reading and carries the same Archived badge. Recharts injects the tooltip state when it
 * clones this element, so those props are optional here.
 */
function RankingTooltip({
  active,
  payload,
  formatMinor,
}: Partial<TooltipContentProps<number, string>> & {
  formatMinor: (minorUnits: number) => string;
}) {
  const datum: RankingBarDatum | undefined = payload?.[0]?.payload;
  if (!active || !datum) {
    return null;
  }
  return (
    // Custom `content` REPLACES Recharts' default tooltip, and `contentStyle` only styles
    // that default — so the card chrome lives here or the readout sits unreadable over the
    // bars (same chrome as `cash-flow-trend-chart.tsx`).
    <div className="rounded-lg border border-border bg-card p-2 text-xs text-foreground shadow-sm">
      <p className="font-medium">
        {datum.name}
        {datum.archived ? " (Archived)" : ""}
      </p>
      <p className="tabular-nums">{formatMinor(Math.abs(datum.signedMinor))}</p>
    </div>
  );
}
