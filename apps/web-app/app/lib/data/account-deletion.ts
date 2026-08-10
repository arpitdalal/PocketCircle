import { api } from "@spend-circle/convex";
import { usePaginatedQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { MOCKS } from "../env.js";
import type { PaginationStatus } from "./transactions.js";

/** Page size for Settings > Danger zone blocker list (USR-3). */
export const ACCOUNT_DELETION_BLOCKERS_PAGE_SIZE = 20;

/**
 * One Account Deletion blocker, derived from `listAccountDeletionBlockers` so it
 * cannot drift from the backend readiness read model (ADR 0003).
 */
export type AccountDeletionBlocker = FunctionReturnType<
  typeof api.accountDeletion.listAccountDeletionBlockers
>["page"][number];

export interface PaginatedAccountDeletionBlockers {
  blockers: AccountDeletionBlocker[];
  status: PaginationStatus;
  /** Loads the next page; a no-op unless `status` is "CanLoadMore". */
  loadMore: () => void;
}

/**
 * Owned Circles that block Account Deletion, paginated at the source so Settings
 * never truncates an unbounded ownership set (USR-3). Mock mode returns empty
 * Exhausted so offline/E2E fixtures can still render Settings (ADR 0006).
 */
export function useAccountDeletionBlockers(): PaginatedAccountDeletionBlockers {
  const paginated = usePaginatedQuery(
    api.accountDeletion.listAccountDeletionBlockers,
    MOCKS ? "skip" : {},
    { initialNumItems: ACCOUNT_DELETION_BLOCKERS_PAGE_SIZE },
  );
  if (MOCKS) {
    return { blockers: [], status: "Exhausted", loadMore: () => {} };
  }
  return {
    blockers: paginated.results,
    status: paginated.status,
    loadMore: () => paginated.loadMore(ACCOUNT_DELETION_BLOCKERS_PAGE_SIZE),
  };
}
