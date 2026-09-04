/**
 * Stable Feature Announcement IDs. Permanent product history — never reuse or
 * prune. Shared by Convex (acknowledgment allowlist) and the web catalog.
 */
export const FEATURE_ANNOUNCEMENT_IDS = ["duplicate-transaction", "mcp-connections"] as const;

export type FeatureAnnouncementId = (typeof FEATURE_ANNOUNCEMENT_IDS)[number];

const FEATURE_ANNOUNCEMENT_ID_SET = new Set<string>(FEATURE_ANNOUNCEMENT_IDS);

export function isFeatureAnnouncementId(value: string): value is FeatureAnnouncementId {
  return FEATURE_ANNOUNCEMENT_ID_SET.has(value);
}
