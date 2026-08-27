import OAuthProvider, {
  OAuthError,
  type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import {
  MCP_ACCESS_TOKEN_TTL_SECONDS,
  MCP_ISSUER,
  MCP_REFRESH_TOKEN_TTL_SECONDS,
  MCP_RESOURCE_URI,
  MCP_SCOPES,
} from "@pocketcircle/domain";
import { z } from "zod";
import { defaultHandler } from "./authorize.js";
import { activateGrant, validateGrant } from "./convex-bridge.js";
import type { Env } from "./env.js";
import { mcpApiHandler } from "./mcp-api.js";

const grantPropsSchema = z.object({ mcpGrantId: z.string().min(1) });

function resourceUri(env: Env) {
  return env.MCP_RESOURCE_URI ?? MCP_RESOURCE_URI;
}

/**
 * Builds OAuthProvider options closed over the live Worker `env` so token-
 * exchange callbacks can call Convex. Shared by the Worker entry and tests
 * (`getOAuthApi`) — `tokenExchangeCallback` has no `env` argument.
 */
export function oauthProviderOptions(env: Env): OAuthProviderOptions<Env> {
  const resource = resourceUri(env);
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
      authorization_servers: [MCP_ISSUER],
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

export function createOAuthProvider(env: Env) {
  return new OAuthProvider(oauthProviderOptions(env));
}
