/** Device-local hint for which Google Account Email last signed into PocketCircle. */
export const LAST_USED_GOOGLE_EMAIL_STORAGE_KEY = "pocketcircle.lastUsedGoogleEmail";

const GOOGLE_ACCOUNT_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const sameTabListeners = new Set<() => void>();

function emitLastUsedGoogleEmailChange() {
  for (const listener of sameTabListeners) {
    listener();
  }
}

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

  return `${local[0]}***@${domain}`;
}

export function getLastUsedGoogleEmail() {
  if (typeof window === "undefined") {
    return null;
  }

  const stored = window.localStorage.getItem(LAST_USED_GOOGLE_EMAIL_STORAGE_KEY);
  if (!stored || !isGoogleAccountEmail(stored)) {
    if (stored !== null) {
      window.localStorage.removeItem(LAST_USED_GOOGLE_EMAIL_STORAGE_KEY);
    }
    return null;
  }

  return stored;
}

export function getMaskedLastUsedGoogleEmail() {
  const stored = getLastUsedGoogleEmail();
  return stored ? maskGoogleAccountEmail(stored) : null;
}

/** Notifies React subscribers on same-tab writes and cross-tab storage events. */
export function subscribeLastUsedGoogleEmail(onStoreChange: () => void) {
  if (typeof window === "undefined") {
    return () => {};
  }

  const onStorage = (event: StorageEvent) => {
    if (event.key === LAST_USED_GOOGLE_EMAIL_STORAGE_KEY || event.key === null) {
      onStoreChange();
    }
  };

  window.addEventListener("storage", onStorage);
  sameTabListeners.add(onStoreChange);

  return () => {
    window.removeEventListener("storage", onStorage);
    sameTabListeners.delete(onStoreChange);
  };
}

export function setLastUsedGoogleEmail(email: string) {
  if (typeof window === "undefined" || !isGoogleAccountEmail(email)) {
    return;
  }

  window.localStorage.setItem(LAST_USED_GOOGLE_EMAIL_STORAGE_KEY, email);
  emitLastUsedGoogleEmailChange();
}

export function clearLastUsedGoogleEmail() {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(LAST_USED_GOOGLE_EMAIL_STORAGE_KEY);
  emitLastUsedGoogleEmailChange();
}
