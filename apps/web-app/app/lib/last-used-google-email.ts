import {
  createDeviceLocalSubscription,
  readDeviceLocal,
  removeDeviceLocal,
  writeDeviceLocal,
} from "./device-local-store.js";

/** Device-local hint for which Google Account Email last signed into PocketCircle. */
export const LAST_USED_GOOGLE_EMAIL_STORAGE_KEY = "pocketcircle.lastUsedGoogleEmail";

const GOOGLE_ACCOUNT_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isGoogleAccountEmail(value: string) {
  return GOOGLE_ACCOUNT_EMAIL_PATTERN.test(value);
}

export function maskGoogleAccountEmail(email: string) {
  if (!isGoogleAccountEmail(email)) {
    return null;
  }

  const atIndex = email.indexOf("@");
  const local = email.slice(0, atIndex).trim();
  const domain = email.slice(atIndex + 1).trim();
  if (!local || !domain) {
    return null;
  }

  let maskedLocal: string;
  if (local.length <= 2) {
    maskedLocal = `${local}***`;
  } else if (local.length === 3) {
    maskedLocal = `${local.slice(0, 2)}***`;
  } else {
    maskedLocal = `${local.slice(0, 2)}***${local.slice(-1)}`;
  }

  return `${maskedLocal}@${domain}`;
}

/**
 * Pure read: this is the `getSnapshot` behind `subscribeLastUsedGoogleEmail`, so it must
 * not touch storage. Evicting a value that fails validation here would mutate storage
 * from render — and `removeItem` also wakes every other tab in the origin — for a render
 * React may discard. A junk value is inert instead: it reads as "no hint" and the next
 * successful sign-in overwrites it.
 */
export function getLastUsedGoogleEmail() {
  const stored = readDeviceLocal(LAST_USED_GOOGLE_EMAIL_STORAGE_KEY);
  return stored && isGoogleAccountEmail(stored) ? stored : null;
}

export function getMaskedLastUsedGoogleEmail() {
  const stored = getLastUsedGoogleEmail();
  return stored ? maskGoogleAccountEmail(stored) : null;
}

/** Notifies React subscribers on same-tab writes, other tabs, and bfcache restores. */
export const subscribeLastUsedGoogleEmail = createDeviceLocalSubscription(
  (key) => key === LAST_USED_GOOGLE_EMAIL_STORAGE_KEY,
);

export function setLastUsedGoogleEmail(email: string) {
  if (!isGoogleAccountEmail(email)) {
    return;
  }

  writeDeviceLocal(LAST_USED_GOOGLE_EMAIL_STORAGE_KEY, email);
}

export function clearLastUsedGoogleEmail() {
  removeDeviceLocal(LAST_USED_GOOGLE_EMAIL_STORAGE_KEY);
}
