import { api } from "@pocketcircle/convex";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { Route } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationCenter } from "~/components/notification-center.js";
import { MOCK_NOTIFICATIONS } from "~/lib/fixtures.js";
import {
  configureConvex,
  convexReactMock,
  flushIntersectionObserverStub,
  installIntersectionObserverStub,
  makeNotificationView,
  renderRoutes,
  testId,
} from "~/test/convex-react.js";

vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);

afterEach(() => {
  vi.clearAllMocks();
});

async function openNotifications(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Notifications" }));
}

function renderCenter() {
  renderRoutes(<Route path="/" element={<NotificationCenter />} />, { initialEntries: ["/"] });
}

describe("NotificationCenter", () => {
  installIntersectionObserverStub();

  it("renders linked and text-only unread items from mock fixtures", async () => {
    configureConvex({
      notifications: [
        makeNotificationView({
          title: "Paid By updated",
          link: MOCK_NOTIFICATIONS[0]?.link,
        }),
        makeNotificationView({
          title: "Removed from Circle",
          body: "You were removed from Shared Apartment.",
          link: undefined,
        }),
      ],
      unreadCount: { count: 2, hasMore: false },
    });
    const user = userEvent.setup();
    renderCenter();

    await openNotifications(user);

    expect(await screen.findByText("Paid By updated")).toBeInTheDocument();
    expect(screen.getByText("Removed from Circle")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Paid By updated/ })).toHaveAttribute(
      "href",
      MOCK_NOTIFICATIONS[0]?.link,
    );
  });

  it("defaults to Unread and shows the read fixture only on All", async () => {
    configureConvex({
      notifications: [...MOCK_NOTIFICATIONS],
      unreadCount: { count: 1, hasMore: false },
    });
    const user = userEvent.setup();
    renderCenter();

    await openNotifications(user);

    expect(await screen.findByText("Paid By updated")).toBeInTheDocument();
    expect(screen.queryByText("Removed from Circle")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unread" })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "All" }));

    expect(screen.getByText("Removed from Circle")).toBeInTheDocument();
    expect(screen.getByText("Paid By updated")).toBeInTheDocument();
  });

  it("names unread rows in All so the unread dot is not the only cue", async () => {
    configureConvex({
      notifications: [
        makeNotificationView({ title: "Still pending", read: false }),
        makeNotificationView({
          id: testId("n2"),
          title: "Already seen",
          read: true,
        }),
      ],
      unreadCount: { count: 1, hasMore: false },
    });
    const user = userEvent.setup();
    renderCenter();

    await openNotifications(user);
    await user.click(await screen.findByRole("button", { name: "All" }));

    expect(screen.getByRole("menuitem", { name: /Still pending/ })).toHaveAccessibleName(/unread/i);
    expect(screen.getByRole("menuitem", { name: /Already seen/ })).not.toHaveAccessibleName(
      /unread/i,
    );
    expect(
      screen.getByRole("menuitem", { name: /Still pending/ }).querySelector(".bg-primary"),
    ).not.toBeNull();
    expect(
      screen.getByRole("menuitem", { name: /Already seen/ }).querySelector(".bg-primary"),
    ).toBeNull();
  });

  it("keeps All selected after the menu is closed and reopened", async () => {
    configureConvex({
      notifications: [...MOCK_NOTIFICATIONS],
      unreadCount: { count: 1, hasMore: false },
    });
    const user = userEvent.setup();
    renderCenter();

    await openNotifications(user);
    expect(await screen.findByText("Paid By updated")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByText("Removed from Circle")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Notifications" }));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "All" })).not.toBeInTheDocument();
    });
    await openNotifications(user);

    expect(await screen.findByText("Removed from Circle")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
  });

  it("marks an unread item read when clicked", async () => {
    const markNotificationRead = vi.fn().mockResolvedValue(undefined);
    configureConvex({
      notifications: [makeNotificationView({ title: "Unread ping", read: false })],
      unreadCount: { count: 1, hasMore: false },
      markNotificationRead,
    });
    const user = userEvent.setup();
    renderCenter();

    await openNotifications(user);
    await user.click(await screen.findByRole("menuitem", { name: /Unread ping/ }));

    expect(markNotificationRead).toHaveBeenCalledWith({
      notificationId: expect.any(String),
    });
  });

  it("mark all read clears the badge via mutation", async () => {
    const markAllRead = vi.fn().mockResolvedValue(undefined);
    configureConvex({
      notifications: [makeNotificationView()],
      unreadCount: { count: 2, hasMore: false },
      markAllRead,
    });
    const user = userEvent.setup();
    renderCenter();

    await openNotifications(user);
    await user.click(await screen.findByRole("button", { name: "Mark all read" }));

    expect(markAllRead).toHaveBeenCalledWith({});
  });

  it("hides Mark all read when there is no unread work, including All with only read rows", async () => {
    configureConvex({
      notifications: [makeNotificationView({ title: "Old news", read: true })],
      unreadCount: { count: 0, hasMore: false },
    });
    const user = userEvent.setup();
    renderCenter();

    await openNotifications(user);
    await user.click(await screen.findByRole("button", { name: "All" }));

    expect(screen.getByText("Old news")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark all read" })).not.toBeInTheDocument();
  });

  it("shows caught-up copy on Unread and no-notifications copy on All", async () => {
    configureConvex({
      notifications: [],
      unreadCount: { count: 0, hasMore: false },
    });
    const user = userEvent.setup();
    renderCenter();

    await openNotifications(user);

    expect(await screen.findByText("You're all caught up")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "All" }));

    expect(screen.getByText("No notifications")).toBeInTheDocument();
    expect(screen.queryByText("You're all caught up")).not.toBeInTheDocument();
  });

  it("does not flash empty copy while the first page is loading", async () => {
    configureConvex({
      notifications: [],
      notificationsStatus: "LoadingFirstPage",
      unreadCount: { count: 0, hasMore: false },
    });
    const user = userEvent.setup();
    renderCenter();

    await openNotifications(user);

    expect(screen.queryByText("You're all caught up")).not.toBeInTheDocument();
    expect(screen.queryByText("No notifications")).not.toBeInTheDocument();
  });

  it("loads more when the tray sentinel intersects", async () => {
    const notificationsLoadMore = vi.fn();
    configureConvex({
      notifications: [makeNotificationView()],
      notificationsStatus: "CanLoadMore",
      notificationsLoadMore,
      unreadCount: { count: 1, hasMore: false },
    });
    const user = userEvent.setup();
    renderCenter();

    await openNotifications(user);
    expect(await screen.findByTestId("notifications-infinite-scroll-sentinel")).toBeInTheDocument();

    flushIntersectionObserverStub(true);
    expect(notificationsLoadMore).toHaveBeenCalled();
  });

  it("skips the list query while the menu is closed", () => {
    configureConvex({
      notifications: [makeNotificationView()],
      unreadCount: { count: 1, hasMore: false },
    });
    renderCenter();

    expect(screen.queryByText("Test notification")).not.toBeInTheDocument();
    const listName = getFunctionName(api.notifications.listNotifications);
    const listCalls = convexReactMock.usePaginatedQuery.mock.calls.filter(
      (call) => getFunctionName(call[0]) === listName,
    );
    expect(listCalls.length).toBeGreaterThan(0);
    expect(listCalls.every((call) => call[1] === "skip")).toBe(true);
  });

  it("shows 99+ when unread count is capped", () => {
    configureConvex({
      notifications: [],
      unreadCount: { count: 99, hasMore: true },
    });
    renderCenter();

    expect(screen.getByText("99+")).toBeInTheDocument();
    expect(screen.getByText("99+ unread notifications")).toBeInTheDocument();
  });
});
