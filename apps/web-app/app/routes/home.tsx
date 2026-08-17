import {
  colorLabel,
  formatMoney,
  type HomeRangeMonths,
  isHomeRangeMonths,
  money,
  toCurrencyCode,
} from "@pocketcircle/domain";
import { useEffect, useState } from "react";
import { href, Link, useSearchParams } from "react-router";
import { ActivationChecklist } from "~/components/activation-checklist.js";
import { CashFlowTrend } from "~/components/cash-flow-trend.js";
import { CircleMark } from "~/components/circle-mark.js";
import { LoadingStatus, Skeleton } from "~/components/skeleton.js";
import { buttonVariants } from "~/components/ui/button-variants.js";
import { ModalDialog } from "~/components/ui/dialog.js";
import { Segmented } from "~/components/ui/segmented.js";
import {
  type Circle,
  type HomeSummary,
  type HomeSummaryCircle,
  type HomeSummaryContribution,
  type HomeSummaryRecentTransaction,
  partitionCirclesByStatus,
  useExcludeCircle,
  useHomeSummary,
  useIncludeCircle,
  useMyCircles,
} from "~/lib/data.js";
import { canonicalHomeSummaryParams, readHomeSummarySelection } from "~/lib/home-summary-url.js";
import { transactionDetailHref } from "~/lib/ledger-url.js";
import { viewerLocale } from "~/lib/locale.js";
import { useReturnToOrigin, withReturnTo } from "~/lib/return-to-url.js";
import { cn } from "~/lib/utils.js";

const RANGE_OPTIONS: { label: string; value: HomeRangeMonths }[] = [
  { label: "1 mo", value: 1 },
  { label: "3 mo", value: 3 },
  { label: "6 mo", value: 6 },
  { label: "12 mo", value: 12 },
];

/** Segmented control stays compact for a handful of Currencies; a select is the simpler treatment past this. */
const CURRENCY_SEGMENTED_MAX = 4;

/** Home: the User's currency-scoped Cash Flow summary + Circle cards. */
export default function Home() {
  const circles = useMyCircles();
  const [searchParams, setSearchParams] = useSearchParams();
  const selection = readHomeSummarySelection(searchParams);

  const summary = useHomeSummary({
    currency: selection.currency,
    range: selection.range,
  });

  // Canonicalize URL when backend resolves a different currency/range than requested.
  // react-doctor-disable-next-line react-doctor/no-event-handler -- URL canonicalization on backend response
  useEffect(() => {
    if (!summary) return;
    const effectiveCurrency = summary.selectedCurrency;
    const effectiveRange = summary.range;
    if (effectiveCurrency !== selection.currency || effectiveRange !== selection.range) {
      setSearchParams(
        canonicalHomeSummaryParams(
          { currency: effectiveCurrency, range: effectiveRange },
          searchParams,
        ),
        { replace: true },
      );
    }
  }, [summary, selection.currency, selection.range, searchParams, setSearchParams]);

  if (circles === undefined || summary === undefined) {
    return <HomeLoading />;
  }

  const { active, archived } = partitionCirclesByStatus(circles);
  const locale = viewerLocale();
  const currencyCode = toCurrencyCode(summary.selectedCurrency);
  const formatMinor = (minorUnits: number) => formatMoney(money(minorUnits, currencyCode), locale);

  const selectRange = (range: HomeRangeMonths) => {
    setSearchParams(
      canonicalHomeSummaryParams({ currency: summary.selectedCurrency, range }, searchParams),
      { replace: false },
    );
  };

  const selectCurrency = (currency: string) => {
    setSearchParams(
      canonicalHomeSummaryParams({ currency, range: selection.range }, searchParams),
      { replace: false },
    );
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-semibold tracking-tight">Home</h1>
        <Link
          to={href("/circles/new")}
          className={buttonVariants({ variant: "default", size: "default" })}
        >
          Create circle
        </Link>
      </div>

      <ActivationChecklist />

      <CashFlowSection
        summary={summary}
        selectRange={selectRange}
        selectCurrency={selectCurrency}
        formatMinor={formatMinor}
      />

      <YourCirclesSection active={active} archived={archived} />
    </div>
  );
}

function HomeLoading() {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-semibold tracking-tight">Home</h1>
        <Link
          to={href("/circles/new")}
          className={buttonVariants({ variant: "default", size: "default" })}
        >
          Create circle
        </Link>
      </div>
      <LoadingStatus loading label="Loading home…" />
      <div className="space-y-3">
        <Skeleton className="h-6 w-32" />
        <div className="grid gap-3 sm:grid-cols-3">
          <Skeleton className="h-20 rounded-xl" />
          <Skeleton className="h-20 rounded-xl" />
          <Skeleton className="h-20 rounded-xl" />
        </div>
        <Skeleton className="h-72 rounded-xl" />
      </div>
    </div>
  );
}

