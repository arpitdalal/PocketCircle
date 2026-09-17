import { api } from "@pocketcircle/convex";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { Route } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationCenter } from "~/components/notification-center.js";
import { type AppChrome, SIDEBAR_CHROME_QUERY } from "~/lib/app-chrome.js";
import type { Notification } from "~/lib/data/notifications.js";
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
import { createMatchMediaFakeController } from "~/test/match-media.js";

vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);

afterEach(() => {
  vi.clearAllMocks();
});

async function openNotifications(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /^Notifications/ }));
}

/** `header` is jsdom's default chrome: `matchMedia` reports the `lg` query unmatched. */
function renderCenter(chrome: AppChrome = "header") {
  return renderRoutes(<Route path="/" element={<NotificationCenter chrome={chrome} />} />, {
    initialEntries: ["/"],
  });
}

describe("NotificationCenter", () => {
  installIntersectionObserverStub();
  const media = createMatchMediaFakeController();

  // The sidebar trigger rides the panel's TOP row beside the brand (issue #351), so its
  // tray must grow downward from there — `align: end` would only fit by collision shift.
  it.each([
    { chrome: "header" as const, side: "bottom", align: "end" },
    { chrome: "sidebar" as const, side: "right", align: "start" },
  ])("anchors the $chrome tray $side/$align", async ({ chrome, side, align }) => {
    configureConvex({ unreadCount: { count: 0, hasMore: false } });
    const user = userEvent.setup();
    renderCenter(chrome);
    await openNotifications(user);

    const positioner = (await screen.findByRole("menu")).closest("[data-side]");
    await waitFor(() => {
      expect(positioner).toHaveAttribute("data-side", side);
      expect(positioner).toHaveAttribute("data-align", align);
    });
  });

  it("renders linked and text-only unread items from mock fixtures", async () => {
    configureConvex({
      notifications: [
        makeNotificationView({
          title: "Set as Paid By",
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

    expect(await screen.findByText("Set as Paid By")).toBeInTheDocument();
    expect(screen.getByText("Removed from Circle")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Set as Paid By/ })).toHaveAttribute(
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

    expect(await screen.findByText("Set as Paid By")).toBeInTheDocument();
    expect(screen.queryByText("Removed from Circle")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unread" })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "All" }));

    expect(screen.getByText("Removed from Circle")).toBeInTheDocument();
    expect(screen.getByText("Set as Paid By")).toBeInTheDocument();
  });

  // A live region nested in the trigger would have no accessible object at all (`button`
  // is "children presentational"), and an `aria-label` of "Notifications" alone keeps the
  // count out of the name — so the count has to reach BOTH channels from outside the button.
  it("announces the unread count from a region outside the trigger and in the trigger's name", () => {
    configureConvex({ unreadCount: { count: 3, hasMore: false } });
    const { container } = renderCenter();

    const trigger = screen.getByRole("button", { name: /^Notifications/ });
    expect(trigger).toHaveAccessibleName("Notifications, 3 unread notifications");

    const live = container.querySelector("[aria-live]");
    expect(live).toHaveTextContent("3 unread notifications");
    expect(live).toHaveAttribute("aria-atomic", "true");
    expect(trigger.contains(live)).toBe(false);
  });

  // The region has to exist BEFORE the first unread arrives: one inserted together with
  // its first text announces nothing.
  it("keeps the live region mounted and empty at zero unread", () => {
    configureConvex({ unreadCount: { count: 0, hasMore: false } });
    const { container } = renderCenter();

    const live = container.querySelector("[aria-live]");
    expect(live).toBeInTheDocument();
    expect(live).toHaveTextContent("");
    expect(screen.getByRole("button", { name: /^Notifications/ })).toHaveAccessibleName(
      "Notifications",
    );
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
    expect(await screen.findByText("Set as Paid By")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByText("Removed from Circle")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Notifications/ }));
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

  it("opens All and shows the focused row after a Push click request", async () => {
    const focusedId = testId<Notification["id"]>("n-focus");
    configureConvex({
      notifications: [
        makeNotificationView({
          id: focusedId,
          title: "Focused push row",
          read: true,
          link: undefined,
        }),
        makeNotificationView({
          id: testId<Notification["id"]>("n-other"),
          title: "Other row",
          read: false,
        }),
      ],
      unreadCount: { count: 1, hasMore: false },
    });
    renderCenter();

    const { requestNotificationCenterFocus } = await import("~/lib/notification-center-focus.js");
    await act(async () => {
      requestNotificationCenterFocus(focusedId);
    });

    expect(await screen.findByText("Focused push row")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
  });

  // Header and sidebar (issue #351) each mount an instance and CSS hides one, but the
  // tray is portaled to `document.body` — a hidden instance auto-opening on a Push
  // request would paint an unanchored second tray.
  describe.each([
    { sidebarChromePainted: false, honors: "header" as const, ignores: "sidebar" as const },
    { sidebarChromePainted: true, honors: "sidebar" as const, ignores: "header" as const },
  ])(
    "Push focus with sidebar chrome painted: $sidebarChromePainted",
    ({ sidebarChromePainted, honors, ignores }) => {
      it(`opens only the ${honors} instance`, async () => {
        media.queries({ [SIDEBAR_CHROME_QUERY]: sidebarChromePainted });
        configureConvex({
          notifications: [makeNotificationView({ title: "Focused push row", read: false })],
          unreadCount: { count: 1, hasMore: false },
        });
        renderCenter(ignores);
        renderCenter(honors);

        const { requestNotificationCenterFocus } = await import(
          "~/lib/notification-center-focus.js"
        );
        await act(async () => {
          requestNotificationCenterFocus(testId<Notification["id"]>("n-focus"));
        });

        // Exactly one tray: the painted chrome's. Both instances are mounted.
        expect(await screen.findByText("Focused push row")).toBeInTheDocument();
        expect(screen.getAllByRole("button", { name: "All" })).toHaveLength(1);
      });
    },
  );

  // Both chromes stay mounted and the tray portals to `document.body`, so a resize across
  // the breakpoint would otherwise leave it open beside a hidden trigger.
  it("closes the sidebar tray when the viewport stops painting the sidebar", async () => {
    configureConvex({
      notifications: [makeNotificationView({ title: "Set as Paid By" })],
      unreadCount: { count: 1, hasMore: false },
    });
    const matchMedia = media.queries({ [SIDEBAR_CHROME_QUERY]: true });
    const user = userEvent.setup();
    renderCenter("sidebar");
    await openNotifications(user);
    expect(await screen.findByRole("menu")).toBeInTheDocument();

    act(() => {
      matchMedia.setQueryMatches(SIDEBAR_CHROME_QUERY, false);
    });

    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });
});
