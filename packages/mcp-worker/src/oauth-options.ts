import OAuthProvider, {
  getOAuthApi,
  OAuthError,
  type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import {
  MCP_ACCESS_TOKEN_TTL_SECONDS,
  MCP_REFRESH_TOKEN_TTL_SECONDS,
  MCP_SCOPES,
} from "@pocketcircle/domain";
import { z } from "zod";
import { activateGrant, validateGrant } from "./convex-bridge.js";
import type { Env } from "./env.js";
import { createMcpApiHandler } from "./mcp-api.js";
import { mcpAuthorizationServerIssuer, mcpResourceUri } from "./reachable.js";

const grantPropsSchema = z.object({ mcpGrantId: z.string().min(1) });

async function rejectFailedActivation(
  env: Env,
  options: { grantId: string; userId: string },
  retryable: boolean,
) {
  if (retryable) {
    throw new OAuthError("temporarily_unavailable", {
      description: "PocketCircle grant activation is temporarily unavailable",
      statusCode: 503,
      headers: { "Retry-After": "2" },
    });
  }
  try {
    await env.OAUTH_PROVIDER.revokeGrant(options.grantId, options.userId);
  } catch {
    throw new OAuthError("temporarily_unavailable", {
      description: "PocketCircle grant cleanup is temporarily unavailable",
      statusCode: 503,
      headers: { "Retry-After": "2" },
    });
  }
  throw new OAuthError("invalid_grant", {
    description: "Failed to activate PocketCircle grant",
  });
}

/**
 * Builds OAuthProvider options closed over the live Worker `env` so token-
 * exchange callbacks can call Convex. Shared by the Worker entry and tests
 * (`getOAuthApi`) — `tokenExchangeCallback` has no `env` argument.
 */
export function oauthProviderOptions(
  env: Env,
  defaultHandler: ExportedHandler<Env>,
  origin?: string,
) {
  const resource = mcpResourceUri(env, origin);
  const issuer = mcpAuthorizationServerIssuer(env, origin);
  const isHttpsIssuer = typeof issuer === "string" && issuer.startsWith("https://");
  return {
    apiRoute: "/mcp",
    apiHandler: createMcpApiHandler(env),
    defaultHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    // No clientRegistrationEndpoint — DCR stays disabled (#318).
    clientIdMetadataDocumentEnabled: true,
    allowImplicitFlow: false,
    allowPlainPKCE: false,
    accessTokenTTL: MCP_ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTTL: MCP_REFRESH_TOKEN_TTL_SECONDS,
    scopesSupported: [...MCP_SCOPES],
    resourceMetadata: {
      resource,
      ...(isHttpsIssuer ? { authorization_servers: [issuer] } : {}),
      scopes_supported: [...MCP_SCOPES],
      bearer_methods_supported: ["header"],
      resource_name: "PocketCircle",
    },

    tokenExchangeCallback: async (options) => {
      const props = grantPropsSchema.safeParse(options.props);
      if (!props.success) {
        throw new OAuthError("invalid_grant", {
          description: "Missing PocketCircle grant reference",
        });
      }
      const { mcpGrantId } = props.data;

      if (options.grantType === "authorization_code") {
        const result = await activateGrant(env, {
          grantId: mcpGrantId,
          workerGrantId: options.grantId,
          principalId: options.userId,
        });
        if (!result.ok) {
          await rejectFailedActivation(env, options, result.retryable);
        }
        return;
      }

      if (options.grantType === "refresh_token") {
        const result = await validateGrant(env, {
          grantId: mcpGrantId,
          principalId: options.userId,
          requestedScopes: options.requestedScope,
        });
        if (!result.ok) {
          if (result.retryable) {
            throw new OAuthError("temporarily_unavailable", {
              description: "PocketCircle grant validation is temporarily unavailable",
              statusCode: 503,
              headers: { "Retry-After": "2" },
            });
          }
          // Decoupled Worker grant: Convex already fails closed — drop the Worker grant (#330).
          try {
            await env.OAUTH_PROVIDER.revokeGrant(options.grantId, options.userId);
          } catch {
            console.error(
              "[mcp-reconcile] orphan worker grant purge failed",
              options.grantId,
              mcpGrantId,
            );
            throw new OAuthError("temporarily_unavailable", {
              description: "PocketCircle grant cleanup is temporarily unavailable",
              statusCode: 503,
              headers: { "Retry-After": "2" },
            });
          }
          throw new OAuthError("invalid_grant", {
            description: "PocketCircle grant no longer valid",
          });
        }
      }
    },
  } satisfies OAuthProviderOptions<Env>;
}

export function createOAuthProvider(
  env: Env,
  defaultHandler: ExportedHandler<Env>,
  origin?: string,
) {
  return new OAuthProvider(oauthProviderOptions(env, defaultHandler, origin));
}

const oauthApiHandler = {
  fetch() {
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

export function pocketCircleOAuthApi(env: Env, origin?: string) {
  return getOAuthApi(oauthProviderOptions(env, oauthApiHandler, origin), env);
}
