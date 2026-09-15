import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PUSH_NOTIFICATION_CLICK_MESSAGE_TYPE } from "@pocketcircle/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  holdPostHogLoad,
  posthogSdk,
  primeAnalyticsForTests,
  resetPostHogBoundary,
  stubPosthogEnvForTests,
} from "~/test/posthog-boundary.js";
import { initAnalytics } from "./analytics.js";
import {
  peekNotificationCenterFocusId,
  requestNotificationCenterFocus,
  resetNotificationCenterFocus,
} from "./notification-center-focus.js";
import {
  applyPushNotificationClickResult,
  flushPendingNotificationOpenedTrack,
  handlePushNotificationClickMessage,
  resetPushNotificationClickAnalyticsForTests,
  trackNotificationOpened,
} from "./push-notification-click.js";

vi.mock("posthog-js", async () => (await import("~/test/posthog-mock.js")).posthogModuleMock);

beforeEach(async () => {
  stubPosthogEnvForTests();
  await primeAnalyticsForTests();
  resetNotificationCenterFocus();
  resetPushNotificationClickAnalyticsForTests();
  posthogSdk.capture.mockClear();
});

afterEach(() => {
  resetPostHogBoundary();
  resetNotificationCenterFocus();
  resetPushNotificationClickAnalyticsForTests();
});

describe("applyPushNotificationClickResult", () => {
  it("navigates, marks read, then tracks notification_opened", async () => {
    const navigate = vi.fn();
    const markRead = vi.fn().mockResolvedValue(undefined);
    await applyPushNotificationClickResult(
      { outcome: "navigate", path: "/circles/trip-c1", notificationId: "jd7abc123" },
      navigate,
      markRead,
    );
    expect(navigate).toHaveBeenCalledWith("/circles/trip-c1", { replace: true });
    expect(markRead).toHaveBeenCalledWith("jd7abc123");
    expect(posthogSdk.capture).toHaveBeenCalledWith("notification_opened", {});
  });

  it("opens Notification Center focus, marks read, tracks", async () => {
    const navigate = vi.fn();
    const markRead = vi.fn().mockResolvedValue(undefined);
    await applyPushNotificationClickResult(
      { outcome: "notification_center", notificationId: "jd7abc123" },
      navigate,
      markRead,
    );
    expect(peekNotificationCenterFocusId()).toBe("jd7abc123");
    expect(navigate).toHaveBeenCalledWith("/", { replace: true });
    expect(markRead).toHaveBeenCalledWith("jd7abc123");
    expect(posthogSdk.capture).toHaveBeenCalledWith("notification_opened", {});
  });

  it("unavailable goes home without mark or analytics", async () => {
    requestNotificationCenterFocus("kept");
    const navigate = vi.fn();
    const markRead = vi.fn();
    await applyPushNotificationClickResult({ outcome: "unavailable" }, navigate, markRead);
    expect(navigate).toHaveBeenCalledWith("/", { replace: true });
    expect(markRead).not.toHaveBeenCalled();
    expect(posthogSdk.capture).not.toHaveBeenCalled();
    expect(peekNotificationCenterFocusId()).toBe("kept");
  });

  it("refuses non-canonical navigate paths without marking", async () => {
    const navigate = vi.fn();
    const markRead = vi.fn();
    await applyPushNotificationClickResult(
      { outcome: "navigate", path: "/settings", notificationId: "jd7abc123" },
      navigate,
      markRead,
    );
    expect(navigate).toHaveBeenCalledWith("/", { replace: true });
    expect(markRead).not.toHaveBeenCalled();
    expect(posthogSdk.capture).not.toHaveBeenCalled();
  });

  it("still tracks after markRead failure once destination applied", async () => {
    const navigate = vi.fn();
    const markRead = vi.fn().mockRejectedValue(new Error("network"));
    await applyPushNotificationClickResult(
      { outcome: "navigate", path: "/circles/trip-c1", notificationId: "jd7abc123" },
      navigate,
      markRead,
    );
    expect(navigate).toHaveBeenCalledWith("/circles/trip-c1", { replace: true });
    expect(posthogSdk.capture).toHaveBeenCalledWith("notification_opened", {});
  });

  it("respects analytics opt-out for notification_opened", async () => {
    resetPostHogBoundary();
    stubPosthogEnvForTests();
    await initAnalytics({ id: "opted-out", analyticsEnabled: false });
    posthogSdk.capture.mockClear();

    await applyPushNotificationClickResult(
      { outcome: "navigate", path: "/circles/trip-c1", notificationId: "jd7abc123" },
      vi.fn(),
      vi.fn().mockResolvedValue(undefined),
    );
    expect(posthogSdk.capture).not.toHaveBeenCalled();
  });

  it("queues notification_opened while capture is deferred and flushes when ready", async () => {
    resetPostHogBoundary();
    resetPushNotificationClickAnalyticsForTests();
    stubPosthogEnvForTests();
    const releaseHold = holdPostHogLoad();
    const pending = initAnalytics({ id: "cold", analyticsEnabled: true });
    expect(trackNotificationOpened()).toBe(false);
    expect(posthogSdk.capture).not.toHaveBeenCalled();
    releaseHold();
    await pending;
    flushPendingNotificationOpenedTrack();
    expect(posthogSdk.capture).toHaveBeenCalledWith("notification_opened", {});
  });
});

describe("handlePushNotificationClickMessage", () => {
  it("routes identity-only messages into the deep link", () => {
    const navigate = vi.fn();
    expect(
      handlePushNotificationClickMessage(
        {
          type: PUSH_NOTIFICATION_CLICK_MESSAGE_TYPE,
          notificationId: "jd7abc123",
        },
        navigate,
      ),
    ).toBe(true);
    expect(navigate).toHaveBeenCalledWith("/from-notification?n=jd7abc123", { replace: true });
  });

  it("ignores unrelated messages", () => {
    const navigate = vi.fn();
    expect(handlePushNotificationClickMessage({ type: "other" }, navigate)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("push-sw.js notificationclick contract", () => {
  it("closes OS notifications, carries identity only, and omits action buttons", () => {
    const source = readFileSync(join(import.meta.dirname, "../../public/push-sw.js"), "utf8");
    expect(source).toMatch(/notificationclick/);
    expect(source).toMatch(/event\.notification\.close/);
    expect(source).toMatch(/notificationId/);
    expect(source).toMatch(/from-notification\?n=/);
    expect(source).toMatch(/POCKETCIRCLE_PUSH_SW_VERSION = 3/);
    expect(source).not.toMatch(/\bactions\s*:/);
    expect(source).not.toMatch(/parsed\.url|payload\.url|data\.url/);
    // focus rejection must not abort routing
    expect(source).toMatch(/await client\.focus\(\)/);
    expect(source).toMatch(/Continue to navigate/);
    // openWindow before postMessage (durable URL handoff)
    const openWindowAt = source.indexOf("clients.openWindow(targetUrl)");
    const postMessageAt = source.lastIndexOf("client.postMessage({");
    expect(openWindowAt).toBeGreaterThan(-1);
    expect(postMessageAt).toBeGreaterThan(openWindowAt);
  });
});
