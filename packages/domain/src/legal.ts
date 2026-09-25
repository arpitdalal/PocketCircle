import { APEX_HOSTNAME } from "./origins.js";

export const LEGAL_DOCUMENTS = {
  terms: { version: "2026-09-07", effectiveDate: "September 7, 2026" },
  privacy: { version: "2026-09-07", effectiveDate: "September 7, 2026" },
} as const;

export const CURRENT_TERMS_VERSION = LEGAL_DOCUMENTS.terms.version;
export const CURRENT_PRIVACY_VERSION = LEGAL_DOCUMENTS.privacy.version;

// Public contact shown on the support page. Derived from the apex host (#404) so
// an origin move cannot leave the addresses behind.
export const POCKETCIRCLE_SUPPORT_EMAIL = `support@${APEX_HOSTNAME}`;
export const POCKETCIRCLE_LEGAL_EMAIL = `legal@${APEX_HOSTNAME}`;
