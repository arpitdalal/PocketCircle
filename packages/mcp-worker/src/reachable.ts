import { MCP_RESOURCE_URI } from "@pocketcircle/domain";
import type { Env } from "./env.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isLoopbackHostname(hostname: string) {
  return LOOPBACK_HOSTS.has(hostname);
}

/**
 * Public origin clients used to reach us. Prefer loopback `Host` when it
 * disagrees with `request.url` — local `wrangler` remaps URL to the
 * `custom_domain` route (`mcp.pocketcircle.app`) while Cursor still dials
 * `127.0.0.1:8787`, and OAuth PRM must match the dialed URL.
 *
 * When wrangler also rewrites `Host`, set `MCP_ISSUER` / `MCP_RESOURCE_URI`
 * in `.dev.vars` (see `.dev.vars.example`) and pass that origin into
 * {@link requestWithPublicOrigin}.
 */
export function requestOrigin(request: Request) {
  const url = new URL(request.url);
  const hostHeader = request.headers.get("host");
  if (!hostHeader) {
    return url.origin;
  }
  try {
    const fromHost = new URL(`${url.protocol}//${hostHeader}`);
    if (isLoopbackHostname(fromHost.hostname)) {
      return fromHost.origin;
    }
  } catch {
    // invalid Host — fall through
  }
  return url.origin;
}

/** Rewrite request URL so OAuth AS/PRM metadata matches the public origin. */
export function requestWithPublicOrigin(request: Request, publicOrigin = requestOrigin(request)) {
  const url = new URL(request.url);
  if (url.origin === publicOrigin) {
    return request;
  }
  const originUrl = new URL(publicOrigin);
  const rewritten = new URL(request.url);
  rewritten.protocol = originUrl.protocol;
  rewritten.host = originUrl.host;
  return new Request(rewritten, request);
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
  return env.MCP_ISSUER || origin;
}

/** Origin to advertise when wrangler remapped the request away from dialed URL. */
export function publicWorkerOrigin(env: Pick<Env, "MCP_ISSUER">, request: Request) {
  return env.MCP_ISSUER || requestOrigin(request);
}
