import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { HandoffStore } from "./handoff-store.js";

/**
 * Worker bindings. Declared on `Cloudflare.Env` so `getOAuthApi` / vitest pool
 * types (defaulting to `Cloudflare.Env`) match application code.
 *
 * OAuth KV is bound as `POCKET_CIRCLE_OAUTH_KV` (account-scoped title). The
 * Cloudflare OAuth provider still hard-requires `env.OAUTH_KV` — use
 * {@link withWorkersOauthKv} at the provider boundary.
 */
declare global {
  namespace Cloudflare {
    interface Env {
      POCKET_CIRCLE_OAUTH_KV: KVNamespace;
      HANDOFF_STORE: DurableObjectNamespace<HandoffStore>;
      OAUTH_PROVIDER: OAuthHelpers;
      MCP_AUTH_RATE_LIMITER: RateLimit;
      MCP_TOKEN_RATE_LIMITER: RateLimit;
      MCP_FAILED_AUTH_RATE_LIMITER: RateLimit;
      MCP_DCR_RATE_LIMITER: RateLimit;
      MCP_READ_RATE_LIMITER: RateLimit;
      MCP_WRITE_RATE_LIMITER: RateLimit;
      MCP_DESTRUCTIVE_RATE_LIMITER: RateLimit;
      APP_ORIGIN: string;
      CONVEX_SITE_URL: string;
      MCP_CLIENT_PROVISIONING_TOKEN?: string;
      MCP_WORKER_HMAC_SECRET: string;
      /** Optional prior HMAC during rotation — verify revocation/handoff with both. */
      MCP_WORKER_HMAC_SECRET_PREVIOUS?: string;
      MCP_WORKER_SIGNING_PRIVATE_JWK: string;
      MCP_RESOURCE_URI?: string;
      MCP_ISSUER?: string;
      /**
       * Comma-separated private-use redirect schemes for DCR (e.g. `cursor,vscode`).
       * https + loopback http always allowed; denylisted schemes never are.
       */
      MCP_DCR_ALLOWED_SCHEMES?: string;
    }
  }
}

export type Env = Cloudflare.Env;

/** Env shape expected by `@cloudflare/workers-oauth-provider` (fixed `OAUTH_KV` name). */
export type OAuthEnv = Env & { OAUTH_KV: KVNamespace };

/**
 * Alias the account-scoped KV binding to the name the OAuth library hardcodes.
 * Mutates `env` in place so OAuthProvider can still inject `OAUTH_PROVIDER` onto
 * the same object Workers/tests pass through `fetch`.
 */
export function withWorkersOauthKv(env: Env) {
  return Object.assign(env, { OAUTH_KV: env.POCKET_CIRCLE_OAUTH_KV });
}
