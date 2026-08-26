import { describe, expect, it } from "vitest";
import {
  activeFeatureAnnouncement,
  featureAnnouncementFocusFromState,
  featureAnnouncementRouteScope,
  isEligibleForFeatureAnnouncement,
} from "./feature-announcements.js";

describe("featureAnnouncementRouteScope", () => {
  it("allows Home, Circle Dashboard, Ledger, and Categories list", () => {
    expect(featureAnnouncementRouteScope("/")).toEqual({ kind: "home" });
    expect(featureAnnouncementRouteScope("/circles/trip-abc")).toEqual({
      kind: "circle",
      circleRef: "trip-abc",
    });
    expect(featureAnnouncementRouteScope("/circles/trip-abc/transactions")).toEqual({
      kind: "circle",
      circleRef: "trip-abc",
    });
    expect(featureAnnouncementRouteScope("/circles/trip-abc/categories")).toEqual({
      kind: "circle",
      circleRef: "trip-abc",
    });
  });

  it("excludes Search, Setup, create/edit/detail, Settings, and other routes", () => {
    const excluded = [
      "/search",
      "/settings",
      "/whats-new",
      "/feedback",
      "/onboarding",
      "/transactions/new",
      "/circles/new",
      "/circles/trip-abc/setup",
      "/circles/trip-abc/search",
      "/circles/trip-abc/transactions/new",
      "/circles/trip-abc/transactions/shop-xyz",
      "/circles/trip-abc/transactions/shop-xyz/edit",
      "/circles/trip-abc/categories/new",
      "/circles/trip-abc/categories/food-xyz",
      "/circles/trip-abc/members",
      "/circles/trip-abc/history",
      "/circles/trip-abc/settings",
      "/circles/trip-abc/feedback",
    ];
    for (const path of excluded) {
      expect(featureAnnouncementRouteScope(path), path).toBeNull();
    }
  });
});

describe("isEligibleForFeatureAnnouncement", () => {
  const announcement = activeFeatureAnnouncement();
  if (!announcement) {
    throw new Error("expected active announcement");
  }

  it("uses strict createdAt < eligibleBefore boundary semantics", () => {
    const cutoff = Date.parse(announcement.eligibleBefore);
    expect(
      isEligibleForFeatureAnnouncement(announcement, {
        createdAt: cutoff - 1,
        acknowledgedFeatureAnnouncementIds: [],
      }),
    ).toBe(true);
    expect(
      isEligibleForFeatureAnnouncement(announcement, {
        createdAt: cutoff,
        acknowledgedFeatureAnnouncementIds: [],
      }),
    ).toBe(false);
    expect(
      isEligibleForFeatureAnnouncement(announcement, {
        createdAt: cutoff + 1,
        acknowledgedFeatureAnnouncementIds: [],
      }),
    ).toBe(false);
  });

  it("excludes acknowledged Users", () => {
    expect(
      isEligibleForFeatureAnnouncement(announcement, {
        createdAt: 1,
        acknowledgedFeatureAnnouncementIds: [announcement.id],
      }),
    ).toBe(false);
  });
});

describe("featureAnnouncementFocusFromState", () => {
  it("reads only allowlisted announcement focus ids", () => {
    expect(
      featureAnnouncementFocusFromState({ featureAnnouncementFocus: "duplicate-transaction" }),
    ).toBe("duplicate-transaction");
    expect(featureAnnouncementFocusFromState({ featureAnnouncementFocus: "nope" })).toBeNull();
    expect(featureAnnouncementFocusFromState(null)).toBeNull();
  });
});
