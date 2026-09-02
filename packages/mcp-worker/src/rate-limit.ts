import type { Env } from "./env.js";

export type McpToolClass = "read" | "write" | "destructive";

export type McpRateLimitClass = "authorization" | "token" | "failed_auth" | McpToolClass;

/** Ordinary mutating tools — tighter than reads, looser than archives. */
export const ORDINARY_WRITE_TOOL_NAMES = new Set([
  "create_category",
  "update_category",
  "restore_category",
  "create_transaction",
  "update_transaction",
  "restore_transaction",
]);

/** Archive tools — destructiveHint true; separate, tighter bucket. */
export const DESTRUCTIVE_TOOL_NAMES = new Set(["archive_category", "archive_transaction"]);

export const READ_TOOL_NAMES = new Set([
  "get_current_user",
  "list_authorized_circles",
  "get_circle",
  "list_members",
  "list_circle_history",
  "search_transactions",
  "get_transaction",
  "list_transaction_history",
  "get_monthly_ledger",
  "get_dashboard",
  "get_monthly_comparison",
  "get_category_analytics",
  "list_categories",
  "get_category",
  "list_category_transactions",
  "list_category_history",
]);

export function toolClassOf(toolName: string) {
  if (DESTRUCTIVE_TOOL_NAMES.has(toolName)) {
    return "destructive" as const;
  }
  if (ORDINARY_WRITE_TOOL_NAMES.has(toolName)) {
    return "write" as const;
  }
  if (READ_TOOL_NAMES.has(toolName)) {
    return "read" as const;
  }
  return null;
}

/**
 * Stable authenticated key: User + client + grant + tool-class.
 * Never puts bearer tokens or financial payloads into the key.
 */
export function authenticatedRateLimitKey(parts: {
  userId: string;
  clientId: string;
  grantId: string;
  toolClass: McpToolClass;
}) {
  return `u:${parts.userId}|c:${parts.clientId}|g:${parts.grantId}|t:${parts.toolClass}`;
}

/** Pre-auth surfaces: client when known, else connecting IP. */
export function unauthenticatedRateLimitKey(parts: {
  className: Exclude<McpRateLimitClass, McpToolClass>;
  clientId?: string;
  ip?: string;
}) {
  if (parts.clientId) {
    return `${parts.className}|c:${parts.clientId}`;
  }
  return `${parts.className}|ip:${parts.ip ?? "unknown"}`;
}

function limiterFor(env: Env, className: McpRateLimitClass) {
  switch (className) {
    case "authorization":
      return env.MCP_AUTH_RATE_LIMITER;
    case "token":
      return env.MCP_TOKEN_RATE_LIMITER;
    case "failed_auth":
      return env.MCP_FAILED_AUTH_RATE_LIMITER;
    case "read":
      return env.MCP_READ_RATE_LIMITER;
    case "write":
      return env.MCP_WRITE_RATE_LIMITER;
    case "destructive":
      return env.MCP_DESTRUCTIVE_RATE_LIMITER;
  }
}

export async function assertWithinRateLimit(env: Env, className: McpRateLimitClass, key: string) {
  const { success } = await limiterFor(env, className).limit({ key });
  if (!success) {
    return { ok: false as const };
  }
  return { ok: true as const };
}

export function rateLimitedResponse() {
  return new Response(JSON.stringify({ error: "rate_limited" }), {
    status: 429,
    headers: { "Content-Type": "application/json", "cache-control": "no-store" },
  });
}

export function oauthRateLimitedResponse() {
  return new Response(
    JSON.stringify({
      error: "temporarily_unavailable",
      error_description: "rate limited",
    }),
    {
      status: 429,
      headers: { "Content-Type": "application/json", "cache-control": "no-store" },
    },
  );
}

export function clientIpOf(request: Request) {
  return (
    request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for") ?? undefined
  );
}
