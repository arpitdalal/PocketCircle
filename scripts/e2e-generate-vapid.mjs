#!/usr/bin/env node
/**
 * Emit shell exports for a fresh E2E-only VAPID pair (issue #385).
 * Private key must not be committed — GitGuardian flags VAPID private material.
 * Same ECDH shape as packages/convex/test/pushFixtures.ts generateTestVapidKeyPair.
 */
import { createECDH } from "node:crypto";

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

const pub = publicKey.toString("base64url");
const priv = privateKey.toString("base64url");

// Single-quoted so shell eval is safe (base64url has no quotes).
process.stdout.write(
  [
    `E2E_VAPID_PUBLIC_KEY='${pub}'`,
    `E2E_VAPID_PRIVATE_KEY='${priv}'`,
    "E2E_VAPID_SUBJECT='mailto:e2e-push@pocketcircle.test'",
    "E2E_VAPID_KEY_ID='e2e-primary'",
    "",
  ].join("\n"),
);
