import type { FeatureAnnouncementId } from "@pocketcircle/domain";
import type { LucideIcon } from "lucide-react";
import { FilterIcon, ReceiptTextIcon, SearchIcon } from "lucide-react";
import { circleRefOf } from "./circle-path.js";

/** One icon + copy row under the headline. At most three; the card has no body paragraph. */
export interface FeatureAnnouncementHighlight {
  /** Statically imported lucide component — never a name string (keeps tree-shaking). */
  readonly icon: LucideIcon;
  readonly title: string;
  readonly body: string;
}

/**
 * Typed in-repo Feature Announcement catalog (#282, enriched in #334). Newest
 * entry owns the slot, so an ended campaign is deleted outright rather than kept
 * as unreachable data — its ID stays reserved in `@pocketcircle/domain`.
 *
 * `eligibleBefore` is immutable product history — set at that campaign's release prep.
 */
export interface FeatureAnnouncement {
  readonly id: FeatureAnnouncementId;
  readonly label: string;
  readonly title: string;
  /**
   * Required hero image. Authoring spec (16:9, 1280x720 WebP, R2 filenames, the
   * quiet top-right corner the close button covers):
   * `docs/research/announcement-card-media-and-motion.md` — "Hero image asset spec".
   */
  readonly heroImage: {
    readonly src: string;
    readonly alt: string;
  };
  readonly highlights: readonly FeatureAnnouncementHighlight[];
  readonly ctaLabel: string;
  /** In-app path the CTA opens; the card appends the current origin as `returnTo`. */
  readonly ctaHref: string;
  /** UTC ISO instant; User is eligible when `createdAt < Date.parse(eligibleBefore)`. */
  readonly eligibleBefore: string;
}

export const FEATURE_ANNOUNCEMENTS = [
  {
    id: "my-transactions",
    label: "New",
    title: "Find every Transaction you paid for",
    heroImage: {
      src: "/announcements/my-transactions.svg",
      alt: "A list of Transactions across Circles with search and filters.",
    },
    highlights: [
      {
        icon: ReceiptTextIcon,
        title: "All your Circles",
        body: "One list of Transactions paid by you.",
      },
      {
        icon: SearchIcon,
        title: "Search anytime",
        body: "Title, note, dates, and amounts — not stuck to one month.",
      },
      {
        icon: FilterIcon,
        title: "Filter by Circle",
        body: "Narrow without leaving Home-level navigation.",
      },
    ],
    ctaLabel: "Open My Transactions",
    ctaHref: "/my-transactions",
    // Unreleased campaign — eligible for Users created before this cutoff.
    eligibleBefore: "2026-12-31T00:00:00.000Z",
  },
] as const satisfies readonly FeatureAnnouncement[];

/** The single campaign that owns the announcement slot (newest catalog entry). */
export function activeFeatureAnnouncement() {
  return selectActiveCatalogEntry(FEATURE_ANNOUNCEMENTS);
}

/**
 * Beat between the card becoming genuinely showable and its entrance animation
 * (#334). The card only appears once eligibility has settled, the route matches,
 * and no install surface covers it — so that already IS "after the page loaded";
 * this delay exists so the entrance reads as motion arriving on a settled page
 * instead of part of the first paint. Deliberately not `requestIdleCallback`:
 * unsupported on older iOS Safari, absent in jsdom, and it buys nothing here.
 */
export const ANNOUNCEMENT_ENTRANCE_DELAY_MS = 600;

/**
 * Polite status text for the card's first genuine appearance. Highlight TITLES
 * only: the visible card carries each body, and speaking all six segments makes
 * an unprompted announcement far heavier than the one-sentence status #282 asked
 * for. The card is also a labelled region, so the detail stays reachable.
 */
export function announcementLiveMessage(announcement: FeatureAnnouncement) {
  return [
    announcement.label,
    announcement.title,
    ...announcement.highlights.map((highlight) => highlight.title),
  ].join(". ");
}

export type FeatureAnnouncementRouteScope =
  | { kind: "home" }
  | { kind: "circle"; circleRef: string };

/** Allowed in-Circle child segments for the announcement card (Dashboard = none). */
const ANNOUNCEMENT_CIRCLE_CHILDREN = new Set(["transactions", "categories"]);

/**
 * Allowed routes for the Feature Announcement card: Home, My Transactions,
 * Circle Dashboard, Ledger, Categories list. Circle identity comes from {@link circleRefOf};
 * this helper only applies the announcement child-route allowlist.
 */
export function featureAnnouncementRouteScope(pathname: string) {
  if (pathname === "/" || pathname === "/my-transactions") {
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
