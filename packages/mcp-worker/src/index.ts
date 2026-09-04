import { defaultHandler } from "./authorize.js";
import {
  assertClonedBodyWithinLimit,
  MCP_JSON_MAX_BODY_BYTES,
  MCP_PROVISIONING_MAX_BODY_BYTES,
  MCP_TOKEN_MAX_BODY_BYTES,
} from "./bounded-body.js";
import { type Env, withWorkersOauthKv } from "./env.js";
import { createOAuthProvider } from "./oauth-options.js";
import {
  assertWithinRateLimit,
  clientIpOf,
  isFailedAuthBlocked,
  markFailedAuthBlocked,
  oauthRateLimitedResponse,
  rateLimitedResponse,
  unauthenticatedIpRateLimitMaterial,
  unauthenticatedRateLimitMaterial,
} from "./rate-limit.js";
import { publicWorkerOrigin, requestWithPublicOrigin } from "./reachable.js";
import { mcpLog } from "./safe-log.js";

export { HandoffStore } from "./handoff-store.js";

function clientIdFromTokenForm(request: Request) {
  return request
    .clone()
    .formData()
    .then((form) => {
      const clientId = form.get("client_id");
      return typeof clientId === "string" && clientId.length > 0 ? clientId : undefined;
    })
    .catch(() => undefined);
}

async function enforceFailedAuthLimit(
  env: Env,
  request: Request,
  options: { event: string; oauthShape: boolean },
) {
  const ip = clientIpOf(request) ?? "unknown";
  const withinFailedAuth = await assertWithinRateLimit(
    env,
    "failed_auth",
    unauthenticatedRateLimitMaterial({
      className: "failed_auth",
      ip,
    }),
  );
  if (!withinFailedAuth.ok) {
    await markFailedAuthBlocked(ip);
    mcpLog({
      event: options.event,
      outcome: "rate_limited",
      status: 429,
      toolClass: "failed_auth",
    });
    return options.oauthShape ? oauthRateLimitedResponse() : rateLimitedResponse();
  }
  return null;
}

function payloadTooLargeJson() {
  return new Response(JSON.stringify({ error: "payload_too_large" }), {
    status: 413,
    headers: { "Content-Type": "application/json", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Per-request provider so tokenExchangeCallback closes over live `env`
    // (the callback API has no env arg). Alias POCKET_CIRCLE_OAUTH_KV → OAUTH_KV
    // for @cloudflare/workers-oauth-provider, which hardcodes that binding name.
    // Rewrite URL when wrangler remapped custom_domain but client dialed loopback.
    // Prefer MCP_ISSUER — local wrangler also rewrites Host to the custom domain.
    const publicOrigin = publicWorkerOrigin(env, request);
    const publicRequest = requestWithPublicOrigin(request, publicOrigin);
    const oauthEnv = withWorkersOauthKv(env);
    const provider = createOAuthProvider(env, defaultHandler, publicOrigin);
    const url = new URL(publicRequest.url);
    const ip = clientIpOf(request) ?? "unknown";

    // Skip OAuth/KV once failed-auth already throttled this IP.
    const failedAuthPreBlock =
      url.pathname === "/mcp" ||
      url.pathname === "/token" ||
      (url.pathname === "/authorize" && request.method === "GET");
    if (failedAuthPreBlock && (await isFailedAuthBlocked(ip))) {
      const event =
        url.pathname === "/token"
          ? "token_exchange"
          : url.pathname === "/authorize"
            ? "authorize_start"
            : "mcp_request";
      mcpLog({
        event,
        outcome: "rate_limited",
        status: 429,
        toolClass: "failed_auth",
      });
      return url.pathname === "/token" ? oauthRateLimitedResponse() : rateLimitedResponse();
    }

    // Bound /mcp before OAuth dispatch so oversized bodies never spend KV auth work.
    if (url.pathname === "/mcp" && publicRequest.method === "POST") {
      if (!(await assertClonedBodyWithinLimit(publicRequest, MCP_JSON_MAX_BODY_BYTES))) {
        return payloadTooLargeJson();
      }
    }

    if (url.pathname === "/token" && publicRequest.method === "POST") {
      if (!(await assertClonedBodyWithinLimit(publicRequest, MCP_TOKEN_MAX_BODY_BYTES))) {
        return new Response(
          JSON.stringify({
            error: "invalid_request",
            error_description: "payload too large",
          }),
          {
            status: 413,
            headers: { "Content-Type": "application/json", "cache-control": "no-store" },
          },
        );
      }
      // IP-only gate first so rotating client_id cannot bypass the token cap.
      const withinIp = await assertWithinRateLimit(
        env,
        "token",
        unauthenticatedIpRateLimitMaterial({ className: "token", ip }),
      );
      if (!withinIp.ok) {
        mcpLog({
          event: "token_exchange",
          outcome: "rate_limited",
          status: 429,
          toolClass: "token",
        });
        return oauthRateLimitedResponse();
      }
      const clientId = await clientIdFromTokenForm(publicRequest);
      const withinLimit = await assertWithinRateLimit(
        env,
        "token",
        unauthenticatedRateLimitMaterial({
          className: "token",
          clientId,
          ip,
        }),
      );
      if (!withinLimit.ok) {
        mcpLog({
          event: "token_exchange",
          outcome: "rate_limited",
          status: 429,
          toolClass: "token",
        });
        return oauthRateLimitedResponse();
      }
      const response = await provider.fetch(publicRequest, oauthEnv, ctx);
      if (response.status === 400 || response.status === 401) {
        const limited = await enforceFailedAuthLimit(env, publicRequest, {
          event: "token_exchange",
          oauthShape: true,
        });
        if (limited) {
          return limited;
        }
      }
      return response;
    }

    // DCR burns Free KV writes — bind body + IP gate before provider/KV work (#354).
    if (url.pathname === "/oauth/register" && publicRequest.method === "POST") {
      if (!(await assertClonedBodyWithinLimit(publicRequest, MCP_PROVISIONING_MAX_BODY_BYTES))) {
        return new Response(
          JSON.stringify({
            error: "invalid_client_metadata",
            error_description: "payload too large",
          }),
          {
            status: 413,
            headers: { "Content-Type": "application/json", "cache-control": "no-store" },
          },
        );
      }
      const withinIp = await assertWithinRateLimit(
        env,
        "client_registration",
        unauthenticatedIpRateLimitMaterial({ className: "client_registration", ip }),
      );
      if (!withinIp.ok) {
        mcpLog({
          event: "client_registration",
          outcome: "rate_limited",
          status: 429,
          toolClass: "client_registration",
        });
        return oauthRateLimitedResponse();
      }
    }

    const response = await provider.fetch(publicRequest, oauthEnv, ctx);
    // Count only presented-but-invalid credentials — bare challenges start OAuth discovery.
    if (
      url.pathname === "/mcp" &&
      response.status === 401 &&
      publicRequest.headers.get("authorization")
    ) {
      const limited = await enforceFailedAuthLimit(env, publicRequest, {
        event: "mcp_request",
        oauthShape: false,
      });
      if (limited) {
        return limited;
      }
    }
    return response;
  },
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    await createOAuthProvider(env, defaultHandler).purgeExpiredData(withWorkersOauthKv(env));
  },
} satisfies ExportedHandler<Env>;
