import type { PlainMonth, TransactionType } from "@pocketcircle/domain";
import { circlePath } from "./circle-path.js";
import {
  canonicalLedgerParams,
  canonicalSearchParams,
  defaultLedgerFilters,
  defaultSearchFilters,
} from "./transaction-filter-url.js";

/**
 * Transaction object-route URL helpers. The origin a route returns to on close/back —
 * the ledger month, search filters + page, dashboard scope — is no longer carried as a
 * structural slice here; it lives in the app-wide `returnTo` codec (`return-to-url.ts`,
 * issue #123). What remains is the canonical detail-path builder shared by the ledger /
 * search rows and the Dashboard recent feed, plus the small query-join those helpers and
 * `withReturnTo` reuse so the `?`-vs-empty rule has a single home.
 */

/** Joins a path with a bare query (no leading `?`), omitting the `?` when the query is empty. */
export function withQuery(path: string, query: string) {
  return query ? `${path}?${query}` : path;
}

/**
 * Minimal shape for building a Transaction detail URL — keeps this helper free of the
 * data barrel (ADR 0003 view types stay at call sites).
 */
type ObjectRef = { ref: string };

/**
 * Canonical read-only Transaction detail path for a Circle object route. The origin to
 * return to is carried separately as a validated `returnTo` param (see `withReturnTo`),
 * so this is just the bare path — the single home both the ledger/search rows and the
 * Dashboard recent feed build, so they can't drift.
 */
export function transactionDetailHref(circle: ObjectRef, transaction: ObjectRef) {
  return `/circles/${circle.ref}/transactions/${transaction.ref}`;
}

/**
 * Canonical edit object-route path — the single home the ledger/search rows and the detail
 * page both build, so the `/edit` suffix can't drift between call sites. Like
 * {@link transactionDetailHref} it carries no origin of its own; the caller appends a
 * validated `returnTo` via `withReturnTo`.
 */
export function transactionEditHref(circle: ObjectRef, transaction: ObjectRef) {
  return `/circles/${circle.ref}/transactions/${transaction.ref}/edit`;
}

/**
 * Canonical read-only Category detail path for a Circle object route (issue #240).
 */
export function categoryDetailHref(circle: ObjectRef, category: ObjectRef) {
  return `/circles/${circle.ref}/categories/${category.ref}`;
}

/**
 * All-time Transaction Search drilldown for one Category (issue #240): type-scoped,
 * lifecycle `all`, no date range — the Category Detail CTA destination.
 */
export function categoryTransactionSearchHref(
  circle: ObjectRef,
  category: { id: string; type: "expense" | "income" },
) {
  const filters = defaultSearchFilters();
  filters.type = category.type;
  filters.status = "all";
  filters.categories = [category.id];
  return withQuery(circlePath(circle.ref, "search"), canonicalSearchParams(filters).toString());
}

/**
 * Canonical new-Transaction route path (issue #96): the dedicated create page's `type`
 * (required) and `month` (the create form's date default) are the route's OWN params, so
 * unlike the detail/edit hrefs this builder carries a query. The caller still appends the
 * validated `returnTo` origin via `withReturnTo`, which MERGES into this query — one home
 * for the create link so the ledger CTA and the `?new=` back-compat redirect can't drift.
 */
export function transactionNewHref(
  circle: ObjectRef,
  { type, month }: { type: "expense" | "income"; month: string },
) {
  const params = new URLSearchParams({ type, month });
  return withQuery(`/circles/${circle.ref}/transactions/new`, params.toString());
}

/**
 * Dashboard drilldown → Monthly Ledger (RPT-6). Translates Dashboard scope into the
 * Ledger's URL codec via `defaultLedgerFilters` + `canonicalLedgerParams` so drilldown
 * URLs cannot diverge from ones the Ledger itself would produce.
 */
export function ledgerDrilldownHref(
  circle: ObjectRef,
  {
    month,
    categoryId,
    type,
  }: {
    month: PlainMonth;
    categoryId?: string;
    type?: TransactionType;
  },
) {
  const filters = defaultLedgerFilters(month);
  if (categoryId) {
    filters.categories = [categoryId];
  }
  if (type) {
    filters.type = type;
  }
  return withQuery(
    circlePath(circle.ref, "transactions"),
    canonicalLedgerParams(filters).toString(),
  );
}
