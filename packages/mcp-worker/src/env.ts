import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { HandoffStore } from "./handoff-store.js";

/**
 * Worker bindings. Declared on `Cloudflare.Env` so `getOAuthApi` / vitest pool
 * types (defaulting to `Cloudflare.Env`) match application code.
 */
declare global {
  namespace Cloudflare {
    interface Env {
      OAUTH_KV: KVNamespace;
      HANDOFF_STORE: DurableObjectNamespace<HandoffStore>;
      OAUTH_PROVIDER: OAuthHelpers;
      MCP_WRITE_RATE_LIMITER: RateLimit;
      APP_ORIGIN: string;
      CONVEX_SITE_URL: string;
      MCP_CLIENT_PROVISIONING_TOKEN?: string;
      MCP_WORKER_HMAC_SECRET: string;
      /** Optional prior HMAC during rotation — verify revocation/handoff with both. */
      MCP_WORKER_HMAC_SECRET_PREVIOUS?: string;
      MCP_WORKER_SIGNING_PRIVATE_JWK: string;
      MCP_RESOURCE_URI?: string;
      MCP_ISSUER?: string;
    }
  }
}

export type Env = Cloudflare.Env;
