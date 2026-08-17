import {
  DEFAULT_HOME_RANGE_MONTHS,
  type HomeRangeMonths,
  isHomeRangeMonths,
} from "@pocketcircle/domain";

/** Params this module owns — stripped/canonicalized when writing; foreign params preserved. */
export const HOME_SUMMARY_PARAMS = ["currency", "range"] as const;
const HOME_SUMMARY_PARAM_SET = new Set<string>(HOME_SUMMARY_PARAMS);

export interface HomeSummarySelection {
  currency: string | undefined;
  range: HomeRangeMonths;
}

/**
 * Reads the Home Summary selections from URL search params. Invalid range falls
 * back to the default; currency is an opaque string validated against the backend's
 * `availableCurrencies` at render time (the route replaces the URL when the backend
 * resolves to a different effective currency/range).
 */
export function readHomeSummarySelection(searchParams: URLSearchParams): HomeSummarySelection {
  const rawCurrency = searchParams.get("currency")?.trim() || undefined;
  const rawRange = Number(searchParams.get("range"));
  return {
    currency: rawCurrency,
    range: isHomeRangeMonths(rawRange) ? rawRange : DEFAULT_HOME_RANGE_MONTHS,
  };
}

/**
 * Builds canonical URL params for the Home Summary. Strips default values (range=1)
 * and invalid/empty currency. Preserves all foreign params in their original order.
 */
export function canonicalHomeSummaryParams(
  selection: HomeSummarySelection,
  preserve?: URLSearchParams,
) {
  const params = new URLSearchParams();
  // Preserve foreign params in their original order first
  if (preserve) {
    for (const [key, value] of preserve) {
      if (!HOME_SUMMARY_PARAM_SET.has(key)) {
        params.append(key, value);
      }
    }
  }
  // Write owned params only when non-default
  if (selection.currency) {
    params.set("currency", selection.currency);
  }
  if (selection.range !== DEFAULT_HOME_RANGE_MONTHS) {
    params.set("range", String(selection.range));
  }
  return params;
}
