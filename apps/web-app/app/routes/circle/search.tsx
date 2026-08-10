import { searchResultTotalPages, toPlainDate } from "@spend-circle/domain";
import { Download, SlidersHorizontal } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { TransactionList } from "~/components/transaction-list.js";
import { Button } from "~/components/ui/button.js";
import { DebouncedSearchInput } from "~/components/ui/debounced-search-input.js";
import { FilterPanel } from "~/components/ui/filter-panel.js";
import { MultiCombobox, type MultiComboboxOption } from "~/components/ui/multi-combobox.js";
import { Pagination } from "~/components/ui/pagination.js";
import { Segmented } from "~/components/ui/segmented.js";
import { useFilterPanelDraft } from "~/components/ui/use-filter-panel-draft.js";
import { track } from "~/lib/analytics.js";
import { exportAnalyticsProps, searchFilterAnalyticsProps } from "~/lib/analytics-props.js";
import { buildTransactionExportCsv, downloadCsv } from "~/lib/csv.js";
import {
  TRANSACTIONS_PAGE_SIZE,
  useExportTransactions,
  useTransactionSearch,
  useTransactionSearchOptions,
} from "~/lib/data.js";
import { historicalMemberStatusDetail } from "~/lib/member-status-label.js";
import { mutationErrorMessageForUser } from "~/lib/mutation-user-message.js";
import { useSnackbar } from "~/lib/snackbar.js";
import {
  activeFilterCount,
  canonicalSearchParams,
  defaultSearchFilters,
  dropUnknownIds,
  readSearchFilters,
  type SearchFilters,
  toMinorUnits,
} from "~/lib/transaction-filter-url.js";
import { cleanText } from "~/lib/url-codec.js";
import { useCircle } from "~/routes/layouts/circle-layout.js";

export default function CircleSearch() {
  const circle = useCircle();
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = readSearchFilters(searchParams);
  const {
    open: panelOpen,
    openPanel,
    onOpenChange: setPanelOpen,
    draft,
    setDraft,
  } = useFilterPanelDraft(filters);
  const options = useTransactionSearchOptions(circle.id, panelOpen ? draft.type : filters.type);
  const results = useTransactionSearch(circle.id, toSearchQuery(filters), {
    page: filters.page,
    pageSize: TRANSACTIONS_PAGE_SIZE,
  });
  const filterCount = activeFilterCount(filters);
  const exportTransactions = useExportTransactions(circle.id);
  const { show } = useSnackbar();
  const [exporting, setExporting] = useState(false);

  // Hold the last LOADED pagination shape so the control stays mounted while the next
  // page is in flight (useQuery returns undefined on arg change) — unmounting it would
  // drop keyboard focus from the just-clicked page button and announce nothing. Adjust
  // during render guarded by a primitive compare so it converges (no effect/flash).
  const [lastPaging, setLastPaging] = useState({ totalPages: 0, totalCountCapped: false });
  if (!results.isLoading) {
    const totalPages = searchResultTotalPages(results.totalCount, results.pageSize);
    if (
      totalPages !== lastPaging.totalPages ||
      results.totalCountCapped !== lastPaging.totalCountCapped
    ) {
      setLastPaging({ totalPages, totalCountCapped: results.totalCountCapped });
    }
  }
  const { totalPages, totalCountCapped } = lastPaging;

  useEffect(() => {
    const next = canonicalSearchParams(filters);
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
  }, [filters, searchParams, setSearchParams]);

  useEffect(() => {
    if (results.isLoading) {
      return;
    }
    if (results.totalCount === 0) {
      if (filters.page > 1) {
        setSearchParams(canonicalSearchParams({ ...filters, page: 1 }), { replace: true });
      }
      return;
    }
    const maxPage = searchResultTotalPages(results.totalCount, results.pageSize);
    if (filters.page > maxPage) {
      setSearchParams(canonicalSearchParams({ ...filters, page: maxPage }), { replace: true });
    }
  }, [filters, results.isLoading, results.pageSize, results.totalCount, setSearchParams]);

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
      setSearchParams(canonicalSearchParams({ ...filters, ...cleaned, page: 1 }), {
        replace: true,
      });
    }
  }, [panelOpen, filters, options, setSearchParams]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (hasReversedRange(draft)) {
      return;
    }
    const applied = { ...draft, q: filters.q, page: 1 };
    track("transaction_search_submitted", searchFilterAnalyticsProps(applied));
    setSearchParams(canonicalSearchParams(applied), { replace: false });
    setPanelOpen(false);
  };

  const reset = () => {
    setSearchParams(canonicalSearchParams(defaultSearchFilters()), { replace: false });
    setPanelOpen(false);
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const result = await exportTransactions(toSearchQuery(filters));
      if (!result.ok) {
        if (result.reason === "tooMany") {
          track("export_performed", exportAnalyticsProps(filters, "too_many"));
          show(
            `Too many transactions to export (limit ${result.limit ?? "the cap"}). Narrow your search and try again.`,
          );
        } else {
          track("export_performed", exportAnalyticsProps(filters, "inaccessible"));
          show("Export isn't available.");
        }
        return;
      }
      const filename = `spend-circle-${circle.ref}-${toPlainDate(new Date())}.csv`;
      downloadCsv(filename, buildTransactionExportCsv(result.rows));
      track("export_performed", exportAnalyticsProps(filters, "downloaded"));
    } catch (error) {
      track("export_performed", exportAnalyticsProps(filters, "failed"));
      show(
        mutationErrorMessageForUser(error, "Couldn't export the search results. Please try again."),
      );
    } finally {
      setExporting(false);
    }
  };

  const paginatedList = {
    transactions: results.transactions,
    status: results.isLoading ? ("LoadingFirstPage" as const) : ("Exhausted" as const),
    loadMore: () => {},
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-lg font-semibold tracking-tight">Search</h2>
      </div>

      <div className="flex gap-2">
        <DebouncedSearchInput
          className="min-w-0 flex-1"
          value={filters.q}
          onSearch={(q) => {
            const next = { ...filters, q, page: 1 };
            track("transaction_search_submitted", searchFilterAnalyticsProps(next));
            setSearchParams(canonicalSearchParams(next), { replace: true });
          }}
          label="Search title or note"
          normalize={(raw) => cleanText(raw)}
        />
        <Button type="button" variant="outline" onClick={openPanel}>
          <SlidersHorizontal className="size-4" />
          Filters{filterCount > 0 ? ` (${filterCount})` : ""}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={exporting}
          onClick={() => void exportCsv()}
        >
          <Download className="size-4" />
          {exporting ? "Exporting…" : "Export"}
        </Button>
      </div>

      <TransactionList
        paginated={paginatedList}
        circle={circle}
        emptyLabel="No matching transactions."
        canEdit={circle.status === "active"}
        paginationMode="none"
      />

      <Pagination
        currentPage={filters.page}
        totalPages={totalPages}
        totalCountCapped={totalCountCapped}
        loading={results.isLoading}
        onSelectPage={(page) => {
          track("transaction_search_page_changed", { page });
          setSearchParams(canonicalSearchParams({ ...filters, page }), { replace: false });
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
              form="search-filter-form"
              className="ml-auto"
              disabled={hasReversedRange(draft)}
            >
              Apply
            </Button>
          </>
        }
      >
        <SearchFilterForm
          draft={draft}
          setDraft={setDraft}
          options={options}
          optionsLoading={options === undefined}
          onSubmit={submit}
        />
      </FilterPanel>
    </div>
  );
}

