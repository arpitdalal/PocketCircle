import { NumberFlowGroup } from "@number-flow/react";
import type { CurrencyCode } from "@pocketcircle/domain";
import { AnimatedMoney } from "~/components/animated-money.js";
import type { ScopeTotalsMinor } from "~/components/month-scope-totals-cards.js";
import { cn } from "~/lib/utils.js";

/**
 * Home Summary Cash flow headline totals (ADR 0031/0032). Fieldset-card layout
 * matches the existing Home a11y tree; amounts animate on currency/range/scope change.
 */
export function HomeCashFlowTotalsCards({
  currency,
  totals,
}: {
  currency: CurrencyCode;
  totals: ScopeTotalsMinor;
}) {
  return (
    <fieldset>
      <legend className="sr-only">Cash flow totals</legend>
      <NumberFlowGroup>
        <div className="grid gap-3 sm:grid-cols-3">
          <HomeCashFlowTotalCard
            label="Income"
            minorUnits={totals.incomeMinor}
            currency={currency}
            variant="positive"
          />
          <HomeCashFlowTotalCard
            label="Expenses"
            minorUnits={totals.expenseMinor}
            currency={currency}
            variant="destructive"
          />
          <HomeCashFlowTotalCard
            label="Net cash flow"
            minorUnits={totals.netMinor}
            currency={currency}
            variant="primary"
          />
        </div>
      </NumberFlowGroup>
    </fieldset>
  );
}

function HomeCashFlowTotalCard({
  label,
  minorUnits,
  currency,
  variant,
}: {
  label: string;
  minorUnits: number;
  currency: CurrencyCode;
  variant: "positive" | "destructive" | "primary";
}) {
  const colorClass =
    variant === "positive"
      ? "text-positive"
      : variant === "destructive"
        ? "text-destructive"
        : "text-primary";
  return (
    <fieldset className="min-w-0 rounded-xl border border-border bg-card p-4 shadow-sm">
      <legend className="float-left w-full p-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </legend>
      <p className={cn("clear-both mt-1 text-lg font-semibold tabular-nums", colorClass)}>
        <AnimatedMoney minorUnits={minorUnits} currency={currency} />
      </p>
    </fieldset>
  );
}
