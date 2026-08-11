export const LEGAL_DOCUMENTS = {
  terms: { version: "2026-08-11", effectiveDate: "August 11, 2026" },
  privacy: { version: "2026-08-11", effectiveDate: "August 11, 2026" },
} as const;

export const CURRENT_TERMS_VERSION = LEGAL_DOCUMENTS.terms.version;
export const CURRENT_PRIVACY_VERSION = LEGAL_DOCUMENTS.privacy.version;

// Public contact shown in the app. The deployment's SUPPORT_EMAIL controls where
// feedback is delivered and may intentionally route to a different inbox later.
export const SPEND_CIRCLE_SUPPORT_EMAIL = "arpitdalalm@gmail.com";
