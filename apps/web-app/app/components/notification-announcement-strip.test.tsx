import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route } from "react-router";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { FeatureAnnouncementCard } from "~/components/feature-announcement-card.js";
import { NotificationAnnouncementStrip } from "~/components/notification-announcement-strip.js";
import {
  NOTIFICATION_ANNOUNCEMENT_DISMISSED_KEY,
  resetNotificationAnnouncementMemory,
} from "~/lib/notification-announcement.js";
import { clearRememberedPushEndpoints, resetPushOperationState } from "~/lib/push-subscriptions.js";
import {
  configureConvex,
  convexReactMock,
  makeCurrentUserView,
  renderRoutes,
} from "~/test/convex-react.js";
import {
  posthogSdk,
  primeAnalyticsForTests,
  resetPostHogBoundary,
} from "~/test/posthog-boundary.js";
import { installPushEnv, makeFakePushSubscription, resetPushEnv } from "~/test/push-env.js";
import {
  clearPwaInstallPromptDismissal,
  dispatchBeforeInstallPrompt,
  installMatchMediaFake,
  resetNavigatorInstallProps,
  seedPwaInstallPromptDismissed,
  setNavigatorInstallProps,
} from "~/test/pwa-install-env.js";

vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);
vi.mock("posthog-js", async () => (await import("~/test/posthog-mock.js")).posthogModuleMock);

const VAPID = { publicKey: "BPtestPublicKey", keyId: "primary" };
const STRIP_TITLE = /Enable notifications on this device/i;
const FEATURE_ANNOUNCEMENT_TITLE = /Connect PocketCircle to your AI assistant/i;

beforeEach(async () => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetNotificationAnnouncementMemory();
  clearPwaInstallPromptDismissal();
  resetNavigatorInstallProps();
  installMatchMediaFake(false);
  resetPushEnv();
  clearRememberedPushEndpoints();
  resetPushOperationState();
  await primeAnalyticsForTests(makeCurrentUserView({ createdAt: 1, analyticsEnabled: true }));
  posthogSdk.capture.mockClear();
  convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });
});

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetNotificationAnnouncementMemory();
  clearPwaInstallPromptDismissal();
  resetNavigatorInstallProps();
  resetPushEnv();
  clearRememberedPushEndpoints();
  resetPushOperationState();
  resetPostHogBoundary();
});

function renderStrip(
  opts: {
    enablePushSubscription?: Mock;
    pushVapidPublicKey?: typeof VAPID | null;
    withFeatureAnnouncement?: boolean;
  } = {},
) {
  configureConvex({
    currentUser: makeCurrentUserView({
      createdAt: 1,
      // Keep Feature Announcement eligible when coexistence is under test.
      acknowledgedFeatureAnnouncementIds: opts.withFeatureAnnouncement
        ? []
        : ["mcp-connections", "duplicate-transaction"],
    }),
    pushVapidPublicKey: opts.pushVapidPublicKey === undefined ? VAPID : opts.pushVapidPublicKey,
    enablePushSubscription: opts.enablePushSubscription,
    acknowledgeFeatureAnnouncement: vi.fn().mockResolvedValue(undefined),
  });
  return renderRoutes(
    <Route
      path="*"
      element={
        <>
          <NotificationAnnouncementStrip />
          {opts.withFeatureAnnouncement ? <FeatureAnnouncementCard /> : null}
        </>
      }
    />,
    { initialEntries: ["/"] },
  );
}

async function expectStripAbsentAfterProbe() {
  await waitFor(() => {
    expect(screen.getByTestId("notification-announcement-probe")).toBeInTheDocument();
  });
  expect(screen.queryByTestId("notification-announcement-strip")).not.toBeInTheDocument();
}

