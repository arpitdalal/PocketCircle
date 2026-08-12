import { api } from "@pocketcircle/convex";
import { getFunctionName } from "convex/server";
import type { Mock } from "vitest";
import type { Notification, UnreadCount } from "~/lib/data.js";
import type { EntityDouble } from "./contract.js";
import { testId } from "./ids.js";

export interface NotificationsState {
  notifications?: Notification[];
  unreadCount?: UnreadCount;
  markNotificationRead?: Mock;
  markAllRead?: Mock;
}

export function notificationsDouble(state: NotificationsState): EntityDouble {
  const {
    notifications = [],
    unreadCount = { count: 0, hasMore: false },
    markNotificationRead,
    markAllRead,
  } = state;
  return {
    queries: {
      [getFunctionName(api.notifications.getUnreadCount)]: () => unreadCount,
      [getFunctionName(api.notifications.listNotifications)]: () => notifications,
    },
    mutations: {
      [getFunctionName(api.notifications.markNotificationRead)]: markNotificationRead,
      [getFunctionName(api.notifications.markAllRead)]: markAllRead,
    },
  };
}

/** One notification view row for component tests. */
export function makeNotificationView(over: Partial<Notification> = {}): Notification {
  return {
    id: testId<Notification["id"]>("n1"),
    type: "test",
    title: "Test notification",
    body: "Details here",
    link: "/circles/trip-c1/transactions/weekly-t1",
    read: false,
    createdAt: Date.UTC(2026, 5, 18, 10, 0),
    ...over,
  };
}
