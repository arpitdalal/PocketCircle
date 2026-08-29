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
