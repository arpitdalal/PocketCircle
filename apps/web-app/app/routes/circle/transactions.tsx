import {
  addMonths,
  isValidPlainMonth,
  type PlainMonth,
  type TransactionType,
  toCurrencyCode,
} from "@pocketcircle/domain";
import { SlidersHorizontal } from "lucide-react";
import { type FormEvent, useEffect, useRef } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { MonthScopeTotalsCards } from "~/components/month-scope-totals-cards.js";
import { TransactionList } from "~/components/transaction-list.js";
import { Button } from "~/components/ui/button.js";
import { buttonVariants } from "~/components/ui/button-variants.js";
import { FilterPanel } from "~/components/ui/filter-panel.js";
import { MultiCombobox, type MultiComboboxOption } from "~/components/ui/multi-combobox.js";
import { Segmented } from "~/components/ui/segmented.js";
import { useFilterPanelDraft } from "~/components/ui/use-filter-panel-draft.js";
import { track } from "~/lib/analytics.js";
import { ledgerFilterAnalyticsProps } from "~/lib/analytics-props.js";
import { circlePath } from "~/lib/circle-path.js";
import {
  useLedgerFilterOptions,
  useLedgerTransactionFilter,
  useMonthlySummary,
} from "~/lib/data.js";
import { formatMonthLabel } from "~/lib/datetime.js";
import { transactionNewHref, withQuery } from "~/lib/ledger-url.js";
import { historicalMemberStatusDetail } from "~/lib/member-status-label.js";
import { useReturnToOrigin, withReturnTo } from "~/lib/return-to-url.js";
import {
  activeFilterCount,
  canonicalLedgerParams,
  defaultLedgerFilters,
  dropUnknownIds,
  type LedgerFilters,
  readLedgerFilters,
} from "~/lib/transaction-filter-url.js";
import { useCircle } from "~/routes/layouts/circle-layout.js";

