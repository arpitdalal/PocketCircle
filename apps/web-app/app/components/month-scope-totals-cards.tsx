import { NumberFlowGroup } from "@number-flow/react";
import type { CurrencyCode } from "@pocketcircle/domain";
import { AnimatedMoney } from "~/components/animated-money.js";
import { Skeleton } from "~/components/skeleton.js";
import { cn } from "~/lib/utils.js";

/** Integer minor-unit Income / Expense / Net triple shared by scope summary surfaces. */
export type ScopeTotalsMinor = {
  incomeMinor: number;
  expenseMinor: number;
  netMinor: number;
};

/**
 * Three-card Income / Expenses / Net grid for a single month scope (Dashboard,
 * Monthly Ledger). Digits animate together via NumberFlowGroup (ADR 0032).
 */
export function MonthScopeTotalsCards({
  legend,
  currency,
  totals,
  motionKey,
  motion = "scope",
  busy = false,
}: {
  legend: string;
  currency: CurrencyCode;
  totals: ScopeTotalsMinor | undefined;
  motionKey: string;
  motion?: "scope" | "always";
  /** True while a retained previous total is shown across a scope reload (ADR 0032). */
  busy?: boolean;
}) {
  const stats = [
    { label: "Income", amount: totals?.incomeMinor, tone: "text-positive" },
    { label: "Expenses", amount: totals?.expenseMinor, tone: "text-foreground" },
    {
      label: "Net",
      amount: totals?.netMinor,
      tone: (totals?.netMinor ?? 0) >= 0 ? "text-positive" : "text-destructive",
    },
  ] as const;

  return (
    <fieldset aria-busy={busy || totals === undefined}>
      <legend className="sr-only">{legend}</legend>
      <NumberFlowGroup>
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
                  <AnimatedMoney
                    minorUnits={stat.amount}
                    currency={currency}
                    motionKey={motionKey}
                    motion={motion}
                    pending={busy}
                  />
                )}
              </dd>
            </div>
          ))}
        </dl>
      </NumberFlowGroup>
    </fieldset>
  );
}
