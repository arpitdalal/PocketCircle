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
