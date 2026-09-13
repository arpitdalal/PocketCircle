/**
 * Synthetic Push subscription key material for convex-test only — not production.
 * Correct decoded lengths so bind validation accepts fixtures.
 */
import { createECDH } from "node:crypto";

export const TEST_PUSH_P256DH =
  "BAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
export const TEST_PUSH_AUTH = "CQkJCQkJCQkJCQkJCQkJCQ";
export const TEST_PUSH_P256DH_ALT =
  "BAoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo";
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
