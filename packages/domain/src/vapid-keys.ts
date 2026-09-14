/**
 * VAPID key material helpers shared by Convex queries (no Node Buffer) and
 * the web client. Send-time pair matching stays in the Node push sender.
 */

import { p256 } from "@noble/curves/nist.js";

/** Decode URL-safe base64 VAPID key bytes; null when malformed or empty. */
export function tryDecodeVapidKeyBytes(key: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(key) || key.length === 0 || key.length > 128) {
    return null;
  }
  try {
    const padding = "=".repeat((4 - (key.length % 4)) % 4);
    const base64 = (key + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    if (raw.length === 0) {
      return null;
    }
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) {
      bytes[i] = raw.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

/** Uncompressed P-256 public key (65 bytes, 0x04) that lies on the curve. */
export function isUncompressedP256Point(bytes: Uint8Array) {
  if (bytes.length !== 65 || bytes[0] !== 0x04) {
    return false;
  }
  try {
    p256.Point.fromBytes(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Uncompressed on-curve P-256 public key as URL-safe base64. */
export function isValidVapidPublicKey(key: string) {
  const bytes = tryDecodeVapidKeyBytes(key);
  return bytes !== null && isUncompressedP256Point(bytes);
}
