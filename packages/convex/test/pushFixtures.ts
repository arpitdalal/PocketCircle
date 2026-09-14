/**
 * Synthetic Push subscription key material for convex-test only — not production.
 * On-curve uncompressed P-256 points + 16-byte auth so bind validation accepts.
 */
import { createECDH } from "node:crypto";

/** Fixed P-256 public key (sk = …01). Not a secret — test fixture only. */
export const TEST_PUSH_P256DH =
  "BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
export const TEST_PUSH_AUTH = "CQkJCQkJCQkJCQkJCQkJCQ";
/** Fixed P-256 public key (sk = …02). Not a secret — test fixture only. */
export const TEST_PUSH_P256DH_ALT =
  "BHzyexiNA09-ilI4AwS1GsPAiWnid_IbNaYLSPxHZpl4B3dVENuO0EApPZrGn3Qw27p9reY86YIpngS3nSJ4c9E";
export const TEST_PUSH_AUTH_ALT = "CwsLCwsLCwsLCwsLCwsLCw";

/** Runtime ECDH pair for Node push-send tests (not a committed secret). */
export function generateTestVapidKeyPair() {
  const curve = createECDH("prime256v1");
  curve.generateKeys();
  let privateKey = curve.getPrivateKey();
  let publicKey = curve.getPublicKey();
  if (privateKey.length < 32) {
    privateKey = Buffer.concat([Buffer.alloc(32 - privateKey.length), privateKey]);
  }
  if (publicKey.length < 65) {
    publicKey = Buffer.concat([Buffer.alloc(65 - publicKey.length), publicKey]);
  }
  return {
    publicKey: publicKey.toString("base64url"),
    privateKey: privateKey.toString("base64url"),
  };
}
