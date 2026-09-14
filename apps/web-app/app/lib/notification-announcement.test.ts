import { afterEach, describe, expect, it } from "vitest";
import {
  hasRecordedNotificationAnnouncementImpression,
  isNotificationAnnouncementVisible,
  markNotificationAnnouncementImpressionRecorded,
  NOTIFICATION_ANNOUNCEMENT_DISMISSED_KEY,
  readNotificationAnnouncementDismissed,
  writeNotificationAnnouncementDismissed,
} from "~/lib/notification-announcement.js";

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("notification announcement dismiss storage", () => {
  it("defaults to not dismissed and persists per device", () => {
    expect(readNotificationAnnouncementDismissed()).toBe(false);
    writeNotificationAnnouncementDismissed();
    expect(readNotificationAnnouncementDismissed()).toBe(true);
    expect(window.localStorage.getItem(NOTIFICATION_ANNOUNCEMENT_DISMISSED_KEY)).toBe("1");
  });

  it("records one impression flag per tab session", () => {
    expect(hasRecordedNotificationAnnouncementImpression()).toBe(false);
    markNotificationAnnouncementImpressionRecorded();
    expect(hasRecordedNotificationAnnouncementImpression()).toBe(true);
  });
});

describe("isNotificationAnnouncementVisible", () => {
  const base = {
    dismissed: false,
    uiState: "default" as const,
    vapidUsable: true,
    iosInstallPrerequisiteDismissed: false,
  };

  it("shows only when enableable (default + usable VAPID)", () => {
    expect(isNotificationAnnouncementVisible(base)).toBe(true);
  });

  it("hides when dismissed, probing, or VAPID unusable", () => {
    expect(isNotificationAnnouncementVisible({ ...base, dismissed: true })).toBe(false);
    expect(isNotificationAnnouncementVisible({ ...base, uiState: null })).toBe(false);
    expect(isNotificationAnnouncementVisible({ ...base, vapidUsable: false })).toBe(false);
  });

  it("hides for non-enableable Push states", () => {
    for (const uiState of [
      "unsupported",
      "needs_install",
      "blocked",
      "enabled",
      "needs_migration",
      "needs_remigrate_finish",
    ] as const) {
      expect(isNotificationAnnouncementVisible({ ...base, uiState }), uiState).toBe(false);
    }
  });

  it("hides on iOS browser-tab after install-prompt dismiss", () => {
    expect(
      isNotificationAnnouncementVisible({
        ...base,
        uiState: "needs_install",
        iosInstallPrerequisiteDismissed: true,
      }),
    ).toBe(false);
    // Even if state were wrongly reported as default, install-dismiss still suppresses.
    expect(
      isNotificationAnnouncementVisible({
        ...base,
        iosInstallPrerequisiteDismissed: true,
      }),
    ).toBe(false);
  });
});
