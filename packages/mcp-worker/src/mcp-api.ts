import {
  bearerAuthChallengeResponse,
  McpServer,
  OAuthError,
  OAuthErrorCode,
} from "@modelcontextprotocol/server";
import {
  type McpReadOperation,
  mcpCircleViewSchema,
  mcpCurrentUserViewSchema,
} from "@pocketcircle/domain";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { executeMcpOperation } from "./convex-bridge.js";
import type { Env } from "./env.js";
import { pocketCircleOAuthApi } from "./oauth-options.js";

function hostnameOf(urlString: string | undefined) {
  if (!urlString) {
    return null;
  }
  try {
    return new URL(urlString).hostname;
  } catch {
    return null;
  }
}

const grantPropsSchema = z.object({ mcpGrantId: z.string().min(1) });

async function resolveAuthorizedCaller(env: Env, req?: Request) {
  const authHeader = req?.headers.get("authorization") ?? "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  if (!token) {
    return { ok: false as const, error: "missing_bearer_token" };
  }

  const oauthProvider = env.OAUTH_PROVIDER ?? pocketCircleOAuthApi(env);
  const summary = await oauthProvider.unwrapToken(token);
  if (!summary) {
    return { ok: false as const, error: "invalid_token" };
  }
  const parsedProps = grantPropsSchema.safeParse(summary.grant.props);
  if (!parsedProps.success) {
    return { ok: false as const, error: "missing_grant_props" };
  }
  return {
    ok: true as const,
    value: {
      grantId: parsedProps.data.mcpGrantId,
      effectiveScopes: summary.scope,
    },
  };
}

const listCirclesOutputSchema = z.object({
  circles: z.array(mcpCircleViewSchema),
});

async function handleToolExecution<T>(
  env: Env,
  request: Request | undefined,
  ctxReq: Request | undefined,
  operation: McpReadOperation,
  schema: z.ZodType<T>,
) {
  const caller = await resolveAuthorizedCaller(env, ctxReq ?? request);
  if (!caller.ok) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Authorization failed: ${caller.error}` }],
    };
  }
  const result = await executeMcpOperation(
    env,
    {
      grantId: caller.value.grantId,
      effectiveScopes: caller.value.effectiveScopes,
      operation,
    },
    schema,
  );
  if (!result.ok) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: `PocketCircle error: ${result.error}` }],
    };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result.value) }],
    structuredContent: result.value,
  };
}

export function buildMcpServer(env: Env, request?: Request) {
  const server = new McpServer({ name: "PocketCircle MCP", version: "0.1.0" });

  server.registerTool(
    "get_current_user",
    {
      title: "Get Current User",
      description: "Get the authenticated PocketCircle user's identity",
      inputSchema: z.object({}),
      outputSchema: mcpCurrentUserViewSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (_args, ctx) =>
      handleToolExecution(
        env,
        request,
        ctx.http?.req,
        { kind: "get_current_user" },
        mcpCurrentUserViewSchema,
      ),
  );

  server.registerTool(
    "list_authorized_circles",
    {
      title: "List Authorized Circles",
      description: "List PocketCircle circles authorized by the user for this connection",
      inputSchema: z.object({}),
      outputSchema: listCirclesOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (_args, ctx) =>
      handleToolExecution(
        env,
        request,
        ctx.http?.req,
        { kind: "list_authorized_circles" },
        listCirclesOutputSchema,
      ),
  );

  return server;
}

const READ_TOOL_NAMES = new Set(["get_current_user", "list_authorized_circles"]);

const rpcCallSchema = z.object({
  method: z.string(),
  params: z
    .object({
      name: z.string().optional(),
    })
    .optional(),
});

async function detectReadToolCall(request: Request) {
  const mcpMethod = request.headers.get("mcp-method");
  const mcpName = request.headers.get("mcp-name");
  if (mcpMethod === "tools/call" && mcpName && READ_TOOL_NAMES.has(mcpName)) {
    return true;
  }
  if (request.method.toUpperCase() !== "POST") {
    return false;
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return false;
  }
  try {
    const json: unknown = await request.clone().json();
    const parsed = rpcCallSchema.safeParse(json);
    if (!parsed.success) {
      return false;
    }
    return (
      parsed.data.method === "tools/call" &&
      typeof parsed.data.params?.name === "string" &&
      READ_TOOL_NAMES.has(parsed.data.params.name)
    );
  } catch {
    return false;
  }
}

export function createMcpApiHandler(env: Env) {
  const allowedHostnames = new Set(["mcp.pocketcircle.app", "localhost", "127.0.0.1"]);
  const issuerHost = hostnameOf(env.MCP_ISSUER);
  if (issuerHost) {
    allowedHostnames.add(issuerHost);
  }
  const resourceHost = hostnameOf(env.MCP_RESOURCE_URI);
  if (resourceHost) {
    allowedHostnames.add(resourceHost);
  }

  const allowedOriginHostnames = new Set(allowedHostnames);
  allowedOriginHostnames.add("pocketcircle.app");
  const appOriginHost = hostnameOf(env.APP_ORIGIN);
  if (appOriginHost) {
    allowedOriginHostnames.add(appOriginHost);
  }

  const mcpHandler = createMcpHandler((mcpContext) => buildMcpServer(env, mcpContext.requestInfo), {
    legacy: "reject",
    allowedHostnames: Array.from(allowedHostnames),
    allowedOriginHostnames: Array.from(allowedOriginHostnames),
  });

  return {
    fetch: async (request: Request, envArg: Env, ctx: ExecutionContext) => {
      const isReadTool = await detectReadToolCall(request);
      if (isReadTool) {
        const caller = await resolveAuthorizedCaller(env, request);
        if (caller.ok && !caller.value.effectiveScopes.includes("pocketcircle:read")) {
          return bearerAuthChallengeResponse(
            new OAuthError(
              OAuthErrorCode.InsufficientScope,
              "The access token does not have required scope pocketcircle:read",
            ),
            { requiredScopes: ["pocketcircle:read"] },
          );
        }
      }
      return mcpHandler(request, envArg, ctx);
    },
  } satisfies ExportedHandler<Env>;
}
