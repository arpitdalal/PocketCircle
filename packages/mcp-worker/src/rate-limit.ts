import { sha256Hex } from "@pocketcircle/domain";
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
 * Stable authenticated material: User + client + grant + tool-class.
 * Hashed before `limit()` — Cloudflare keys max out at 64 bytes.
 */
export function authenticatedRateLimitMaterial(parts: {
  userId: string;
  clientId: string;
  grantId: string;
  toolClass: McpToolClass;
}) {
  return `u:${parts.userId}|c:${parts.clientId}|g:${parts.grantId}|t:${parts.toolClass}`;
}

/**
 * Pre-auth material: always include IP; include client when known.
 * Hashing happens in assertWithinRateLimit.
 */
export function unauthenticatedRateLimitMaterial(parts: {
  className: Exclude<McpRateLimitClass, McpToolClass>;
  clientId?: string;
  ip?: string;
}) {
  return `${parts.className}|c:${parts.clientId ?? "-"}|ip:${parts.ip ?? "unknown"}`;
}

/**
 * IP-only pre-auth material — caps total attempts from one IP even when
 * attacker-controlled clientIds rotate composite buckets.
 */
export function unauthenticatedIpRateLimitMaterial(parts: {
  className: Exclude<McpRateLimitClass, McpToolClass>;
  ip?: string;
}) {
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

/** Cloudflare Rate Limiting keys are capped at 64 bytes — always hash. */
export async function assertWithinRateLimit(
  env: Env,
  className: McpRateLimitClass,
  material: string,
) {
  const key = await sha256Hex(material);
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

const FAILED_AUTH_BLOCK_PREFIX = "https://mcp.pocketcircle.internal/rl/failed-auth/";

function failedAuthBlockRequest(ip: string) {
  return new Request(`${FAILED_AUTH_BLOCK_PREFIX}${encodeURIComponent(ip)}`);
}

/** Cache-API short block so already-throttled IPs skip OAuth/KV work. */
export async function isFailedAuthBlocked(ip: string) {
  return Boolean(await caches.default.match(failedAuthBlockRequest(ip)));
}

export async function markFailedAuthBlocked(ip: string) {
  await caches.default.put(
    failedAuthBlockRequest(ip),
    new Response("1", { headers: { "Cache-Control": "max-age=60" } }),
  );
}
