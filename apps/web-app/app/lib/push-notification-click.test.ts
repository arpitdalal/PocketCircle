import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PUSH_NOTIFICATION_CLICK_MESSAGE_TYPE } from "@pocketcircle/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { track } from "./analytics.js";
import {
  requestNotificationCenterFocus,
  resetNotificationCenterFocus,
  takeNotificationCenterFocusRequest,
} from "./notification-center-focus.js";
import {
  applyPushNotificationClickResult,
  handlePushNotificationClickMessage,
} from "./push-notification-click.js";

vi.mock("./analytics.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./analytics.js")>();
  return {
    ...actual,
    track: vi.fn(),
  };
});

afterEach(() => {
  resetNotificationCenterFocus();
  vi.mocked(track).mockClear();
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
    expect(track).toHaveBeenCalledWith("notification_opened", {});
  });

  it("opens Notification Center focus, marks read, tracks", async () => {
    const navigate = vi.fn();
    const markRead = vi.fn().mockResolvedValue(undefined);
    await applyPushNotificationClickResult(
      { outcome: "notification_center", notificationId: "jd7abc123" },
      navigate,
      markRead,
    );
    expect(takeNotificationCenterFocusRequest()).toMatchObject({
      notificationId: "jd7abc123",
    });
    expect(navigate).toHaveBeenCalledWith("/", { replace: true });
    expect(markRead).toHaveBeenCalledWith("jd7abc123");
    expect(track).toHaveBeenCalledWith("notification_opened", {});
  });

  it("unavailable goes home without mark or analytics", async () => {
    requestNotificationCenterFocus("kept");
    const navigate = vi.fn();
    const markRead = vi.fn();
    await applyPushNotificationClickResult({ outcome: "unavailable" }, navigate, markRead);
    expect(navigate).toHaveBeenCalledWith("/", { replace: true });
    expect(markRead).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
    expect(takeNotificationCenterFocusRequest().notificationId).toBe("kept");
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
    expect(track).not.toHaveBeenCalled();
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
    expect(track).toHaveBeenCalledWith("notification_opened", {});
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
    expect(source).toMatch(/POCKETCIRCLE_PUSH_SW_VERSION = 2/);
    expect(source).not.toMatch(/\bactions\s*:/);
    expect(source).not.toMatch(/parsed\.url|payload\.url|data\.url/);
    // focus rejection must not abort routing
    expect(source).toMatch(/await client\.focus\(\)/);
    expect(source).toMatch(/Continue to navigate/);
  });
});
