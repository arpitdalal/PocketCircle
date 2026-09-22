import { colorLabel, searchResultTotalPages } from "@pocketcircle/domain";
import { SlidersHorizontal } from "lucide-react";
import { type FormEvent, useEffect } from "react";
import { useSearchParams } from "react-router";
import { MyTransactionList } from "~/components/my-transaction-list.js";
import { Button } from "~/components/ui/button.js";
import { DebouncedSearchInput } from "~/components/ui/debounced-search-input.js";
import { FilterPanel } from "~/components/ui/filter-panel.js";
import { MultiCombobox } from "~/components/ui/multi-combobox.js";
import { Pagination } from "~/components/ui/pagination.js";
import { Segmented } from "~/components/ui/segmented.js";
import { useFilterPanelDraft } from "~/components/ui/use-filter-panel-draft.js";
import { TRANSACTIONS_PAGE_SIZE, useMyTransactionCircles, useMyTransactions } from "~/lib/data.js";
import { keepScrollSearchParamsOptions } from "~/lib/keep-scroll-search-params.js";
import {
  activeMyTransactionsFilterCount,
  canonicalMyTransactionsParams,
  defaultMyTransactionsFilters,
  dropUnknownCircleIds,
  type MyTransactionsFilters,
  readMyTransactionsFilters,
  toMinorUnits,
} from "~/lib/transaction-filter-url.js";
import { cleanText } from "~/lib/url-codec.js";

/**
 * My Transactions (#389 / ADR 0034) — Paid-By-User cross-Circle list+filter.
 * URL owns filters + page. No Export, no Category/Recorded By filters, no totals.
 */
export default function MyTransactionsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = readMyTransactionsFilters(searchParams);
  const {
    open: panelOpen,
    openPanel,
    onOpenChange: setPanelOpen,
    draft,
    setDraft,
  } = useFilterPanelDraft(filters);
  const circleOptions = useMyTransactionCircles();

  useEffect(() => {
    if (!circleOptions) {
      return;
    }
    const next = dropUnknownCircleIds(
      filters,
      circleOptions.map((circle) => circle.id),
    );
    if (next.circles.length !== filters.circles.length) {
      setSearchParams(canonicalMyTransactionsParams({ ...next, page: 1 }), {
        replace: true,
      });
    }
  }, [circleOptions, filters, setSearchParams]);

  const results = useMyTransactions(toMyTransactionsQuery(filters), {
    page: filters.page,
    pageSize: TRANSACTIONS_PAGE_SIZE,
  });
  const totalPages = searchResultTotalPages(results.totalCount, results.pageSize);
  const filterCount = activeMyTransactionsFilterCount(filters);

  useEffect(() => {
    if (results.isLoading) {
      return;
    }
    if (results.totalCount === 0) {
      if (filters.page > 1) {
        setSearchParams(
          canonicalMyTransactionsParams({ ...filters, page: 1 }),
          keepScrollSearchParamsOptions({ replace: true }),
        );
      }
      return;
    }
    const maxPage = searchResultTotalPages(results.totalCount, results.pageSize);
    if (filters.page > maxPage) {
      setSearchParams(
        canonicalMyTransactionsParams({ ...filters, page: maxPage }),
        keepScrollSearchParamsOptions({ replace: true }),
      );
    }
  }, [filters, results.isLoading, results.pageSize, results.totalCount, setSearchParams]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (hasReversedRange(draft)) {
      return;
    }
    setSearchParams(
      canonicalMyTransactionsParams({ ...draft, q: filters.q, page: 1 }),
      keepScrollSearchParamsOptions({ replace: false }),
    );
    setPanelOpen(false);
  };

  const reset = () => {
    setSearchParams(
      canonicalMyTransactionsParams(defaultMyTransactionsFilters()),
      keepScrollSearchParamsOptions({ replace: false }),
    );
    setPanelOpen(false);
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4 sm:p-6">
      <div className="space-y-1">
        <h1 className="font-display text-2xl font-semibold tracking-tight">My Transactions</h1>
        <p className="text-sm text-muted-foreground">
          Transactions paid by you across your Circles.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <DebouncedSearchInput
          className="min-w-[12rem] flex-1"
          value={filters.q}
          label="Search title or note"
          normalize={(raw) => cleanText(raw)}
          onSearch={(q) => {
            setSearchParams(
              canonicalMyTransactionsParams({ ...filters, q, page: 1 }),
              keepScrollSearchParamsOptions({ replace: true }),
            );
          }}
        />
        <Button type="button" variant="outline" onClick={openPanel}>
          <SlidersHorizontal className="size-4" />
          Filters{filterCount > 0 ? ` (${filterCount})` : ""}
        </Button>
      </div>

      <MyTransactionList
        results={results}
        emptyLabel="No matching transactions."
        incompleteEmptyLabel="Couldn't scan far enough for this filter. Narrow by Circle or date range."
      />

      {results.scanIncomplete && results.transactions.length > 0 ? (
        <p className="text-sm text-muted-foreground" role="status">
          Scan stopped early — older matches may be missing. Narrow by Circle or date range.
        </p>
      ) : null}

      <Pagination
        currentPage={filters.page}
        totalPages={totalPages}
        totalCountCapped={results.totalCountCapped}
        loading={results.isLoading}
        onSelectPage={(page) => {
          setSearchParams(canonicalMyTransactionsParams({ ...filters, page }), {
            replace: false,
          });
        }}
      />

      <FilterPanel
        open={panelOpen}
        onOpenChange={setPanelOpen}
        title="Filters"
        footer={
          <>
            <Button type="button" variant="outline" onClick={reset}>
              Reset
            </Button>
            <Button
              type="submit"
              form="my-transactions-filter-form"
              className="ml-auto"
              disabled={hasReversedRange(draft)}
            >
              Apply
            </Button>
          </>
        }
      >
        <MyTransactionsFilterForm
          draft={draft}
          setDraft={setDraft}
          circleOptions={circleOptions}
          onSubmit={submit}
        />
      </FilterPanel>
    </div>
  );
}

