export const LEGAL_DOCUMENTS = {
  terms: { version: "2026-09-07", effectiveDate: "September 7, 2026" },
  privacy: { version: "2026-09-07", effectiveDate: "September 7, 2026" },
} as const;

export const CURRENT_TERMS_VERSION = LEGAL_DOCUMENTS.terms.version;
export const CURRENT_PRIVACY_VERSION = LEGAL_DOCUMENTS.privacy.version;

// Public contact shown on the support page.
export const POCKETCIRCLE_SUPPORT_EMAIL = "support@pocketcircle.app";
export const POCKETCIRCLE_LEGAL_EMAIL = "legal@pocketcircle.app";
