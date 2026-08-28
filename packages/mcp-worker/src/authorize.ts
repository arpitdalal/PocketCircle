import { AuthorizationError, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import {
  MCP_HANDOFF_TTL_MS,
  MCP_RESOURCE_URI,
  type McpHandoffPayload,
  signMcpHandoff,
} from "@pocketcircle/domain";
import { redeemApproval } from "./convex-bridge.js";
import type { Env } from "./env.js";
import { consumeHandoffAuthRequest, storeHandoffAuthRequest } from "./handoff-store.js";

function corsHeaders(env: Env) {
  return {
    "access-control-allow-origin": env.APP_ORIGIN,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
  };
}

function jsonResponse(status: number, body: unknown, env: Env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(env) },
  });
}

/** Build the OAuth error redirect URL without navigating — SPA assigns it. */
function accessDeniedRedirectTo(authRequest: AuthRequest, description: string) {
  const redirect = new URL(authRequest.redirectUri);
  redirect.searchParams.set("error", "access_denied");
  redirect.searchParams.set("error_description", description);
  if (authRequest.state) {
    redirect.searchParams.set("state", authRequest.state);
  }
  if (authRequest.issuer) {
    redirect.searchParams.set("iss", authRequest.issuer);
  }
  return redirect.toString();
}

function clientKindOf(clientId: string) {
  return clientId.startsWith("https://") || clientId.startsWith("http://")
    ? ("cimd" as const)
    : ("static" as const);
}

function resourceOf(authRequest: AuthRequest, env: Env) {
  const requested = Array.isArray(authRequest.resource)
    ? authRequest.resource[0]
    : authRequest.resource;
  return requested ?? env.MCP_RESOURCE_URI ?? MCP_RESOURCE_URI;
}

/** Safe OAuth error redirect — only when `redirectUri` was validated by parseAuthRequest. */
function authorizationErrorRedirect(error: AuthorizationError) {
  if (!error.redirectUri) {
    return new Response(error.description, { status: 400 });
  }
  const redirect = new URL(error.redirectUri);
  redirect.searchParams.set("error", error.code);
  redirect.searchParams.set("error_description", error.description);
  if (error.state) {
    redirect.searchParams.set("state", error.state);
  }
  if (error.issuer) {
    redirect.searchParams.set("iss", error.issuer);
  }
  return Response.redirect(redirect.toString(), 302);
}

async function readBody(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return request.json();
  }
  const form = await request.formData();
  return Object.fromEntries(form.entries());
}

function bodyRecord(body: unknown) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {};
  }
  return Object.fromEntries(Object.entries(body));
}

function stringField(body: Record<string, unknown>, key: string) {
  const value = body[key];
  return typeof value === "string" ? value : null;
}

async function handleAuthorizeStart(request: Request, env: Env) {
  let authRequest: AuthRequest;
  try {
    authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return authorizationErrorRedirect(error);
    }
    throw error;
  }

  const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
  if (!client) {
    return authorizationErrorRedirect(
      new AuthorizationError("access_denied", {
        description: "Unknown client",
        redirectUri: authRequest.redirectUri,
        state: authRequest.state,
        issuer: authRequest.issuer,
      }),
    );
  }

  const handoffId = crypto.randomUUID();
  await storeHandoffAuthRequest(env.HANDOFF_STORE, handoffId, authRequest);

  const now = Date.now();
  const payload: McpHandoffPayload = {
    v: 1,
    handoffId,
    clientId: authRequest.clientId,
    clientKind: clientKindOf(authRequest.clientId),
    redirectUri: authRequest.redirectUri,
    resource: resourceOf(authRequest, env),
    scopes: authRequest.scope,
    clientName: client.clientName,
    clientUri: client.clientUri,
    logoUri: client.logoUri,
    iat: now,
    exp: now + MCP_HANDOFF_TTL_MS,
  };
  const handoff = await signMcpHandoff(payload, env.MCP_WORKER_HMAC_SECRET);

  const consentUrl = new URL("/mcp/authorize", env.APP_ORIGIN);
  consentUrl.searchParams.set("handoff", handoff);
  return Response.redirect(consentUrl.toString(), 302);
}

async function consumeHandoff(env: Env, handoffId: string) {
  return consumeHandoffAuthRequest(env.HANDOFF_STORE, handoffId);
}

async function handleComplete(request: Request, env: Env) {
  const approvalToken = stringField(bodyRecord(await readBody(request)), "approvalToken");
  if (!approvalToken) {
    return jsonResponse(400, { error: "missing_approval_token" }, env);
  }

  const redeemed = await redeemApproval(env, approvalToken);
  if (!redeemed.ok) {
    return jsonResponse(400, { error: redeemed.error }, env);
  }
  const grant = redeemed.value;

  const authRequest = await consumeHandoff(env, grant.handoffId);
  if (!authRequest) {
    return jsonResponse(400, { error: "handoff_expired_or_replayed" }, env);
  }
  if (authRequest.clientId !== grant.clientId || authRequest.redirectUri !== grant.redirectUri) {
    return jsonResponse(400, { error: "handoff_grant_mismatch" }, env);
  }
  const expectedResource = resourceOf(authRequest, env);
  if (grant.resource !== expectedResource) {
    return jsonResponse(400, { error: "handoff_grant_mismatch" }, env);
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: authRequest,
    userId: grant.principalId,
    metadata: { pocketCircleGrantId: grant.grantId },
    scope: grant.scopes,
    props: { mcpGrantId: grant.grantId },
  });

  // SPA receives redirectTo via JSON (approval token never lands in a URL).
  return jsonResponse(200, { redirectTo }, env);
}

async function handleDeny(request: Request, env: Env) {
  const handoffId = stringField(bodyRecord(await readBody(request)), "handoffId");
  if (!handoffId) {
    return jsonResponse(400, { error: "missing_handoff_id" }, env);
  }

  const authRequest = await consumeHandoff(env, handoffId);
  if (!authRequest) {
    return jsonResponse(400, { error: "handoff_expired_or_replayed" }, env);
  }

  return jsonResponse(
    200,
    {
      redirectTo: accessDeniedRedirectTo(authRequest, "User denied the authorization request"),
    },
    env,
  );
}

export const defaultHandler = {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (
      (url.pathname === "/authorize/complete" || url.pathname === "/authorize/deny") &&
      request.method === "OPTIONS"
    ) {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }
    if (url.pathname === "/authorize" && request.method === "GET") {
      return handleAuthorizeStart(request, env);
    }
    if (url.pathname === "/authorize/complete" && request.method === "POST") {
      return handleComplete(request, env);
    }
    if (url.pathname === "/authorize/deny" && request.method === "POST") {
      return handleDeny(request, env);
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
