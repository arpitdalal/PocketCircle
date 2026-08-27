/**
 * Opaque, URL-safe bearer material (base64url, no padding). Used for invitation
 * link tokens and MCP principals — only hashes or Convex-side mappings are stored
 * where the plaintext must not be recoverable.
 */
export function generateOpaqueToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