function CashFlowSection({
  summary,
  selectRange,
  selectCurrency,
  formatMinor,
}: {
  summary: HomeSummary;
  selectRange: (range: HomeRangeMonths) => void;
  selectCurrency: (currency: string) => void;
  formatMinor: (minorUnits: number) => string;
}) {
  const [scopeOpen, setScopeOpen] = useState(false);
  const origin = useReturnToOrigin();

  return (
    <section aria-labelledby="cash-flow-heading" className="space-y-4">
      <div className="space-y-2">
        <h2 id="cash-flow-heading" className="font-display text-lg font-semibold tracking-tight">
          Cash flow
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          <CurrencyControl
            currencies={summary.availableCurrencies}
            selected={summary.selectedCurrency}
            onSelect={selectCurrency}
          />
          <Segmented
            label="Range"
            value={String(summary.range)}
            options={RANGE_OPTIONS.map((o) => ({
              label: o.label,
              value: String(o.value),
            }))}
            onChange={(v) => {
              const n = Number(v);
              if (isHomeRangeMonths(n)) selectRange(n);
            }}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>
            {summary.selectedCurrency} · {summary.includedCount} of {summary.availableCount} circles
          </span>
          <button
            type="button"
            className="text-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:rounded-sm"
            onClick={() => setScopeOpen(true)}
          >
            Choose circles
          </button>
        </div>
      </div>

      {summary.includedCount === 0 ? (
        <ZeroIncludedState
          currency={summary.selectedCurrency}
          onChoose={() => setScopeOpen(true)}
        />
      ) : (
        <>
          <TotalsCards totals={summary.totals} formatMinor={formatMinor} />
          <CashFlowTrend
            currency={summary.selectedCurrency}
            series={summary.series}
            caption={`Cash flow trend for ${summary.selectedCurrency}`}
          />
          {summary.contributions.length > 0 ? (
            <ContributionsSection contributions={summary.contributions} formatMinor={formatMinor} />
          ) : null}
          {summary.recent.length > 0 ? (
            <RecentTransactionsSection
              recent={summary.recent}
              origin={origin}
              formatMinor={formatMinor}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              No transactions in the selected {summary.selectedCurrency} scope yet.
            </p>
          )}
        </>
      )}

      <ScopeDialog open={scopeOpen} onOpenChange={setScopeOpen} circles={summary.circles} />
    </section>
  );
}

function CurrencyControl({
  currencies,
  selected,
  onSelect,
}: {
  currencies: string[];
  selected: string;
  onSelect: (currency: string) => void;
}) {
  if (currencies.length <= 1) {
    return null;
  }
  if (currencies.length <= CURRENCY_SEGMENTED_MAX) {
    return (
      <Segmented
        label="Currency"
        value={selected}
        options={currencies.map((c) => ({ label: c, value: c }))}
        onChange={onSelect}
      />
    );
  }
  return (
    <label className="flex items-center gap-1.5 text-sm">
      <span className="sr-only">Currency</span>
      <select
        value={selected}
        onChange={(e) => onSelect(e.target.value)}
        className="rounded-md border border-border bg-card px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {currencies.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    </label>
  );
}

function ZeroIncludedState({ currency, onChoose }: { currency: string; onChoose: () => void }) {
  return (
    <div className="rounded-xl border border-border bg-card p-6 text-center">
      <p className="text-sm text-muted-foreground">No circles included in this {currency} scope.</p>
      <button
        type="button"
        className={cn(buttonVariants({ variant: "outline", size: "sm" }), "mt-3")}
        onClick={onChoose}
      >
        Choose circles
      </button>
    </div>
  );
}

function TotalsCards({
  totals,
  formatMinor,
}: {
  totals: HomeSummary["totals"];
  formatMinor: (v: number) => string;
}) {
  return (
    <fieldset>
      <legend className="sr-only">Cash flow totals</legend>
      <div className="grid gap-3 sm:grid-cols-3">
        <TotalCard label="Income" amount={formatMinor(totals.incomeMinor)} variant="positive" />
        <TotalCard
          label="Expenses"
          amount={formatMinor(totals.expenseMinor)}
          variant="destructive"
        />
        <TotalCard label="Net cash flow" amount={formatMinor(totals.netMinor)} variant="primary" />
      </div>
    </fieldset>
  );
}

function TotalCard({
  label,
  amount,
  variant,
}: {
  label: string;
  amount: string;
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
      <p className={cn("clear-both mt-1 text-lg font-semibold", colorClass)}>{amount}</p>
    </fieldset>
  );
}

