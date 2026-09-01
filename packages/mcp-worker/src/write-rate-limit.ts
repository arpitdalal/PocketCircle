import type { Env } from "./env.js";

/** Tighter write throttle per active MCP grant (hosted-mcp-server.md). */
const WRITE_WINDOW_MS = 60_000;
const WRITE_MAX_PER_GRANT_PER_WINDOW = 30;

function writeRateLimitKey(grantId: string, window: number) {
  return `mcp:write:${grantId}:${window}`;
}

export async function assertMcpWriteWithinRateLimit(env: Env, grantId: string) {
  const window = Math.floor(Date.now() / WRITE_WINDOW_MS);
  const key = writeRateLimitKey(grantId, window);
  const raw = await env.OAUTH_KV.get(key);
  const count = raw === null ? 0 : Number(raw);
  if (!Number.isFinite(count) || count >= WRITE_MAX_PER_GRANT_PER_WINDOW) {
    return { ok: false as const };
  }
  await env.OAUTH_KV.put(key, String(count + 1), {
    expirationTtl: Math.ceil((WRITE_WINDOW_MS * 2) / 1000),
  });
  return { ok: true as const };
}