export default function CircleTransactions() {
  const circle = useCircle();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const writable = circle.status === "active";
  const filters = readLedgerFilters(searchParams);
  const filterCount = activeFilterCount(filters);
  // Back-compat: an old `?new=expense|income` deep link is no longer an inline toggle — it
  // redirects to the dedicated create route (issue #96). A valid value only redirects while
  // writable; otherwise it's scrubbed below like any unknown param.
  const rawNew = searchParams.get("new");
  const legacyCreateType: TransactionType | null =
    writable && (rawNew === "expense" || rawNew === "income") ? rawNew : null;
  // The ledger's full URL (filters, page, month) is the origin a create/edit/detail link
  // returns to via `returnTo` (#123), so a filtered ledger round-trips for free.
  const origin = useReturnToOrigin();
  const {
    open: panelOpen,
    openPanel,
    onOpenChange: setPanelOpen,
    draft,
    setDraft,
  } = useFilterPanelDraft(filters);
  const options = useLedgerFilterOptions(
    circle.id,
    filters.month,
    panelOpen ? draft.type : filters.type,
  );
  const summaryView = useMonthlySummary(circle.id, filters.month);
  const summary = summaryView.summary;
  const summaryPending = summaryView.isPending;
  // One query owns the list. It serves the unfiltered default (status=all, whole month)
  // as well as any narrowing filters — there is no active-only base-list shortcut, so the
  // default view can include archived rows (distinguished in the row, not hidden).
  const transactions = useLedgerTransactionFilter(circle.id, toLedgerQuery(filters));

  // An old `?new=expense|income` deep link redirects (replace) to the dedicated create
  // route, carrying the current month as the form's date default and the clean ledger URL
  // (no `new`) as the `returnTo` origin — so the back-compat path is indistinguishable from
  // clicking the CTA. Runs before the canonical scrub so the redirect wins.
  useEffect(() => {
    if (!legacyCreateType) {
      return;
    }
    const ledgerOrigin = canonicalLedgerParams(filters, searchParams);
    ledgerOrigin.delete("new");
    const ledgerOriginUrl = withQuery(
      circlePath(circle.ref, "transactions"),
      ledgerOrigin.toString(),
    );
    navigate(
      withReturnTo(
        transactionNewHref(circle, { type: legacyCreateType, month: filters.month }),
        ledgerOriginUrl,
      ),
      { replace: true },
    );
  }, [legacyCreateType, circle, filters, searchParams, navigate]);

  useEffect(() => {
    // A valid `new` value is mid-redirect (above); leave the URL untouched so the scrub
    // doesn't race it. Any other unknown param (incl. an invalid `new`) is dropped here.
    if (legacyCreateType) {
      return;
    }
    const next = canonicalLedgerParams(filters, searchParams);
    next.delete("new");
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, filters, legacyCreateType, setSearchParams]);

  useEffect(() => {
    // Drop URL-selected ids no longer in the option universe (e.g. a stale deep link).
    // Only while the panel is CLOSED: open, `options` follows the DRAFT type, so cleaning
    // the still-applied `filters` against it would strip a valid selection of the applied
    // type and silently change the live result set before the user applies anything.
    // Closed, `options` follows `filters.type`, which is exactly what we validate against.
    if (panelOpen || !options) {
      return;
    }
    const categoryIds = options.categories.map((category) => category.id);
    const memberIds = options.members.map((member) => member.id);
    const cleaned = dropUnknownIds(filters, { categoryIds, memberIds });
    if (
      cleaned.categories.join(",") !== filters.categories.join(",") ||
      cleaned.recordedBy.join(",") !== filters.recordedBy.join(",") ||
      cleaned.paidBy.join(",") !== filters.paidBy.join(",")
    ) {
      setSearchParams(canonicalLedgerParams({ ...filters, ...cleaned }, searchParams), {
        replace: true,
      });
    }
  }, [panelOpen, filters, options, searchParams, setSearchParams]);

  const goToMonth = (next: PlainMonth) => {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        const canonical = defaultLedgerFilters(next);
        return canonicalLedgerParams(canonical, params);
      },
      { replace: false },
    );
  };

  const applyFilters = () => {
    const applied = { ...draft, month: filters.month };
    track("ledger_filter_applied", ledgerFilterAnalyticsProps(applied));
    setSearchParams(canonicalLedgerParams(applied, searchParams), {
      replace: false,
    });
    setPanelOpen(false);
  };

  const submitLedgerFilters = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    applyFilters();
  };

  const resetFilters = () => {
    setSearchParams(canonicalLedgerParams(defaultLedgerFilters(filters.month), searchParams), {
      replace: false,
    });
    setPanelOpen(false);
  };

  const monthLabel = formatMonthLabel(filters.month);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-lg font-semibold tracking-tight">Transactions</h2>
        {writable ? (
          <div className="flex gap-2">
            <Link
              to={withReturnTo(
                transactionNewHref(circle, { type: "expense", month: filters.month }),
                origin,
              )}
              className={buttonVariants()}
            >
              Add expense
            </Link>
            <Link
              to={withReturnTo(
                transactionNewHref(circle, { type: "income", month: filters.month }),
                origin,
              )}
              className={buttonVariants({ variant: "outline" })}
            >
              Add income
            </Link>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <MonthNavigator month={filters.month} onChange={goToMonth} />
        <Button type="button" variant="outline" onClick={openPanel}>
          <SlidersHorizontal className="size-4" />
          Filters{filterCount > 0 ? ` (${filterCount})` : ""}
        </Button>
      </div>

      <MonthScopeTotalsCards
        legend="Monthly totals"
        currency={toCurrencyCode(summary?.currency ?? circle.currency)}
        totals={summary?.totals}
        motionKey={`ledger:${filters.month}`}
        busy={summaryPending}
      />

      {!writable ? (
        <p className="rounded-lg border border-border bg-card p-3 shadow-sm text-sm text-muted-foreground">
          This circle is archived. Restore it to add transactions.
        </p>
      ) : null}

      <TransactionList
        paginated={transactions}
        circle={circle}
        emptyLabel={
          filterCount > 0 ? "No matching transactions." : `No transactions in ${monthLabel}.`
        }
        canEdit={writable}
        ledgerMonth={filters.month}
        showLifecycle
      />

      <FilterPanel
        open={panelOpen}
        onOpenChange={setPanelOpen}
        title="Filters"
        footer={
          <>
            <Button type="button" variant="outline" onClick={resetFilters}>
              Reset
            </Button>
            <Button type="submit" form="ledger-filter-form" className="ml-auto">
              Apply
            </Button>
          </>
        }
      >
        <LedgerFilterForm
          draft={draft}
          setDraft={setDraft}
          options={options}
          optionsLoading={options === undefined}
          onSubmit={submitLedgerFilters}
        />
      </FilterPanel>
    </div>
  );
}

