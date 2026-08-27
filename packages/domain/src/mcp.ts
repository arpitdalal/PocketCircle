/**
 * MCP grant vocabulary shared by Convex authorization and (later) the Worker
 * bridge. Convex owns the live grant; scopes here are OAuth resource scopes,
 * not app Member/Owner permissions.
 */

export const MCP_SCOPES = ["pocketcircle:read", "pocketcircle:write"] as const;

export type McpScope = (typeof MCP_SCOPES)[number];

export const MCP_GRANT_STATUSES = ["pending", "active", "revoked"] as const;

export type McpGrantStatus = (typeof MCP_GRANT_STATUSES)[number];

/** Worker-grant cleanup after Convex revocation (reconciliation, #330). */
export const MCP_WORKER_CLEANUP_STATUSES = ["none", "pending_revoke"] as const;

export type McpWorkerCleanupStatus = (typeof MCP_WORKER_CLEANUP_STATUSES)[number];

/** Circle-level app permission an MCP operation may require (existing guard). */
export const MCP_CIRCLE_PERMISSIONS = ["member", "owner"] as const;

export type McpCirclePermission = (typeof MCP_CIRCLE_PERMISSIONS)[number];

const mcpScopeSet = new Set<string>(MCP_SCOPES);

export function isMcpScope(value: string): value is McpScope {
  return mcpScopeSet.has(value);
}

/** Every scope in `required` appears in `granted` (order-independent). */
export function mcpScopesInclude(granted: readonly string[], required: McpScope) {
  return granted.includes(required);
}

/**
 * Normalize a client-supplied scope list: drop unknowns, dedupe, stable order
 * matching {@link MCP_SCOPES}. Empty after filter ⇒ invalid.
 */
export function normalizeMcpScopes(scopes: readonly string[]) {
  const present = new Set<McpScope>();
  for (const scope of scopes) {
    if (isMcpScope(scope)) {
      present.add(scope);
    }
  }
  const normalized = MCP_SCOPES.filter((scope) => present.has(scope));
  return normalized.length > 0 ? normalized : null;
}
