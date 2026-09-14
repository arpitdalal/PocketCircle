/**
 * Synthetic Push subscription key material for convex-test — not production.
 * Shared on-curve constants live in `@pocketcircle/domain`; Node-only ECDH
 * helpers stay here (browser tests cannot import node:crypto).
 */
import { createECDH } from "node:crypto";

export {
  TEST_PUSH_AUTH,
  TEST_PUSH_AUTH_ALT,
  TEST_PUSH_P256DH,
  TEST_PUSH_P256DH_ALT,
} from "@pocketcircle/domain";

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
