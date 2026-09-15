import { screen, waitFor } from "@testing-library/react";
import { Route } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetNotificationCenterFocus } from "~/lib/notification-center-focus.js";
import { testId } from "~/test/convex/ids.js";
import {
  configureConvex,
  convexReactMock,
  makeCurrentUserView,
  renderRoutes,
} from "~/test/convex-react.js";
import { deferred } from "~/test/router-stub.js";
import FromNotification from "./from-notification.js";

vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);

const resolvePushNotificationClick = vi.fn();
const markNotificationRead = vi.fn();
const notificationId = testId("jd7abc123");

beforeEach(() => {
  resolvePushNotificationClick.mockReset();
  markNotificationRead.mockReset().mockResolvedValue(undefined);
  resetNotificationCenterFocus();
  convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });
  configureConvex({
    currentUser: makeCurrentUserView({ onboardingComplete: true }),
    resolvePushNotificationClick,
    markNotificationRead,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

function renderFromNotification(entry: string) {
  return renderRoutes(
    <>
      <Route path="/from-notification" element={<FromNotification />} />
      <Route path="/" element={<div>home</div>} />
      <Route path="/circles/:circleRef" element={<div>circle</div>} />
    </>,
    { initialEntries: [entry] },
  );
}

describe("FromNotification", () => {
  it("resolves, navigates, then marks read", async () => {
    resolvePushNotificationClick.mockResolvedValue({
      outcome: "navigate",
      path: "/circles/trip-c1",
      notificationId,
    });

    const view = renderFromNotification(`/from-notification?n=${notificationId}`);

    await waitFor(() => {
      expect(resolvePushNotificationClick).toHaveBeenCalledWith({
        notificationId,
      });
    });
    await waitFor(() => {
      expect(view.location()).toBe("/circles/trip-c1");
    });
    await waitFor(() => {
      expect(markNotificationRead).toHaveBeenCalledWith({ notificationId });
    });
    expect(screen.getByText("circle")).toBeInTheDocument();
  });

  it("opens home for Notification Center fallback and marks read", async () => {
    resolvePushNotificationClick.mockResolvedValue({
      outcome: "notification_center",
      notificationId,
    });

    const view = renderFromNotification(`/from-notification?n=${notificationId}`);

    await waitFor(() => {
      expect(view.location()).toBe("/");
    });
    await waitFor(() => {
      expect(markNotificationRead).toHaveBeenCalledWith({ notificationId });
    });
    expect(screen.getByText("home")).toBeInTheDocument();
  });

  it("redirects home when identity is missing", () => {
    const view = renderFromNotification("/from-notification");
    expect(view.location()).toBe("/");
    expect(resolvePushNotificationClick).not.toHaveBeenCalled();
    expect(markNotificationRead).not.toHaveBeenCalled();
  });

  it("goes home on resolve failure without marking read", async () => {
    resolvePushNotificationClick.mockRejectedValue(new Error("network"));

    const view = renderFromNotification(`/from-notification?n=${notificationId}`);

    await waitFor(() => {
      expect(view.location()).toBe("/");
    });
    expect(markNotificationRead).not.toHaveBeenCalled();
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument();
  });

  it("marks read after navigate even when the landing route unmounts", async () => {
    const markInvoked = deferred();
    markNotificationRead.mockImplementation(() => {
      markInvoked.resolve();
      return new Promise(() => {
        // Leave in-flight — proves invoke happened after navigate unmount/abort.
      });
    });
    resolvePushNotificationClick.mockResolvedValue({
      outcome: "navigate",
      path: "/circles/trip-c1",
      notificationId,
    });

    const view = renderFromNotification(`/from-notification?n=${notificationId}`);

    await waitFor(() => {
      expect(view.location()).toBe("/circles/trip-c1");
    });
    await markInvoked.promise;
    expect(markNotificationRead).toHaveBeenCalledWith({ notificationId });
  });
});
