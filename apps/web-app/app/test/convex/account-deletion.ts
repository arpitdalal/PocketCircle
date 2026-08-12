import { api } from "@pocketcircle/convex";
import { getFunctionName } from "convex/server";
import type { AccountDeletionBlocker, PaginationStatus } from "~/lib/data.js";
import type { EntityDouble, PaginatedPage } from "./contract.js";
import { testId } from "./ids.js";

export interface AccountDeletionState {
  /** Paginated Account Deletion blockers; unset ⇒ empty Exhausted. */
  accountDeletionBlockers?: AccountDeletionBlocker[];
  accountDeletionBlockersStatus?: PaginationStatus;
  accountDeletionBlockersLoadMore?: (n?: number) => void;
}

export function accountDeletionDouble(state: AccountDeletionState): EntityDouble {
  const {
    accountDeletionBlockers = [],
    accountDeletionBlockersStatus = "Exhausted",
    accountDeletionBlockersLoadMore = () => {},
  } = state;

  const page = (): PaginatedPage => ({
    results: accountDeletionBlockers,
    status: accountDeletionBlockersStatus,
    loadMore: accountDeletionBlockersLoadMore,
  });

  return {
    paginatedQueries: {
      [getFunctionName(api.accountDeletion.listAccountDeletionBlockers)]: page,
    },
  };
}

export function makeAccountDeletionBlocker(
  over: Partial<AccountDeletionBlocker> = {},
): AccountDeletionBlocker {
  return {
    circleId: testId<AccountDeletionBlocker["circleId"]>("circle-blocker"),
    ref: "shared-apartment-circleblocker",
    name: "Shared Apartment",
    action: "archive",
    ...over,
  };
}