function ContributionsSection({
  contributions,
  formatMinor,
}: {
  contributions: HomeSummaryContribution[];
  formatMinor: (v: number) => string;
}) {
  return (
    <section aria-labelledby="per-circle-contribution-heading" className="space-y-2">
      <h3
        id="per-circle-contribution-heading"
        className="text-sm font-medium text-muted-foreground"
      >
        Per-Circle contribution
      </h3>
      <ul className="divide-y divide-border rounded-xl border border-border bg-card">
        {contributions.map((c) => (
          <li key={c.circleId}>
            <Link
              to={href("/circles/:circleRef", { circleRef: c.circleRef })}
              className="flex items-center justify-between px-4 py-3 text-sm hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <span className="font-medium">{c.name}</span>
              <span className="text-muted-foreground">
                {formatMinor(c.incomeMinor)} / {formatMinor(c.expenseMinor)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RecentTransactionsSection({
  recent,
  origin,
  formatMinor,
}: {
  recent: HomeSummaryRecentTransaction[];
  origin: string;
  formatMinor: (v: number) => string;
}) {
  return (
    <section aria-labelledby="recent-transactions-heading" className="space-y-2">
      <h3 id="recent-transactions-heading" className="text-sm font-medium text-muted-foreground">
        Recent transactions
      </h3>
      <ul className="divide-y divide-border rounded-xl border border-border bg-card">
        {recent.map((txn) => (
          <li key={txn.id}>
            <Link
              to={withReturnTo(
                transactionDetailHref({ ref: txn.circleRef }, { ref: txn.ref }),
                origin,
              )}
              className="flex items-center justify-between px-4 py-3 text-sm hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{txn.title}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {txn.circleName}
                </span>
              </span>
              <span
                className={cn(
                  "shrink-0 font-medium",
                  txn.type === "income" ? "text-positive" : "text-destructive",
                )}
              >
                {txn.type === "income" ? "+" : "−"}
                {formatMinor(txn.amountMinorUnits)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ScopeDialog({
  open,
  onOpenChange,
  circles,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  circles: HomeSummaryCircle[];
}) {
  const excludeCircle = useExcludeCircle();
  const includeCircle = useIncludeCircle();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Group circles by currency
  const grouped = new Map<string, HomeSummaryCircle[]>();
  for (const circle of circles) {
    const list = grouped.get(circle.currency) ?? [];
    list.push(circle);
    grouped.set(circle.currency, list);
  }

  const toggle = async (circle: HomeSummaryCircle) => {
    setError(null);
    setPending(circle.id);
    try {
      if (circle.included) {
        await excludeCircle({ circleId: circle.id });
      } else {
        await includeCircle({ circleId: circle.id });
      }
    } catch {
      setError(`Couldn't update ${circle.name}. Try again.`);
    } finally {
      setPending(null);
    }
  };

  return (
    <ModalDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Choose circles"
      description="Include or exclude circles from the Home cash flow report."
    >
      {error ? (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="space-y-4">
        {[...grouped.entries()].map(([currency, group]) => (
          <div key={currency}>
            <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {currency}
            </h4>
            <ul className="space-y-1">
              {group.map((circle) => (
                <li key={circle.id} className="flex items-center gap-2">
                  <label className="flex flex-1 cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/50">
                    <input
                      type="checkbox"
                      checked={circle.included}
                      disabled={pending === circle.id}
                      onChange={() => void toggle(circle)}
                      className="size-4 rounded border-border accent-primary focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    <span className="text-sm">
                      {circle.name}
                      {circle.status === "archived" ? (
                        <span className="ml-1 text-xs text-muted-foreground">(Archived)</span>
                      ) : null}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </ModalDialog>
  );
}

function YourCirclesSection({ active, archived }: { active: Circle[]; archived: Circle[] }) {
  return (
    <section aria-labelledby="your-circles-heading" className="space-y-3">
      <h2 id="your-circles-heading" className="font-display text-lg font-semibold tracking-tight">
        Your circles
      </h2>
      <ul className="grid gap-3 sm:grid-cols-2">
        {active.map((circle) => (
          <HomeCircleCard key={circle.id} circle={circle} />
        ))}
      </ul>
      {archived.length > 0 ? (
        <div className="space-y-3">
          <h3 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Archived
          </h3>
          <ul className="grid gap-3 sm:grid-cols-2">
            {archived.map((circle) => (
              <HomeCircleCard key={circle.id} circle={circle} muted />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function HomeCircleCard({ circle, muted = false }: { circle: Circle; muted?: boolean }) {
  return (
    <li>
      <Link
        to={href("/circles/:circleRef", { circleRef: circle.ref })}
        className="group block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <span
          className={cn(
            "flex items-center gap-3 rounded-xl border border-border bg-card p-4 shadow-sm transition-[border-color,box-shadow,transform] duration-150 group-hover:-translate-y-0.5 group-hover:border-ring/50 group-hover:shadow-md motion-reduce:group-hover:translate-y-0",
            muted && "text-muted-foreground",
          )}
        >
          <CircleMark mark={circle.mark} color={circle.color} />
          <span className="min-w-0">
            <span className="block truncate font-medium">{circle.name}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {circle.kind === "personal" ? "Your Circle" : "Circle"} · {circle.currency} ·{" "}
              {colorLabel(circle.color)}
              {muted ? " · Archived" : ""}
            </span>
          </span>
        </span>
      </Link>
    </li>
  );
}
