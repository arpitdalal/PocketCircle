/**
 * Stable Feature Announcement IDs. Permanent product history — never reuse or
 * prune. Shared by Convex (acknowledgment allowlist) and the web catalog.
 *
 * This is a RESERVATION registry of every ID ever used, not the live catalog.
 * `duplicate-transaction` has no catalog entry any more (its campaign ended and
 * only the newest entry can ever render), but the ID stays here forever: Users
 * who acknowledged it still carry it in `acknowledgedFeatureAnnouncementIds`, so
 * reusing the name would silently hide the new campaign from all of them.
 */
export const FEATURE_ANNOUNCEMENT_IDS = [
  "duplicate-transaction",
  "mcp-connections",
  "my-transactions",
] as const;

export type FeatureAnnouncementId = (typeof FEATURE_ANNOUNCEMENT_IDS)[number];

const FEATURE_ANNOUNCEMENT_ID_SET = new Set<string>(FEATURE_ANNOUNCEMENT_IDS);

export function isFeatureAnnouncementId(value: string): value is FeatureAnnouncementId {
  return FEATURE_ANNOUNCEMENT_ID_SET.has(value);
}
