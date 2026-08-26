import {
  FEATURE_ANNOUNCEMENT_IDS,
  type FeatureAnnouncementId,
  isFeatureAnnouncementId,
} from "@pocketcircle/domain";
import { RESERVED_CIRCLE_REFS } from "./circle-path.js";

/**
 * Typed in-repo Feature Announcement catalog (#282). Newest entry owns the slot.
 * `eligibleBefore` is immutable product history — provisional until release prep
 * replaces it with the concrete UTC cutoff immediately before merge.
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
    // Provisional cutoff for branch validation. Replace with the release-prep UTC
    // timestamp immediately before final approval — never merge a guessed value.
    eligibleBefore: "2099-01-01T00:00:00.000Z",
  },
] as const satisfies readonly FeatureAnnouncement[];

/** The single campaign that owns the announcement slot (newest catalog entry). */
export function activeFeatureAnnouncement() {
  return FEATURE_ANNOUNCEMENTS[FEATURE_ANNOUNCEMENTS.length - 1] ?? null;
}

export type FeatureAnnouncementRouteScope =
  | { kind: "home" }
  | { kind: "circle"; circleRef: string };

const RESERVED_CIRCLE_REF_SET = new Set<string>(RESERVED_CIRCLE_REFS);

/**
 * Allowed routes for the Feature Announcement card: Home, Circle Dashboard,
 * Ledger, Categories list. Everything else is excluded.
 */
export function featureAnnouncementRouteScope(
  pathname: string,
): FeatureAnnouncementRouteScope | null {
  if (pathname === "/") {
    return { kind: "home" };
  }

  const match = pathname.match(/^\/circles\/([^/?#]+)(?:\/([^/?#]+))?\/?$/);
  if (!match) {
    return null;
  }

  let circleRef: string;
  try {
    circleRef = decodeURIComponent(match[1] ?? "");
  } catch {
    return null;
  }
  if (circleRef === "" || RESERVED_CIRCLE_REF_SET.has(circleRef)) {
    return null;
  }

  const child = match[2];
  if (child === undefined || child === "transactions" || child === "categories") {
    return { kind: "circle", circleRef };
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

/** Exhaustive registry check so catalog IDs cannot drift from the domain allowlist. */
export function assertCatalogIdsAreRegistered() {
  for (const entry of FEATURE_ANNOUNCEMENTS) {
    if (!FEATURE_ANNOUNCEMENT_IDS.includes(entry.id)) {
      throw new Error(`Unregistered feature announcement id: ${entry.id}`);
    }
  }
}
