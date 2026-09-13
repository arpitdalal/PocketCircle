/**
 * Per-device Web Push subscription constraints (ADR 0033 / issue #381).
 * Structural checks only — Convex re-validates at the mutation boundary.
 * Node send path additionally resolves DNS and rejects private addresses.
 */

/** Soft cap on active subscriptions per User; enable prunes then LRU-replaces. */
export const MAX_PUSH_SUBSCRIPTIONS_PER_USER = 10;

/** Default VAPID key identity when `VAPID_KEY_ID` env is unset (v1 single key). */
export const DEFAULT_VAPID_KEY_ID = "primary";

/** Non-empty https Push endpoint (browser Push API). */
export function isValidPushEndpoint(endpoint: string) {
  const trimmed = endpoint.trim();
  if (trimmed.length === 0 || trimmed !== endpoint || endpoint.length > 4096) {
    return false;
  }
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function normalizeHostname(host: string) {
  // `localhost.` and similar absolute forms should still fail local checks.
  return host.replace(/\.+$/, "").toLowerCase();
}

function isIpLiteralHostname(host: string) {
  if (host.startsWith("[") && host.endsWith("]")) {
    return true;
  }
  if (host.includes(":")) {
    return true;
  }
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/** Normalize `::ffff:127.0.0.1` and `::ffff:7f00:1` to dotted IPv4. */
function ipv4FromMappedIpv6(ip: string) {
  if (!ip.startsWith("::ffff:")) {
    return null;
  }
  const rest = ip.slice("::ffff:".length);
  if (rest.includes(".")) {
    return rest;
  }
  const hextets = rest.split(":");
  if (hextets.length !== 2) {
    return null;
  }
  const high = Number.parseInt(hextets[0] ?? "", 16);
  const low = Number.parseInt(hextets[1] ?? "", 16);
  if (
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    high < 0 ||
    low < 0 ||
    high > 0xffff ||
    low > 0xffff
  ) {
    return null;
  }
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

/** True when an IPv4/IPv6 literal is loopback, link-local, private, or reserved. */
export function isPrivateOrReservedIpAddress(ip: string) {
  const value = ip.trim().toLowerCase();
  if (value.includes(":")) {
    const mappedV4 = ipv4FromMappedIpv6(value);
    if (mappedV4 !== null) {
      return isPrivateOrReservedIpAddress(mappedV4);
    }
    if (value === "::1" || value === "::" || value === "0:0:0:0:0:0:0:1") {
      return true;
    }
    // Unique local fc00::/7 and link-local fe80::/10 (prefix check on first hextet).
    const first = value.split(":", 1)[0] ?? "";
    const firstNum = Number.parseInt(first || "0", 16);
    if (!Number.isFinite(firstNum)) {
      return true;
    }
    if ((firstNum & 0xfe00) === 0xfc00) {
      return true;
    }
    if ((firstNum & 0xffc0) === 0xfe80) {
      return true;
    }
    return false;
  }

  const parts = value.split(".").map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a, b] = parts;
  if (a === undefined || b === undefined) {
    return true;
  }
  if (a === 0 || a === 10 || a === 127) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return true;
  }
  if (a >= 224) {
    return true;
  }
  return false;
}

/**
 * HTTPS Push endpoint structurally safe to attempt (SSRF hostname gate).
 *
 * Browsers pick opaque push-service hosts — no vendor allowlist. Reject
 * loopback / link-local / internal hostnames and IP literals. The Node sender
 * must still resolve DNS and reject private/reserved addresses before POST.
 */
export function isSafePushEndpoint(endpoint: string) {
  if (!isValidPushEndpoint(endpoint)) {
    return false;
  }
  const host = normalizeHostname(new URL(endpoint).hostname);
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".intranet") ||
    host.endsWith(".corp") ||
    host.endsWith(".lan") ||
    host === "metadata.google.internal"
  ) {
    return false;
  }
  if (isIpLiteralHostname(host)) {
    return false;
  }
  return true;
}

function decodeBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 128) {
    return null;
  }
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (normalized.length % 4)) % 4;
  try {
    const binary = atob(normalized + "=".repeat(padLen));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

/** Endpoint + encryption keys present and structurally usable for web-push encrypt. */
export function isValidPushSubscriptionMaterial(input: {
  endpoint: string;
  p256dh: string;
  auth: string;
  vapidKeyId?: string;
}) {
  if (!isSafePushEndpoint(input.endpoint)) {
    return false;
  }
  const p256dh = decodeBase64Url(input.p256dh.trim());
  const auth = decodeBase64Url(input.auth.trim());
  if (!p256dh || !auth) {
    return false;
  }
  // Uncompressed (65) or compressed (33) P-256 public key; auth secret is 16 bytes.
  if ((p256dh.length !== 65 && p256dh.length !== 33) || auth.length !== 16) {
    return false;
  }
  return (
    input.vapidKeyId === undefined ||
    (input.vapidKeyId.trim().length > 0 && input.vapidKeyId.length <= 128)
  );
}
