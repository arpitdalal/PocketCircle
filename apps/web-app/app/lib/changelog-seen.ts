import { useSyncExternalStore } from "react";
import {
  createDeviceLocalSubscription,
  readDeviceLocal,
  writeDeviceLocal,
} from "./device-local-store.js";

/**
 * Which released changelog version a signed-in User has already seen ON THIS BROWSER
 * (issue #351). Device-local by design: no Convex field, no mutation, no cross-device
 * sync for this release.
 *
 * Keyed by User id so two accounts sharing a browser keep separate read state, and it
 * stores the VERSION STRING (not a count or timestamp) so publishing a newer release
 * marks itself unread without any migration. Reads, writes, cross-tab notification and
 * the storage-failure fallback all come from {@link ./device-local-store.js}: a browser
 * that refuses to persist still clears the indicator for the rest of the visit and
 * shows it again on the next one.
 */

const STORAGE_KEY_PREFIX = "pocketcircle.changelogSeenVersion.";

export function changelogSeenStorageKey(userId: string) {
  return `${STORAGE_KEY_PREFIX}${userId}`;
}

export function readChangelogSeenVersion(userId: string) {
  return readDeviceLocal(changelogSeenStorageKey(userId));
}

export function markChangelogVersionSeen(userId: string, version: string) {
  writeDeviceLocal(changelogSeenStorageKey(userId), version);
}

/** Same-document writes, other tabs, and bfcache restores. */
export const subscribeChangelogSeen = createDeviceLocalSubscription((key) =>
  key.startsWith(STORAGE_KEY_PREFIX),
);

/**
 * Whether `latestVersion` is unread for this User on this browser: true when nothing
 * is stored or the stored version differs.
 *
 * The server snapshot reports the latest version as already seen so a prerendered
 * document never hydrates an indicator it would immediately drop.
 */
export function useChangelogUnread(userId: string, latestVersion: string | undefined) {
  const seenVersion = useSyncExternalStore(
    subscribeChangelogSeen,
    () => readChangelogSeenVersion(userId),
    () => latestVersion ?? null,
  );
  return latestVersion !== undefined && seenVersion !== latestVersion;
}
