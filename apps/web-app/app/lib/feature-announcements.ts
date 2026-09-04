import { type FeatureAnnouncementId, isFeatureAnnouncementId } from "@pocketcircle/domain";
import { circleRefOf } from "./circle-path.js";

/**
 * Typed in-repo Feature Announcement catalog (#282). Newest entry owns the slot.
 * `eligibleBefore` is immutable product history — set at that campaign's release prep.
 */
export interface FeatureAnnouncement {
  readonly id: FeatureAnnouncementId;
  readonly label: string;
  readonly title: string;
  readonly body: string;
  readonly ctaLabel: string;
  /** UTC ISO instant; User is eligible when `createdAt < Date.parse(eligibleBefore)`. */
  readonly eligibleBefore: string;
}

export const FEATURE_ANNOUNCEMENTS = [
  {
    id: "duplicate-transaction",
    label: "New",
    title: "Duplicate a transaction",
    body: "Start from a recent transaction, select Duplicate, then review and save a separate copy.",
    ctaLabel: "Try Duplicate",
    // Release cutoff: Users created at or after this instant never see the card.
    eligibleBefore: "2026-08-26T13:40:00.000Z",
  },
  {
    id: "mcp-connections",
    label: "New",
    title: "Connect PocketCircle to your AI assistant",
    body: "Paste the MCP server URL from Connections, approve Circles, then ask your assistant about shared spending.",
    ctaLabel: "Open Connections",
    // MCP Connections went live with v0.4.1 (2026-09-04T19:24:27Z).
    eligibleBefore: "2026-09-04T19:25:00.000Z",
  },
] as const satisfies readonly FeatureAnnouncement[];

/** Duplicate CTA needs a Transaction source; MCP CTA is a static Connections href. */
export function featureAnnouncementNeedsSource(announcement: FeatureAnnouncement) {
  return announcement.id === "duplicate-transaction";
}

/** The single campaign that owns the announcement slot (newest catalog entry). */
export function activeFeatureAnnouncement() {
  return selectActiveCatalogEntry(FEATURE_ANNOUNCEMENTS);
}

export type FeatureAnnouncementRouteScope =
  | { kind: "home" }
  | { kind: "circle"; circleRef: string };

/** Allowed in-Circle child segments for the announcement card (Dashboard = none). */
const ANNOUNCEMENT_CIRCLE_CHILDREN = new Set(["transactions", "categories"]);

/**
 * Allowed routes for the Feature Announcement card: Home, Circle Dashboard,
 * Ledger, Categories list. Circle identity comes from {@link circleRefOf};
 * this helper only applies the announcement child-route allowlist.
 */
export function featureAnnouncementRouteScope(pathname: string) {
  if (pathname === "/") {
    return { kind: "home" } as const;
  }

  const circleRef = circleRefOf(pathname);
  if (circleRef === null) {
    return null;
  }

  // One optional child after `/circles/<ref>`; deeper paths (detail/create/edit) fail.
  const childMatch = pathname.match(/^\/circles\/[^/?#]+(?:\/([^/?#]+))?\/?$/);
  if (!childMatch) {
    return null;
  }
  const child = childMatch[1];
  if (child === undefined || ANNOUNCEMENT_CIRCLE_CHILDREN.has(child)) {
    return { kind: "circle", circleRef } as const;
  }
  return null;
}

export function isEligibleForFeatureAnnouncement(
  announcement: FeatureAnnouncement,
  user: {
    createdAt: number;
    acknowledgedFeatureAnnouncementIds: readonly string[];
  },
) {
  const cutoff = Date.parse(announcement.eligibleBefore);
  if (!Number.isFinite(cutoff) || user.createdAt >= cutoff) {
    return false;
  }
  return !user.acknowledgedFeatureAnnouncementIds.includes(announcement.id);
}

/** Transient React Router location.state set by the announcement CTA. */
export function featureAnnouncementFocusFromState(state: unknown) {
  if (typeof state !== "object" || state === null) {
    return null;
  }
  if (!("featureAnnouncementFocus" in state)) {
    return null;
  }
  const value = state.featureAnnouncementFocus;
  if (typeof value !== "string" || !isFeatureAnnouncementId(value)) {
    return null;
  }
  return value;
}

/** Duplicate Transaction Detail focus — first campaign's CTA target on Detail. */
export function shouldFocusDuplicateAction(
  focus: ReturnType<typeof featureAnnouncementFocusFromState>,
) {
  return focus === "duplicate-transaction";
}

export function impressionStorageKey(announcementId: FeatureAnnouncementId) {
  return `pc:feature-announcement-impression:${announcementId}`;
}

export function hasRecordedImpression(announcementId: FeatureAnnouncementId) {
  try {
    return sessionStorage.getItem(impressionStorageKey(announcementId)) === "1";
  } catch {
    return false;
  }
}

export function markImpressionRecorded(announcementId: FeatureAnnouncementId) {
  try {
    sessionStorage.setItem(impressionStorageKey(announcementId), "1");
  } catch {
    // Best-effort; analytics remain optional.
  }
}

/** Newest catalog entry owns the announcement slot — no queue or older fallback. */
export function selectActiveCatalogEntry<T>(entries: readonly T[]) {
  if (entries.length === 0) {
    return null;
  }
  return entries[entries.length - 1] ?? null;
}
