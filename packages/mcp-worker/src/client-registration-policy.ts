import type { ClientRegistrationCallbackResult } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";

/** Cap matches admin provisioning (`client-provisioning.ts`). */
export const MCP_DCR_MAX_REDIRECT_URIS = 20;

/**
 * DCR redirect policy (#354): https + loopback http only.
 * Rejects javascript/data/etc and arbitrary non-loopback http hosts.
 */
export function isAllowedDcrRedirectUri(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === "https:") {
    return true;
  }
  if (url.protocol !== "http:") {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

const redirectUrisSchema = z
  .array(z.string().max(2_048).refine(isAllowedDcrRedirectUri))
  .min(1)
  .max(MCP_DCR_MAX_REDIRECT_URIS);

/**
 * Application policy for RFC 7591 DCR before KV write.
 * Library already negotiates auth methods / grants — this only tightens redirects.
 */
export function evaluateClientRegistrationPolicy(clientMetadata: Record<string, unknown>) {
  const redirectUris = clientMetadata.redirect_uris;
  const parsed = redirectUrisSchema.safeParse(redirectUris);
  if (!parsed.success) {
    return {
      code: "invalid_client_metadata",
      description: `redirect_uris must be https or loopback http, and at most ${MCP_DCR_MAX_REDIRECT_URIS} entries`,
      status: 400,
    } satisfies ClientRegistrationCallbackResult;
  }
}
