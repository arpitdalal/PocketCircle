import { MCP_RESOURCE_URI } from "@pocketcircle/domain";
import type { Env } from "./env.js";

export function requestOrigin(request: Request) {
  return new URL(request.url).origin;
}

/**
 * Resource identifier clients bind tokens to. Explicit env wins; otherwise the
 * origin this request actually reached, so workers.dev and the custom domain
 * cannot advertise different, unrouted resources.
 */
export function mcpResourceUri(env: Env, origin?: string) {
  if (env.MCP_RESOURCE_URI) {
    return env.MCP_RESOURCE_URI;
  }
  if (origin) {
    return `${origin}/mcp`;
  }
  return MCP_RESOURCE_URI;
}

export function mcpAuthorizationServerIssuer(env: Env, origin?: string) {
  return env.MCP_ISSUER ?? origin;
}
