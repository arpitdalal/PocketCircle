import { api } from "@pocketcircle/convex";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { MOCKS } from "../env.js";
import { MOCK_NOTIFICATIONS } from "../fixtures.js";

/** How many unread notifications the center shows and clears per batch. */
export const NOTIFICATION_BATCH_SIZE = 20;

/**
 * One notification view row, derived from `listNotifications` so the client
 * contract cannot drift from the backend (ADR 0003).
 */
export type Notification = FunctionReturnType<typeof api.notifications.listNotifications>[number];

export type UnreadCount = FunctionReturnType<typeof api.notifications.getUnreadCount>;

/** Unread notifications for the current batch (newest first, max {@link NOTIFICATION_BATCH_SIZE}). */
export function useNotifications() {
  const live = useQuery(api.notifications.listNotifications, MOCKS ? "skip" : {});
  if (MOCKS) {
    return MOCK_NOTIFICATIONS.filter((n) => !n.read);
  }
  return live;
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
