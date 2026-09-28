/**
 * Browser Origin checks for MCP Worker consent / revoke endpoints.
 * Loopback hostnames are interchangeable when APP_ORIGIN is also loopback
 * (Vite may serve `localhost` while .dev.vars pins `127.0.0.1`), so the trusted
 * set comes from `@pocketcircle/domain` — the one place that rule is written
 * down (#404).
 *
 * One app origin. It was two for the length of the ADR 0035 handover, because the
 * two Workers claiming the apex are swapped in deploys this one is not part of, and
 * a single-valued `APP_ORIGIN` would have left the consent, revoke, and handoff
 * endpoints refusing the only origin a User could reach in between. The cutover is
 * deployed and confirmed, so the retired apex is gone (#412).
 */
import { loopbackTrustedOrigins } from "@pocketcircle/domain";

/**
 * Whether a presented browser `Origin` may drive the consent and revoke endpoints.
 */
export function browserOriginAllowed(requestOrigin: string | null, appOrigin: string) {
  if (!requestOrigin) {
    return false;
  }
  let presented: string;
  try {
    // Normalize the presented origin too: a hand-written `Origin` header may
    // carry a path or a trailing slash, and `loopbackTrustedOrigins` compares
    // bare origins.
    presented = new URL(requestOrigin).origin;
  } catch {
    return false;
  }
  return loopbackTrustedOrigins(appOrigin).includes(presented);
}
