/**
 * VAPID key material helpers shared by Convex queries (no Node Buffer) and
 * the web client. Send-time pair matching stays in the Node push sender.
 */

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

/** Uncompressed P-256 public key (65 bytes, 0x04 prefix) as URL-safe base64. */
export function isValidVapidPublicKey(key: string) {
  const bytes = tryDecodeVapidKeyBytes(key);
  return bytes !== null && bytes.length === 65 && bytes[0] === 0x04;
}
