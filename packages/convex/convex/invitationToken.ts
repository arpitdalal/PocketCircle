import { generateOpaqueToken } from "./opaqueToken.js";

/** Opaque, URL-safe invitation token (the bearer credential; only its hash is stored). */
export function generateInvitationToken() {
  return generateOpaqueToken();
}

/** SHA-256 hex of the token — the value persisted in `invitations.tokenHash`. */
export async function hashInvitationToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
