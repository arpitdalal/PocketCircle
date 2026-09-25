/**
 * Browser Origin checks for MCP Worker consent / revoke endpoints.
 * Loopback hostnames are interchangeable when APP_ORIGIN is also loopback
 * (Vite may serve `localhost` while .dev.vars pins `127.0.0.1`), so the trusted
 * set comes from `@pocketcircle/domain` — the one place that rule is written
 * down (#404).
 */
import { loopbackTrustedOrigins } from "@pocketcircle/domain";

export function browserOriginAllowed(requestOrigin: string | null, appOrigin: string) {
  if (!requestOrigin) {
    return false;
  }
  try {
    // Normalize the presented origin too: a hand-written `Origin` header may
    // carry a path or a trailing slash, and `loopbackTrustedOrigins` compares
    // bare origins.
    return loopbackTrustedOrigins(appOrigin).includes(new URL(requestOrigin).origin);
  } catch {
    return false;
  }
}