function toLedgerQuery(filters: LedgerFilters) {
  return {
    month: filters.month,
    type: filters.type,
    status: filters.status,
    ...(filters.q ? { query: filters.q } : {}),
    ...(filters.categories.length > 0 ? { categoryIds: filters.categories } : {}),
    ...(filters.recordedBy.length > 0 ? { recordedByMemberIds: filters.recordedBy } : {}),
    ...(filters.paidBy.length > 0 ? { paidByMemberIds: filters.paidBy } : {}),
  };
}

function LedgerFilterForm({
  draft,
  setDraft,
  options,
  optionsLoading,
  onSubmit,
}: {
  draft: LedgerFilters;
  setDraft: (filters: LedgerFilters) => void;
  options: ReturnType<typeof useLedgerFilterOptions>;
  optionsLoading: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const categoryOptions = toCategoryOptions(options?.categories ?? []);
  const memberOptions = toMemberOptions(options?.members ?? []);
  return (
    <form id="ledger-filter-form" className="space-y-4" onSubmit={onSubmit}>
      <label className="block text-xs text-muted-foreground">
        Search title or note
        <input
          type="search"
          value={draft.q}
          onChange={(event) => setDraft({ ...draft, q: event.currentTarget.value })}
          className="mt-1 w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm outline-none transition-[border-color,box-shadow] duration-150 focus:border-ring focus:ring-2 focus:ring-ring/30 text-foreground"
        />
      </label>
      <Segmented
        label="Type"
        value={draft.type}
        options={[
          { label: "All", value: "all" },
          { label: "Expense", value: "expense" },
          { label: "Income", value: "income" },
        ]}
        onChange={(type) => setDraft({ ...draft, type, categories: [] })}
      />
      <Segmented
        label="Status"
        value={draft.status}
        options={[
          { label: "Active", value: "active" },
          { label: "Archived", value: "archived" },
          { label: "All", value: "all" },
        ]}
        onChange={(status) => setDraft({ ...draft, status })}
      />
      <MultiCombobox
        label="Categories"
        options={categoryOptions}
        value={draft.categories}
        disabled={optionsLoading}
        onChange={(categories) => setDraft({ ...draft, categories })}
      />
      <MultiCombobox
        label="Recorded by"
        options={memberOptions}
        value={draft.recordedBy}
        disabled={optionsLoading}
        onChange={(recordedBy) => setDraft({ ...draft, recordedBy })}
      />
      <MultiCombobox
        label="Paid by"
        options={memberOptions}
        value={draft.paidBy}
        disabled={optionsLoading}
        onChange={(paidBy) => setDraft({ ...draft, paidBy })}
      />
    </form>
  );
}

function toCategoryOptions(
  categories: NonNullable<ReturnType<typeof useLedgerFilterOptions>>["categories"],
) {
  return categories.map((category) => ({
    value: category.id,
    label: category.name,
    detail: category.status === "archived" ? "archived" : undefined,
    color: category.color,
  })) satisfies MultiComboboxOption[];
}

function toMemberOptions(
  members: NonNullable<ReturnType<typeof useLedgerFilterOptions>>["members"],
) {
  return members.map((member) => ({
    value: member.id,
    label: member.displayName,
    detail: historicalMemberStatusDetail(member.status),
  })) satisfies MultiComboboxOption[];
}

function MonthNavigator({
  month,
  onChange,
}: {
  month: PlainMonth;
  onChange: (month: PlainMonth) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (input && input.value !== month) {
      input.value = month;
    }
  }, [month]);

  const commit = () => {
    const input = inputRef.current;
    if (!input) {
      return;
    }
    if (isValidPlainMonth(input.value)) {
      if (input.value !== month) {
        onChange(input.value);
      }
    } else {
      input.value = month;
    }
  };

  return (
    <fieldset className="flex items-center gap-2">
      <legend className="sr-only">Select month</legend>
      <Button
        type="button"
        variant="outline"
        aria-label="Previous month"
        onClick={() => onChange(addMonths(month, -1))}
      >
        ‹
      </Button>
      <label htmlFor="ledger-month" className="sr-only">
        Month
      </label>
      <input
        ref={inputRef}
        id="ledger-month"
        type="month"
        defaultValue={month}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commit();
          }
        }}
        className="rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm outline-none transition-[border-color,box-shadow] duration-150 focus:border-ring focus:ring-2 focus:ring-ring/30"
      />
      <Button
        type="button"
        variant="outline"
        aria-label="Next month"
        onClick={() => onChange(addMonths(month, 1))}
      >
        ›
      </Button>
    </fieldset>
  );
}
