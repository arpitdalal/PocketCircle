import { AuthorizationError, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import {
  MCP_HANDOFF_ID_REGEX,
  MCP_HANDOFF_TTL_MS,
  type McpHandoffPayload,
  signMcpHandoff,
  verifyMcpRevocation,
} from "@pocketcircle/domain";
import { z } from "zod";
import { MCP_JSON_MAX_BODY_BYTES, readBoundedJson } from "./bounded-body.js";
import { handleClientProvisioning } from "./client-provisioning.js";
import { completeRevocation } from "./convex-bridge.js";
import type { Env } from "./env.js";
import {
  completeHandoffAuthorization,
  denyHandoffAuthorization,
  loadOrResumeHandoff,
  storeHandoffAuthRequest,
} from "./handoff-store.js";
import {
  assertWithinRateLimit,
  clientIpOf,
  rateLimitedResponse,
  unauthenticatedRateLimitKey,
} from "./rate-limit.js";
import { mcpResourceUri, requestOrigin } from "./reachable.js";
import { mcpLog } from "./safe-log.js";

function mcpWorkerHmacSecrets(env: Env) {
  const current = env.MCP_WORKER_HMAC_SECRET;
  const previous = env.MCP_WORKER_HMAC_SECRET_PREVIOUS?.trim();
  return previous && previous !== current ? [current, previous] : [current];
}

const completeRequestSchema = z.object({
  approvalToken: z.string().min(1),
  handoffId: z.string().regex(MCP_HANDOFF_ID_REGEX),
});

const denyRequestSchema = z.object({
  handoffId: z.string().regex(MCP_HANDOFF_ID_REGEX),
});
const revokeRequestSchema = z.object({
  revocationToken: z.string().min(1),
});

function corsHeaders(env: Env) {
  return {
    "access-control-allow-origin": env.APP_ORIGIN,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    "cache-control": "no-store",
  };
}

function jsonResponse(status: number, body: unknown, env: Env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(env) },
  });
}

function clientKindOf(clientId: string) {
  return clientId.startsWith("https://") || clientId.startsWith("http://")
    ? ("cimd" as const)
    : ("static" as const);
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
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return null;
  }
  return readBoundedJson(request, MCP_JSON_MAX_BODY_BYTES);
}

async function handleAuthorizeStart(request: Request, env: Env) {
  let authRequest: AuthRequest;
  try {
    authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      await assertWithinRateLimit(
        env,
        "failed_auth",
        unauthenticatedRateLimitKey({
          className: "failed_auth",
          ip: clientIpOf(request),
        }),
      );
      return authorizationErrorRedirect(error);
    }
    throw error;
  }

  const withinLimit = await assertWithinRateLimit(
    env,
    "authorization",
    unauthenticatedRateLimitKey({
      className: "authorization",
      clientId: authRequest.clientId,
      ip: clientIpOf(request),
    }),
  );
  if (!withinLimit.ok) {
    mcpLog({
      event: "authorize_start",
      outcome: "rate_limited",
      status: 429,
      toolClass: "authorization",
    });
    return rateLimitedResponse();
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

  const origin = requestOrigin(request);
  const expectedResource = mcpResourceUri(env, origin);
  const requestedResource = Array.isArray(authRequest.resource)
    ? authRequest.resource[0]
    : authRequest.resource;
  if (requestedResource && requestedResource !== expectedResource) {
    return authorizationErrorRedirect(
      new AuthorizationError("invalid_target", {
        description: "Unknown or invalid target resource",
        redirectUri: authRequest.redirectUri,
        state: authRequest.state,
        issuer: authRequest.issuer,
      }),
    );
  }

  const handoffId = crypto.randomUUID();
  const now = Date.now();
  const payload: McpHandoffPayload = {
    v: 1,
    handoffId,
    clientId: authRequest.clientId,
    clientKind: clientKindOf(authRequest.clientId),
    redirectUri: authRequest.redirectUri,
    resource: requestedResource ?? expectedResource,
    scopes: authRequest.scope,
    clientName: client.clientName,
    clientUri: client.clientUri,
    logoUri: client.logoUri,
    iat: now,
    exp: now + MCP_HANDOFF_TTL_MS,
  };
  const handoff = await signMcpHandoff(payload, env.MCP_WORKER_HMAC_SECRET);
  await storeHandoffAuthRequest(env.HANDOFF_STORE, handoffId, authRequest, handoff);

  const consentUrl = new URL("/mcp/authorize", env.APP_ORIGIN);
  consentUrl.searchParams.set("handoffId", handoffId);
  return Response.redirect(consentUrl.toString(), 302);
}

