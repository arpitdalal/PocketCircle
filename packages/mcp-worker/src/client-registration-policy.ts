import type { ClientRegistrationCallbackResult } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";

/** Cap matches admin provisioning (`client-provisioning.ts`). */
export const MCP_DCR_MAX_REDIRECT_URIS = 20;

/**
 * Schemes that must never be accepted as OAuth redirects, even if listed in
 * `MCP_DCR_ALLOWED_SCHEMES`. Matches Cloudflare workers-oauth-provider’s floor
 * plus common browser pseudo-schemes (see docs/research/mcp-dcr-redirect-uri-policy.md).
 */
const DCR_REDIRECT_SCHEME_DENYLIST = new Set([
  "javascript",
  "data",
  "vbscript",
  "file",
  "mailto",
  "blob",
  "intent",
  "view-source",
]);

/** RFC 3986 scheme: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) */
const SCHEME_NAME = /^[a-z][a-z0-9+.-]*$/;

/**
 * Parse `MCP_DCR_ALLOWED_SCHEMES` (comma-separated, no trailing `:`).
 * Denylisted / invalid tokens are dropped.
 */
export function parseAllowedCustomRedirectSchemes(raw: string | undefined) {
  const allowed = new Set<string>();
  if (!raw) {
    return allowed;
  }
  for (const part of raw.split(",")) {
    const scheme = part.trim().toLowerCase().replace(/:$/, "");
    if (!scheme || DCR_REDIRECT_SCHEME_DENYLIST.has(scheme) || !SCHEME_NAME.test(scheme)) {
      continue;
    }
    allowed.add(scheme);
  }
  return allowed;
}

/**
 * DCR redirect policy (#354 / option C): https, loopback http, or schemes in
 * the configured allowlist. Rejects denylisted / arbitrary non-loopback http.
 */
export function isAllowedDcrRedirectUri(
  value: string,
  allowedCustomSchemes: ReadonlySet<string> = new Set(),
) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (DCR_REDIRECT_SCHEME_DENYLIST.has(scheme)) {
    return false;
  }
  if (url.protocol === "https:") {
    return true;
  }
  if (url.protocol === "http:") {
    const host = url.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  }
  if (!allowedCustomSchemes.has(scheme)) {
    return false;
  }
  // Private-use / custom schemes need a non-empty hierarchical part.
  return url.host.length > 0 || url.pathname.length > 1;
}

function redirectUrisSchema(allowedCustomSchemes: ReadonlySet<string>) {
  return z
    .array(
      z
        .string()
        .max(2_048)
        .refine((value) => isAllowedDcrRedirectUri(value, allowedCustomSchemes)),
    )
    .min(1)
    .max(MCP_DCR_MAX_REDIRECT_URIS);
}

/**
 * Application policy for RFC 7591 DCR before KV write.
 * Library already negotiates auth methods / grants — this only tightens redirects.
 */
export function evaluateClientRegistrationPolicy(
  clientMetadata: Record<string, unknown>,
  options: { allowedCustomSchemes?: ReadonlySet<string> } = {},
) {
  const allowedCustomSchemes = options.allowedCustomSchemes ?? new Set<string>();
  const redirectUris = clientMetadata.redirect_uris;
  const parsed = redirectUrisSchema(allowedCustomSchemes).safeParse(redirectUris);
  if (!parsed.success) {
    return {
      code: "invalid_client_metadata",
      description: `redirect_uris must be https, loopback http, or an allowed custom scheme, and at most ${MCP_DCR_MAX_REDIRECT_URIS} entries`,
      status: 400,
    } satisfies ClientRegistrationCallbackResult;
  }
}
