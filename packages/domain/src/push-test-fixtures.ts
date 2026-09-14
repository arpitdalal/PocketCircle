/**
 * Synthetic Push key material for tests only — not production secrets.
 * Fixed on-curve uncompressed P-256 public keys + 16-byte auth so bind
 * validation accepts across web-app, convex, and domain tests.
 */

/** Fixed P-256 public key (sk = …01). */
export const TEST_PUSH_P256DH =
  "BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
export const TEST_PUSH_AUTH = "CQkJCQkJCQkJCQkJCQkJCQ";

/** Fixed P-256 public key (sk = …02). */
export const TEST_PUSH_P256DH_ALT =
  "BHzyexiNA09-ilI4AwS1GsPAiWnid_IbNaYLSPxHZpl4B3dVENuO0EApPZrGn3Qw27p9reY86YIpngS3nSJ4c9E";
export const TEST_PUSH_AUTH_ALT = "CwsLCwsLCwsLCwsLCwsLCw";