function toSearchQuery(filters: SearchFilters) {
  return {
    type: filters.type,
    status: filters.status,
    ...(filters.q ? { query: filters.q } : {}),
    ...(filters.categories.length > 0 ? { categoryIds: filters.categories } : {}),
    ...(filters.recordedBy.length > 0 ? { recordedByMemberIds: filters.recordedBy } : {}),
    ...(filters.paidBy.length > 0 ? { paidByMemberIds: filters.paidBy } : {}),
    ...(filters.from ? { dateFrom: filters.from } : {}),
    ...(filters.to ? { dateTo: filters.to } : {}),
    ...(toMinorUnits(filters.min) !== undefined ? { amountMin: toMinorUnits(filters.min) } : {}),
    ...(toMinorUnits(filters.max) !== undefined ? { amountMax: toMinorUnits(filters.max) } : {}),
  };
}

function hasReversedRange(filters: SearchFilters) {
  const min = toMinorUnits(filters.min);
  const max = toMinorUnits(filters.max);
  return (
    Boolean(filters.from && filters.to && filters.from > filters.to) ||
    (min !== undefined && max !== undefined && min > max)
  );
}

function SearchFilterForm({
  draft,
  setDraft,
  options,
  optionsLoading,
  onSubmit,
}: {
  draft: SearchFilters;
  setDraft: (filters: SearchFilters) => void;
  options: ReturnType<typeof useTransactionSearchOptions>;
  optionsLoading: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const categoryOptions = toCategoryOptions(options?.categories ?? []);
  const memberOptions = toMemberOptions(options?.members ?? []);
  return (
    <form id="search-filter-form" className="space-y-4" onSubmit={onSubmit}>
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
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs text-muted-foreground">
          From
          <input
            type="date"
            value={draft.from}
            max={draft.to || undefined}
            onChange={(event) => setDraft({ ...draft, from: event.currentTarget.value })}
            className="mt-1 w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm outline-none transition-[border-color,box-shadow] duration-150 focus:border-ring focus:ring-2 focus:ring-ring/30 text-foreground"
          />
        </label>
        <label className="block text-xs text-muted-foreground">
          To
          <input
            type="date"
            value={draft.to}
            min={draft.from || undefined}
            onChange={(event) => setDraft({ ...draft, to: event.currentTarget.value })}
            className="mt-1 w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm outline-none transition-[border-color,box-shadow] duration-150 focus:border-ring focus:ring-2 focus:ring-ring/30 text-foreground"
          />
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs text-muted-foreground">
          Amount min
          <input
            type="number"
            min="0"
            step="0.01"
            value={draft.min}
            onChange={(event) => setDraft({ ...draft, min: event.currentTarget.value })}
            className="mt-1 w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm outline-none transition-[border-color,box-shadow] duration-150 focus:border-ring focus:ring-2 focus:ring-ring/30 text-foreground"
          />
        </label>
        <label className="block text-xs text-muted-foreground">
          Amount max
          <input
            type="number"
            min={draft.min || "0"}
            step="0.01"
            value={draft.max}
            onChange={(event) => setDraft({ ...draft, max: event.currentTarget.value })}
            className="mt-1 w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm outline-none transition-[border-color,box-shadow] duration-150 focus:border-ring focus:ring-2 focus:ring-ring/30 text-foreground"
          />
        </label>
      </div>
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
  categories: NonNullable<ReturnType<typeof useTransactionSearchOptions>>["categories"],
) {
  return categories.map((category) => ({
    value: category.id,
    label: category.name,
    detail: category.status === "archived" ? "archived" : undefined,
    color: category.color,
  })) satisfies MultiComboboxOption[];
}

function toMemberOptions(
  members: NonNullable<ReturnType<typeof useTransactionSearchOptions>>["members"],
) {
  return members.map((member) => ({
    value: member.id,
    label: member.displayName,
    detail: historicalMemberStatusDetail(member.status),
  })) satisfies MultiComboboxOption[];
}
