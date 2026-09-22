import { describe, expect, it } from "vitest";
import {
  activeFeatureAnnouncement,
  announcementLiveMessage,
  FEATURE_ANNOUNCEMENTS,
  featureAnnouncementRouteScope,
  isEligibleForFeatureAnnouncement,
  selectActiveCatalogEntry,
} from "./feature-announcements.js";

describe("featureAnnouncementRouteScope", () => {
  it("allows Home, My Transactions, Circle Dashboard, Ledger, and Categories list", () => {
    expect(featureAnnouncementRouteScope("/")).toEqual({ kind: "home" });
    expect(featureAnnouncementRouteScope("/my-transactions")).toEqual({ kind: "home" });
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

  it("excludes Search, Setup, create/edit/detail, Settings, Connections, and other routes", () => {
    const excluded = [
      "/search",
      "/settings",
      "/connections",
      "/whats-new",
      "/feedback",
      "/onboarding",
      "/transactions/new",
      "/circles/new",
      "/circles/%6e%65%77",
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

  it("decodes Circle refs through circleRefOf", () => {
    expect(featureAnnouncementRouteScope("/circles/trip%2Dabc")).toEqual({
      kind: "circle",
      circleRef: "trip-abc",
    });
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

describe("selectActiveCatalogEntry", () => {
  it("gives the slot only to the newest entry with no older fallback", () => {
    expect(selectActiveCatalogEntry([])).toBeNull();
    expect(selectActiveCatalogEntry([{ id: "older" }, { id: "newer" }])).toEqual({ id: "newer" });
    expect(activeFeatureAnnouncement()?.id).toBe("my-transactions");
  });

  it("keeps only reachable entries — an ended campaign is deleted, not kept as data", () => {
    expect(FEATURE_ANNOUNCEMENTS).toHaveLength(1);
  });
});

describe("catalog shape", () => {
  it("requires a hero image and caps highlights at the small-phone height budget", () => {
    for (const announcement of FEATURE_ANNOUNCEMENTS) {
      // Pins R2 webp (released campaigns) or local public SVG (unreleased until CDN upload).
      // docs/research/announcement-card-media-and-motion.md — hero image asset spec.
      expect(announcement.heroImage.src, announcement.id).toMatch(
        /^(https:\/\/assets\.pocketcircle\.app\/announcements\/[a-z0-9-]+-v\d+\.webp|\/announcements\/[a-z0-9-]+\.svg)$/,
      );
      // Required, not decorative: the hero carries product meaning.
      expect(announcement.heroImage.alt.length, announcement.id).toBeGreaterThan(0);
      // Three 16:9-hero + bullet rows already fill an iPhone SE; see
      // docs/research/announcement-card-media-and-motion.md.
      expect(announcement.highlights.length, announcement.id).toBeGreaterThan(0);
      expect(announcement.highlights.length, announcement.id).toBeLessThanOrEqual(3);
      expect(announcement.ctaHref.startsWith("/"), announcement.id).toBe(true);
    }
  });

  it("speaks the label, title, and highlight titles — not every body", () => {
    const announcement = activeFeatureAnnouncement();
    if (!announcement) {
      throw new Error("expected active announcement");
    }
    const message = announcementLiveMessage(announcement);
    expect(message).toContain(announcement.label);
    expect(message).toContain(announcement.title);
    for (const highlight of announcement.highlights) {
      expect(message).toContain(highlight.title);
      expect(message).not.toContain(highlight.body);
    }
  });
});
