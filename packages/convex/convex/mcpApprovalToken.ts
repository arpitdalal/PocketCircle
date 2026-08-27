import { type McpApprovalPayload, sha256Hex, signMcpApproval } from "@pocketcircle/domain";

/**
 * Mints a HMAC-signed, short-lived MCP approval token and its SHA-256 hash for
 * single-use storage. Claims bind the consent decision; only the hash is stored.
 */
export async function mintMcpApprovalToken(claims: Omit<McpApprovalPayload, "v">, secret: string) {
  const payload: McpApprovalPayload = { v: 1, ...claims };
  const token = await signMcpApproval(payload, secret);
  return { token, tokenHash: await hashMcpApprovalToken(token), payload };
}

/** SHA-256 hex of the compact token — the value persisted in `mcpApprovalTokens.tokenHash`. */
export async function hashMcpApprovalToken(token: string) {
  return sha256Hex(token);
}