function toMyTransactionsQuery(filters: MyTransactionsFilters) {
  return {
    type: filters.type,
    status: filters.status,
    ...(filters.q ? { query: filters.q } : {}),
    ...(filters.circles.length > 0 ? { circleIds: filters.circles } : {}),
    ...(filters.from ? { dateFrom: filters.from } : {}),
    ...(filters.to ? { dateTo: filters.to } : {}),
    ...(toMinorUnits(filters.min) !== undefined ? { amountMin: toMinorUnits(filters.min) } : {}),
    ...(toMinorUnits(filters.max) !== undefined ? { amountMax: toMinorUnits(filters.max) } : {}),
  };
}

function hasReversedRange(filters: MyTransactionsFilters) {
  const min = toMinorUnits(filters.min);
  const max = toMinorUnits(filters.max);
  return (
    Boolean(filters.from && filters.to && filters.from > filters.to) ||
    (min !== undefined && max !== undefined && min > max)
  );
}

function MyTransactionsFilterForm({
  draft,
  setDraft,
  circleOptions,
  onSubmit,
}: {
  draft: MyTransactionsFilters;
  setDraft: (filters: MyTransactionsFilters) => void;
  circleOptions: ReturnType<typeof useMyTransactionCircles>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const circles = circleOptions ?? [];
  const nameCounts = new Map<string, number>();
  for (const circle of circles) {
    nameCounts.set(circle.name, (nameCounts.get(circle.name) ?? 0) + 1);
  }
  const options = circles.map((circle) => {
    const color = colorLabel(circle.color);
    const ambiguous = (nameCounts.get(circle.name) ?? 0) > 1;
    const detailParts = [circle.currency, color];
    if (circle.status === "archived") {
      detailParts.push("Archived");
    }
    return {
      value: circle.id,
      // Same-name Circles (PRD 10) need Color in the chip/label — detail alone is not
      // announced on selected chips (matches circle-switcher disambiguation).
      label: ambiguous ? `${circle.name} (${color})` : circle.name,
      detail: detailParts.join(" · "),
    };
  });

  return (
    <form id="my-transactions-filter-form" className="space-y-4" onSubmit={onSubmit}>
      <Segmented
        label="Type"
        value={draft.type}
        options={[
          { label: "All", value: "all" },
          { label: "Expense", value: "expense" },
          { label: "Income", value: "income" },
        ]}
        onChange={(type) => setDraft({ ...draft, type })}
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
        label="Circles"
        value={draft.circles}
        options={options}
        onChange={(circles) => setDraft({ ...draft, circles })}
        disabled={circleOptions === undefined}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs text-muted-foreground">
          From
          <input
            type="date"
            value={draft.from}
            max={draft.to || undefined}
            onChange={(event) => setDraft({ ...draft, from: event.currentTarget.value })}
            className="mt-1 w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground shadow-sm outline-none transition-[border-color,box-shadow] duration-150 focus:border-ring focus:ring-2 focus:ring-ring/30 md:text-sm"
          />
        </label>
        <label className="block text-xs text-muted-foreground">
          To
          <input
            type="date"
            value={draft.to}
            min={draft.from || undefined}
            onChange={(event) => setDraft({ ...draft, to: event.currentTarget.value })}
            className="mt-1 w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground shadow-sm outline-none transition-[border-color,box-shadow] duration-150 focus:border-ring focus:ring-2 focus:ring-ring/30 md:text-sm"
          />
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs text-muted-foreground">
          Min amount
          <span className="mt-0.5 block font-normal text-muted-foreground/80">
            Each Circle’s own Currency
          </span>
          <input
            inputMode="decimal"
            value={draft.min}
            onChange={(event) => setDraft({ ...draft, min: event.currentTarget.value })}
            className="mt-1 w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground shadow-sm outline-none transition-[border-color,box-shadow] duration-150 focus:border-ring focus:ring-2 focus:ring-ring/30 md:text-sm"
          />
        </label>
        <label className="block text-xs text-muted-foreground">
          Max amount
          <span className="mt-0.5 block font-normal text-muted-foreground/80">
            Each Circle’s own Currency
          </span>
          <input
            inputMode="decimal"
            value={draft.max}
            onChange={(event) => setDraft({ ...draft, max: event.currentTarget.value })}
            className="mt-1 w-full rounded-md border border-input bg-card px-3 py-2 text-base text-foreground shadow-sm outline-none transition-[border-color,box-shadow] duration-150 focus:border-ring focus:ring-2 focus:ring-ring/30 md:text-sm"
          />
        </label>
      </div>
    </form>
  );
}