describe("NotificationAnnouncementStrip", () => {
  it("shows above enableable Push and does not request permission on load", async () => {
    const requestPermission = vi.fn().mockResolvedValue("granted");
    installPushEnv({ permission: "default", requestPermission, subscription: null });
    renderStrip();
    expect(await screen.findByRole("region", { name: STRIP_TITLE })).toBeVisible();
    expect(screen.getByRole("button", { name: "Enable notifications" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("hides when dismissed, blocked, enabled, unsupported, or VAPID missing", async () => {
    installPushEnv({ permission: "default", subscription: null });
    window.localStorage.setItem(NOTIFICATION_ANNOUNCEMENT_DISMISSED_KEY, "1");
    const dismissed = renderStrip();
    await expectStripAbsentAfterProbe();
    dismissed.unmount();
    window.localStorage.clear();
    resetNotificationAnnouncementMemory();

    installPushEnv({ permission: "denied", subscription: null });
    const blocked = renderStrip();
    await expectStripAbsentAfterProbe();
    blocked.unmount();

    installPushEnv({ permission: "granted", subscription: makeFakePushSubscription() });
    const enabled = renderStrip();
    await expectStripAbsentAfterProbe();
    // Opted-in state permanently dismisses so a later disable does not re-announce.
    expect(window.localStorage.getItem(NOTIFICATION_ANNOUNCEMENT_DISMISSED_KEY)).toBe("1");
    enabled.unmount();
    window.localStorage.clear();
    resetNotificationAnnouncementMemory();

    installPushEnv({
      permission: "default",
      serviceWorker: false,
      pushManager: false,
      notification: false,
      subscription: null,
    });
    const unsupported = renderStrip();
    await expectStripAbsentAfterProbe();
    unsupported.unmount();

    installPushEnv({ permission: "default", subscription: null });
    renderStrip({ pushVapidPublicKey: null });
    await expectStripAbsentAfterProbe();
  });

  it("does not re-announce after an opted-in device disables Push", async () => {
    installPushEnv({ permission: "granted", subscription: makeFakePushSubscription() });
    const first = renderStrip();
    await expectStripAbsentAfterProbe();
    expect(window.localStorage.getItem(NOTIFICATION_ANNOUNCEMENT_DISMISSED_KEY)).toBe("1");
    first.unmount();

    installPushEnv({ permission: "default", subscription: null });
    renderStrip();
    await expectStripAbsentAfterProbe();
  });

  it("hides on iPhone browser-tab after install-prompt dismiss; Chromium dismiss does not", async () => {
    setNavigatorInstallProps({
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
      platform: "iPhone",
      maxTouchPoints: 5,
      standalone: undefined,
    });
    installMatchMediaFake(false);
    seedPwaInstallPromptDismissed();
    installPushEnv({ permission: "default", subscription: null });
    const ios = renderStrip();
    await expectStripAbsentAfterProbe();
    ios.unmount();
    clearPwaInstallPromptDismissal();
    resetNavigatorInstallProps();

    installMatchMediaFake(false);
    seedPwaInstallPromptDismissed();
    installPushEnv({ permission: "default", subscription: null });
    renderStrip();
    // Chromium soft-install dismissed — Push still works without install.
    expect(await screen.findByRole("region", { name: STRIP_TITLE })).toBeVisible();
  });

  it("shows on installed iPhone even when the Safari-tab install prompt was dismissed", async () => {
    setNavigatorInstallProps({
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
      platform: "iPhone",
      maxTouchPoints: 5,
      standalone: true,
    });
    installMatchMediaFake(true);
    seedPwaInstallPromptDismissed();
    installPushEnv({ permission: "default", subscription: null });
    renderStrip();
    expect(await screen.findByRole("region", { name: STRIP_TITLE })).toBeVisible();
  });

  it("dismisses per device and keeps Settings as the enable path", async () => {
    installPushEnv({ permission: "default", subscription: null });
    const user = userEvent.setup();
    renderStrip();
    const region = await screen.findByRole("region", { name: STRIP_TITLE });
    await user.click(within(region).getByRole("button", { name: /Dismiss notification/i }));
    await waitFor(() => {
      expect(screen.queryByTestId("notification-announcement-strip")).not.toBeInTheDocument();
    });
    expect(window.localStorage.getItem(NOTIFICATION_ANNOUNCEMENT_DISMISSED_KEY)).toBe("1");
    expect(posthogSdk.capture).toHaveBeenCalledWith("notification_announcement_dismissed", {});
  });

  it("Enable is the only strip path that may request permission and then dismisses", async () => {
    const requestPermission = vi.fn().mockResolvedValue("granted");
    const enablePushSubscription = vi.fn().mockResolvedValue(undefined);
    installPushEnv({ permission: "default", requestPermission, subscription: null });
    const user = userEvent.setup();
    renderStrip({ enablePushSubscription });

    await screen.findByRole("region", { name: STRIP_TITLE });
    expect(requestPermission).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Enable notifications" }));
    await waitFor(() => {
      expect(requestPermission).toHaveBeenCalledTimes(1);
      expect(enablePushSubscription).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.queryByTestId("notification-announcement-strip")).not.toBeInTheDocument();
    });
    expect(window.localStorage.getItem(NOTIFICATION_ANNOUNCEMENT_DISMISSED_KEY)).toBe("1");
    expect(await screen.findByText("Notifications enabled on this device.")).toBeVisible();
  });

  it("dismisses permanently when the native prompt stays undecided", async () => {
    const requestPermission = vi.fn().mockResolvedValue("default");
    installPushEnv({ permission: "default", requestPermission, subscription: null });
    const user = userEvent.setup();
    renderStrip();

    await user.click(await screen.findByRole("button", { name: "Enable notifications" }));
    await waitFor(() => {
      expect(requestPermission).toHaveBeenCalled();
      expect(screen.queryByTestId("notification-announcement-strip")).not.toBeInTheDocument();
    });
    expect(window.localStorage.getItem(NOTIFICATION_ANNOUNCEMENT_DISMISSED_KEY)).toBe("1");
  });

  it("coexists with Feature Announcement and delays impression while install covers", async () => {
    installPushEnv({ permission: "default", subscription: null });
    setNavigatorInstallProps();
    const user = userEvent.setup();
    renderStrip({ withFeatureAnnouncement: true });
    dispatchBeforeInstallPrompt();

    const dialog = await screen.findByRole("dialog", { name: /Install PocketCircle/i });
    expect(screen.getByTestId("notification-announcement-strip")).toBeInTheDocument();
    // The announcement card withholds its entrance entirely while covered (#334).
    expect(
      screen.queryByRole("heading", {
        name: FEATURE_ANNOUNCEMENT_TITLE,
        hidden: true,
      }),
    ).toBeNull();
    expect(posthogSdk.capture).not.toHaveBeenCalledWith(
      "notification_announcement_impression",
      expect.anything(),
    );

    await user.click(within(dialog).getByRole("button", { name: "Not now" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(posthogSdk.capture).toHaveBeenCalledWith("notification_announcement_impression", {});
    });
    // Both surfaces coexist once the install surface is out of the way.
    expect(
      await screen.findByRole("region", { name: FEATURE_ANNOUNCEMENT_TITLE }, { timeout: 3000 }),
    ).toBeVisible();
    expect(screen.getByRole("region", { name: STRIP_TITLE })).toBeVisible();
  });
});
