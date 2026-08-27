import type { NavigateOptions } from "react-router";

/**
 * Options for same-view URL filter / selection updates.
 *
 * React Router's `<ScrollRestoration>` scrolls to top on every location change
 * unless `preventScrollReset` is set (issue #311). Use for in-place query
 * rewrites (chart range, ledger filters, search submit, etc.). Omit for
 * intentional view jumps — e.g. search pagination, where resetting to the top
 * of the new page is correct.
 */
export function keepScrollSearchParamsOptions(options: { replace: boolean }) {
  return {
    replace: options.replace,
    preventScrollReset: true,
  } satisfies NavigateOptions;
}
