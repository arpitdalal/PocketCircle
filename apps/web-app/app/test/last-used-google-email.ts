import {
  LAST_USED_GOOGLE_EMAIL_STORAGE_KEY,
  setLastUsedGoogleEmail,
} from "~/lib/last-used-google-email.js";

export function clearLastUsedGoogleEmailStorage() {
  window.localStorage.removeItem(LAST_USED_GOOGLE_EMAIL_STORAGE_KEY);
}

export function seedLastUsedGoogleEmail(email: string) {
  setLastUsedGoogleEmail(email);
}

/** Simulates another same-origin tab clearing the last-used email key. */
export function simulateCrossTabLastUsedGoogleEmailClear(oldValue: string) {
  window.localStorage.removeItem(LAST_USED_GOOGLE_EMAIL_STORAGE_KEY);
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: LAST_USED_GOOGLE_EMAIL_STORAGE_KEY,
      oldValue,
      newValue: null,
    }),
  );
}
