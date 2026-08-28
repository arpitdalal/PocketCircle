import OAuthProvider, {
  OAuthError,
  type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import {
  MCP_ACCESS_TOKEN_TTL_SECONDS,
  MCP_REFRESH_TOKEN_TTL_SECONDS,
  MCP_SCOPES,
} from "@pocketcircle/domain";
import { z } from "zod";
import { defaultHandler } from "./authorize.js";
import { activateGrant, validateGrant } from "./convex-bridge.js";
import type { Env } from "./env.js";
import { mcpApiHandler } from "./mcp-api.js";
import { mcpAuthorizationServerIssuer, mcpResourceUri } from "./reachable.js";

const grantPropsSchema = z.object({ mcpGrantId: z.string().min(1) });

/**
 * Builds OAuthProvider options closed over the live Worker `env` so token-
 * exchange callbacks can call Convex. Shared by the Worker entry and tests
 * (`getOAuthApi`) — `tokenExchangeCallback` has no `env` argument.
 */
export function oauthProviderOptions(env: Env, origin?: string): OAuthProviderOptions<Env> {
  const resource = mcpResourceUri(env, origin);
  const issuer = mcpAuthorizationServerIssuer(env, origin);
  return {
    apiRoute: "/mcp",
    apiHandler: mcpApiHandler,
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
      ...(issuer ? { authorization_servers: [issuer] } : {}),
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
          throw new OAuthError("invalid_grant", {
            description: "Failed to activate PocketCircle grant",
          });
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
          throw new OAuthError("invalid_grant", {
            description: "PocketCircle grant no longer valid",
          });
        }
      }
    },
  };
}

export function createOAuthProvider(env: Env, origin?: string) {
  return new OAuthProvider(oauthProviderOptions(env, origin));
}
