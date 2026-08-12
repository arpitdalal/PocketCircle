import type { TransactionType } from "@pocketcircle/domain";

import { withQuery } from "./ledger-url.js";
import { cleanText, readLifecycleStatus } from "./url-codec.js";

/**
 * URL codec for the Categories page's **Category Filter** (CAT-4) — a small
 * sibling of `transaction-filter-url.ts`. The page shows all types by default and
 * offers an All / Expense / Income filter (issue #138), so `type` is the same
 * `"all" | TransactionType` shape the ledger uses, defaulting to `"all"`. Filter
 * state lives in the URL so a filtered view is shareable and reproducible (ADR 0016).
 *
 * Canonical form: `type` and `status` are ALWAYS written (so a copied URL is
 * self-describing), `q` is omitted when empty and trimmed/normalized when
 * present. Readers clamp unknown values to the defaults.
 */

export type CategoryLifecycleFilter = "active" | "archived" | "all";
export type TypeFilter = "all" | TransactionType;

export interface CategoriesFilters {
  type: TypeFilter;
  status: CategoryLifecycleFilter;
  q: string;
}

/** All types by default (issue #138), and `"all"` is the canonical default
 * written to the URL — parity with the ledger's one-picture view. */
export const DEFAULT_CATEGORIES_TYPE: TypeFilter = "all";
/** Parity with the ledger's one-picture view: archived rows are distinguished,
 * not hidden, so history is visible without toggling. */
export const DEFAULT_CATEGORIES_STATUS: CategoryLifecycleFilter = "all";

const FILTER_PARAMS = ["type", "status", "q"];
const FILTER_PARAM_SET = new Set<string>(FILTER_PARAMS);

/** The canonical `q` text: trimmed, internal whitespace collapsed (case kept —
 * the backend match is case-insensitive, but the URL shows what was typed). The
 * route's debounce compares against this to avoid writing no-op history entries. */
export function cleanQueryText(value: string | null) {
  return cleanText(value);
}

function readType(value: string | null): TypeFilter {
  return value === "expense" || value === "income" || value === "all"
    ? value
    : DEFAULT_CATEGORIES_TYPE;
}

function readStatus(value: string | null): CategoryLifecycleFilter {
  return readLifecycleStatus(value, DEFAULT_CATEGORIES_STATUS);
}

export function readCategoriesFilters(searchParams: URLSearchParams): CategoriesFilters {
  return {
    type: readType(searchParams.get("type")),
    status: readStatus(searchParams.get("status")),
    q: cleanQueryText(searchParams.get("q")),
  };
}

export function writeCategoriesFilters(params: URLSearchParams, filters: CategoriesFilters) {
  params.set("type", filters.type);
  params.set("status", filters.status);
  const q = cleanQueryText(filters.q);
  if (q) {
    params.set("q", q);
  } else {
    params.delete("q");
  }
}

/** The canonical params for a filter state, preserving any non-filter params the
 * URL carries (same contract as `canonicalLedgerParams`). */
export function canonicalCategoriesParams(filters: CategoriesFilters, preserve?: URLSearchParams) {
  const params = new URLSearchParams();
  writeCategoriesFilters(params, filters);
  for (const [key, value] of preserve ?? []) {
    if (!FILTER_PARAM_SET.has(key)) {
      params.append(key, value);
    }
  }
  return params;
}

export function defaultCategoriesFilters(): CategoriesFilters {
  return { type: DEFAULT_CATEGORIES_TYPE, status: DEFAULT_CATEGORIES_STATUS, q: "" };
}

/** Whether any narrowing is applied — drives the "no matches" vs "no Categories
 * yet" empty-state split. A concrete (non-default) type counts now that the
 * default scope is `"all"` (issue #138): under Expense/Income an empty result is
 * a filter miss, not "no Categories at all". */
export function hasCategoriesNarrowing(filters: CategoriesFilters) {
  return (
    filters.q !== "" ||
    filters.status !== DEFAULT_CATEGORIES_STATUS ||
    filters.type !== DEFAULT_CATEGORIES_TYPE
  );
}

/**
 * Canonical new-Category route path (issue #96; revised #138): the dedicated create page
 * carries an OPTIONAL initial `type` (`expense | income`) so the CTA can deep-link a
 * concrete type when the list is filtered to one. When the list type is `"all"` there is
 * no concrete type to seed — `type` is omitted and the form defaults to `expense` (you
 * can't create an "all" category). The caller appends the validated `returnTo` origin via
 * `withReturnTo`, which merges into this query — the single home for the create link so the
 * list CTA can't drift.
 */
export function categoryNewHref(circle: { ref: string }, { type }: { type: TypeFilter }) {
  const params = new URLSearchParams();
  if (type !== "all") {
    params.set("type", type);
  }
  return withQuery(`/circles/${circle.ref}/categories/new`, params.toString());
}
