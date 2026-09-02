import { parseMcpWorkerJwks } from "@pocketcircle/domain";

/** Current signer plus the optional prior verifier used only during HMAC rotation. */
export function mcpWorkerVerificationSecrets() {
  const current = process.env.MCP_WORKER_HMAC_SECRET?.trim();
  if (!current) {
    return [];
  }
  const previous = process.env.MCP_WORKER_HMAC_SECRET_PREVIOUS?.trim();
  return previous && previous !== current ? [current, previous] : [current];
}

export function currentMcpWorkerSecret() {
  return mcpWorkerVerificationSecrets()[0];
}

/** Public-only Worker assertion keys. Invalid/missing configuration fails closed. */
export function mcpWorkerVerificationJwks() {
  const value = process.env.MCP_WORKER_VERIFYING_JWKS?.trim();
  return value ? parseMcpWorkerJwks(value) : null;
}

function isLocalHostname(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

/**
 * Service origin for Convex→Worker cleanup (#330). HTTPS required except loopback.
 * Unset/invalid → reconciliation leaves `pending_revoke` for a later configured run.
 */
export function mcpWorkerOrigin() {
  const raw = process.env.MCP_WORKER_ORIGIN?.trim();
  if (!raw) {
    return undefined;
  }
  try {
    const url = new URL(raw);
    if (url.pathname !== "/" || url.search || url.hash) {
      return undefined;
    }
    if (url.protocol === "https:") {
      return url.origin;
    }
    if (url.protocol === "http:" && isLocalHostname(url.hostname)) {
      return url.origin;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
