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
const ARCHIVED_HATCH_ID = "ledger-category-ranking-archived-hatch";

/**
 * Projects ranking rows onto diverging bars. The sign is presentation only — the row's
 * `taggedTotalMinor` stays a positive magnitude — and an Archived Category keeps its
 * Category colour but draws it as a hatch.
 */
export function toCategoryRankingBars(ranking: CategoryRankingRow[]): RankingBarDatum[] {
  return ranking.map((row) => ({
    name: row.name,
    signedMinor: row.type === "income" ? row.taggedTotalMinor : -row.taggedTotalMinor,
    fill: row.status === "archived" ? `url(#${ARCHIVED_HATCH_ID})` : colorHex(row.color),
    archived: row.status === "archived",
  }));
}

/**
 * Axis labels stay short so a busy month doesn't turn into overlapping text: the full
 * Category name lives in the tooltip and the sr-only table.
 */
function truncateCategoryTick(name: string) {
  return name.length > CATEGORY_TICK_MAX_CHARS
    ? `${name.slice(0, CATEGORY_TICK_MAX_CHARS - 1)}…`
    : name;
}

const CATEGORY_TICK_MAX_CHARS = 14;

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
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
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
            contentStyle={{
              backgroundColor: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: "0.5rem",
              color: "var(--foreground)",
            }}
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

/**
 * Recharts renders each bar through `shape` with the row it draws, so the bar can carry
 * its own fill — the Category colour, or the Archived hatch — instead of one series colour.
 */
function renderRankingBar(props: BarShapeProps) {
  const datum: RankingBarDatum | undefined = props.payload;
  return <Rectangle {...props} fill={datum?.fill} radius={3} />;
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
    <div className="text-xs">
      <p className="font-medium">
        {datum.name}
        {datum.archived ? " (Archived)" : ""}
      </p>
      <p className="tabular-nums">{formatMinor(Math.abs(datum.signedMinor))}</p>
    </div>
  );
}