async function handleLoadHandoff(request: Request, env: Env) {
  const handoffId = new URL(request.url).searchParams.get("id");
  if (!handoffId || !MCP_HANDOFF_ID_REGEX.test(handoffId)) {
    return jsonResponse(400, { error: "missing_handoff_id" }, env);
  }
  const result = await loadOrResumeHandoff(env.HANDOFF_STORE, handoffId, requestOrigin(request));
  if (result.kind === "handoff") {
    return jsonResponse(200, { handoff: result.handoff }, env);
  }
  if (result.kind === "completed") {
    return jsonResponse(200, { redirectTo: result.redirectTo }, env);
  }
  if (result.kind === "failed") {
    return jsonResponse(result.retryable ? 503 : 400, result, env);
  }
  return jsonResponse(400, { error: "handoff_expired_or_replayed" }, env);
}

async function handleComplete(request: Request, env: Env) {
  const parsed = completeRequestSchema.safeParse(await readBody(request));
  if (!parsed.success) {
    return jsonResponse(400, { error: "missing_authorization_completion" }, env);
  }
  const { approvalToken, handoffId } = parsed.data;

  const completion = await completeHandoffAuthorization(
    env.HANDOFF_STORE,
    handoffId,
    approvalToken,
    requestOrigin(request),
  );
  if (completion.kind === "completed") {
    return jsonResponse(200, { redirectTo: completion.redirectTo }, env);
  }
  const error =
    completion.kind === "expired"
      ? "handoff_expired_or_replayed"
      : completion.kind === "failed"
        ? completion.error
        : completion.kind;
  const retryable = completion.kind === "failed" && completion.retryable;
  return jsonResponse(retryable ? 503 : 400, { error, retryable }, env);
}

async function handleDeny(request: Request, env: Env) {
  const parsed = denyRequestSchema.safeParse(await readBody(request));
  if (!parsed.success) {
    return jsonResponse(400, { error: "missing_handoff_id" }, env);
  }
  const { handoffId } = parsed.data;

  const denied = await denyHandoffAuthorization(env.HANDOFF_STORE, handoffId);
  if (!denied.ok) {
    return jsonResponse(400, { error: denied.error }, env);
  }

  return jsonResponse(200, { redirectTo: denied.redirectTo }, env);
}

/** Convex has already failed closed; this removes the complete linked Worker grant. */
async function handleRevoke(request: Request, env: Env) {
  const parsed = revokeRequestSchema.safeParse(await readBody(request));
  if (!parsed.success) {
    return jsonResponse(400, { error: "missing_revocation_token" }, env);
  }
  const payload = await verifyMcpRevocation(parsed.data.revocationToken, mcpWorkerHmacSecrets(env));
  if (!payload) {
    return jsonResponse(400, { error: "invalid_revocation_token" }, env);
  }

  try {
    await env.OAUTH_PROVIDER.revokeGrant(payload.workerGrantId, payload.principalId);
  } catch {
    return jsonResponse(503, { error: "worker_cleanup_unavailable", retryable: true }, env);
  }

  const completed = await completeRevocation(env, {
    grantId: payload.grantId,
    workerGrantId: payload.workerGrantId,
    principalId: payload.principalId,
  });
  if (!completed.ok) {
    return jsonResponse(
      completed.retryable ? 503 : 400,
      { error: completed.error, retryable: completed.retryable },
      env,
    );
  }
  return jsonResponse(200, { revoked: true }, env);
}

export const defaultHandler = {
  async fetch(request: Request, env: Env) {
    const provisioning = await handleClientProvisioning(request, env);
    if (provisioning) {
      return provisioning;
    }
    const url = new URL(request.url);
    const browserEndpoint =
      url.pathname === "/authorize/complete" ||
      url.pathname === "/authorize/deny" ||
      url.pathname === "/authorize/handoff" ||
      url.pathname === "/revoke";
    if (browserEndpoint && request.headers.get("origin") !== env.APP_ORIGIN) {
      return new Response("Forbidden", { status: 403, headers: { "cache-control": "no-store" } });
    }
    if (browserEndpoint && request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }
    if (url.pathname === "/authorize" && request.method === "GET") {
      return handleAuthorizeStart(request, env);
    }
    if (url.pathname === "/authorize/handoff" && request.method === "GET") {
      return handleLoadHandoff(request, env);
    }
    if (url.pathname === "/authorize/complete" && request.method === "POST") {
      return handleComplete(request, env);
    }
    if (url.pathname === "/authorize/deny" && request.method === "POST") {
      return handleDeny(request, env);
    }
    if (url.pathname === "/revoke" && request.method === "POST") {
      return handleRevoke(request, env);
    }
    // Service cleanup from Convex reconciliation — HMAC token is the authn (#330).
    if (url.pathname === "/internal/revoke" && request.method === "POST") {
      return handleRevoke(request, env);
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
