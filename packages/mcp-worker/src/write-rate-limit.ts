import type { Env } from "./env.js";

export async function assertMcpWriteWithinRateLimit(env: Env, grantId: string) {
  const { success } = await env.MCP_WRITE_RATE_LIMITER.limit({ key: grantId });
  if (!success) {
    return { ok: false as const };
  }
  return { ok: true as const };
}
