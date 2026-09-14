import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasRecordedNotificationAnnouncementImpression,
  isIosInstallPrerequisiteDismissed,
  isNotificationAnnouncementVisible,
  markNotificationAnnouncementImpressionRecorded,
  NOTIFICATION_ANNOUNCEMENT_DISMISSED_KEY,
  readNotificationAnnouncementDismissed,
  resetNotificationAnnouncementMemory,
  shouldSuppressNotificationAnnouncementForUiState,
  subscribeNotificationAnnouncementDismissed,
  writeNotificationAnnouncementDismissed,
} from "~/lib/notification-announcement.js";

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetNotificationAnnouncementMemory();
});

describe("notification announcement dismiss storage", () => {
  it("defaults to not dismissed and persists per device", () => {
    expect(readNotificationAnnouncementDismissed()).toBe(false);
    writeNotificationAnnouncementDismissed();
    expect(readNotificationAnnouncementDismissed()).toBe(true);
    expect(window.localStorage.getItem(NOTIFICATION_ANNOUNCEMENT_DISMISSED_KEY)).toBe("1");
  });

  it("keeps dismiss in memory when localStorage throws", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    writeNotificationAnnouncementDismissed();
    expect(readNotificationAnnouncementDismissed()).toBe(true);
    setItem.mockRestore();
    getItem.mockRestore();
  });

  it("records one impression flag per tab session", () => {
    expect(hasRecordedNotificationAnnouncementImpression()).toBe(false);
    markNotificationAnnouncementImpressionRecorded();
    expect(hasRecordedNotificationAnnouncementImpression()).toBe(true);
  });

  it("syncs dismiss across tabs via the storage event", () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeNotificationAnnouncementDismissed(() => {
      seen.push(readNotificationAnnouncementDismissed());
    });
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: NOTIFICATION_ANNOUNCEMENT_DISMISSED_KEY,
        newValue: "1",
      }),
    );
    expect(readNotificationAnnouncementDismissed()).toBe(true);
    expect(seen.at(-1)).toBe(true);
    unsubscribe();
  });
});

describe("isIosInstallPrerequisiteDismissed", () => {
  it("is true only for uninstalled iOS after soft install dismiss", () => {
    expect(
      isIosInstallPrerequisiteDismissed({
        isIos: true,
        installed: false,
        installAvailable: true,
        showInstallPrompt: false,
      }),
    ).toBe(true);
  });

  it("is false for Chromium install dismiss, installed iOS, or open install prompt", () => {
    expect(
      isIosInstallPrerequisiteDismissed({
        isIos: false,
        installed: false,
        installAvailable: true,
        showInstallPrompt: false,
      }),
    ).toBe(false);
    expect(
      isIosInstallPrerequisiteDismissed({
        isIos: true,
        installed: true,
        installAvailable: false,
        showInstallPrompt: false,
      }),
    ).toBe(false);
    expect(
      isIosInstallPrerequisiteDismissed({
        isIos: true,
        installed: false,
        installAvailable: true,
        showInstallPrompt: true,
      }),
    ).toBe(false);
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

  it("hides on iOS browser-tab after install-prompt dismiss even if state is default", () => {
    expect(
      isNotificationAnnouncementVisible({
        ...base,
        iosInstallPrerequisiteDismissed: true,
      }),
    ).toBe(false);
  });
});

describe("shouldSuppressNotificationAnnouncementForUiState", () => {
  it("suppresses opted-in device states so disable does not re-announce", () => {
    expect(shouldSuppressNotificationAnnouncementForUiState("enabled")).toBe(true);
    expect(shouldSuppressNotificationAnnouncementForUiState("needs_migration")).toBe(true);
    expect(shouldSuppressNotificationAnnouncementForUiState("needs_remigrate_finish")).toBe(true);
    expect(shouldSuppressNotificationAnnouncementForUiState("default")).toBe(false);
    expect(shouldSuppressNotificationAnnouncementForUiState("blocked")).toBe(false);
    expect(shouldSuppressNotificationAnnouncementForUiState(null)).toBe(false);
  });
});
