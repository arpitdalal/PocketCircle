import {
  type ComparisonRangeMonths,
  DEFAULT_COMPARISON_RANGE_MONTHS,
  isComparisonRangeMonths,
  isTransactionType,
  type TransactionType,
} from "@pocketcircle/domain";

/** Default category analytics ranking — expense tagged spend (RPT-5). */
export const DEFAULT_CATEGORY_ANALYTICS_TYPE: TransactionType = "expense";

/**
 * The Dashboard's URL-owned selections (RPT-4/RPT-5): the Comparison Range and the
 * category analytics type toggle, so a filtered Dashboard view survives reload and can
 * be shared or revisited through history — the same URL-as-state policy as the Ledger
 * filters (`transaction-filter-url.ts`). One read/write pair so the route and tests
 * can never disagree about the param vocabulary.
 *
 * Defaults are OMITTED when writing: the canonical Dashboard URL stays the bare Circle
 * route (ADR 0016) unless the user actually narrowed something. A malformed `range`
 * reads as the default rather than throwing — a hand-edited URL degrades to the
 * standard view.
 *
 * `paidBy` is a legacy owned param only: it is stripped on canonicalization (the
 * Dashboard is Circle-wide; Member-specific investigation lives on Ledger/Search).
 */
export interface DashboardSelection {
  range: ComparisonRangeMonths;
  /** Expense vs income category ranking (RPT-5). */
  type: TransactionType;
}

/** Params this module owns when reading/writing; legacy `paidBy` is dropped, never preserved. */
export const DASHBOARD_PARAMS = ["paidBy", "range", "type"];
const DASHBOARD_PARAM_SET = new Set<string>(DASHBOARD_PARAMS);

export function readDashboardSelection(searchParams: URLSearchParams): DashboardSelection {
  const rawRange = Number(searchParams.get("range"));
  const rawType = (searchParams.get("type") ?? "").trim();
  return {
    range: isComparisonRangeMonths(rawRange) ? rawRange : DEFAULT_COMPARISON_RANGE_MONTHS,
    type: isTransactionType(rawType) ? rawType : DEFAULT_CATEGORY_ANALYTICS_TYPE,
  };
}

export function canonicalDashboardParams(
  selection: DashboardSelection,
  preserve?: URLSearchParams,
) {
  const params = new URLSearchParams();
  if (selection.range !== DEFAULT_COMPARISON_RANGE_MONTHS) {
    params.set("range", String(selection.range));
  }
  if (selection.type !== DEFAULT_CATEGORY_ANALYTICS_TYPE) {
    params.set("type", selection.type);
  }
  for (const [key, value] of preserve ?? []) {
    if (!DASHBOARD_PARAM_SET.has(key)) {
      params.append(key, value);
    }
  }
  return params;
}
