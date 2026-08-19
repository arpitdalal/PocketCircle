import { api } from "@pocketcircle/convex";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { MOCKS } from "../env.js";
import { MOCK_NOTIFICATIONS } from "../fixtures.js";
import type { PaginationStatus } from "./transactions.js";

/** How many notifications the center loads per page (initial + each infinite-scroll page). */
export const NOTIFICATION_BATCH_SIZE = 20;

/**
 * One notification view row, derived from `listNotifications` so the client
 * contract cannot drift from the backend (ADR 0003).
 */
export type Notification = FunctionReturnType<
  typeof api.notifications.listNotifications
>["page"][number];

export type UnreadCount = FunctionReturnType<typeof api.notifications.getUnreadCount>;

export interface PaginatedNotifications {
  notifications: Notification[];
  status: PaginationStatus;
  /** Loads the next page; a no-op unless `status` is "CanLoadMore". */
  loadMore: () => void;
}

function mockNotifications(unreadOnly: boolean) {
  return unreadOnly ? MOCK_NOTIFICATIONS.filter((n) => !n.read) : MOCK_NOTIFICATIONS;
}

/** Paginated Notification Center list. Skip while the menu is closed (`enabled`). */
export function useNotifications(unreadOnly: boolean, enabled: boolean): PaginatedNotifications {
  const paginated = usePaginatedQuery(
    api.notifications.listNotifications,
    MOCKS || !enabled ? "skip" : { unreadOnly },
    { initialNumItems: NOTIFICATION_BATCH_SIZE },
  );
  if (MOCKS || !enabled) {
    return {
      notifications: MOCKS && enabled ? mockNotifications(unreadOnly) : [],
      status: "Exhausted",
      loadMore: () => {},
    };
  }
  return {
    notifications: paginated.results,
    status: paginated.status,
    loadMore: () => paginated.loadMore(NOTIFICATION_BATCH_SIZE),
  };
}

/** Unread count for the header badge (`99+` when capped). */
export function useUnreadCount(): UnreadCount | undefined {
  const live = useQuery(api.notifications.getUnreadCount, MOCKS ? "skip" : {});
  if (MOCKS) {
    const unread = MOCK_NOTIFICATIONS.filter((n) => !n.read).length;
    return { count: unread, hasMore: false };
  }
  return live;
}

export function useMarkNotificationRead() {
  const mutation = useMutation(api.notifications.markNotificationRead);
  if (MOCKS) {
    return async () => {};
  }
  return mutation;
}

export function useMarkAllRead() {
  const mutation = useMutation(api.notifications.markAllRead);
  if (MOCKS) {
    return async () => {};
  }
  return mutation;
}
