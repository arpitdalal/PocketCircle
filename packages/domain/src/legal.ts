export const LEGAL_DOCUMENTS = {
  terms: { version: "2026-08-12", effectiveDate: "August 12, 2026" },
  privacy: { version: "2026-08-13", effectiveDate: "August 13, 2026" },
} as const;

export const CURRENT_TERMS_VERSION = LEGAL_DOCUMENTS.terms.version;
export const CURRENT_PRIVACY_VERSION = LEGAL_DOCUMENTS.privacy.version;

// Public contact shown in the app. The deployment's SUPPORT_EMAIL controls where
// feedback is delivered and may intentionally route to a different inbox later.
export const POCKETCIRCLE_SUPPORT_EMAIL = "arpitdalalm@gmail.com";
