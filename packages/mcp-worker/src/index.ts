import { defaultHandler } from "./authorize.js";
import {
  assertClonedBodyWithinLimit,
  MCP_JSON_MAX_BODY_BYTES,
  MCP_TOKEN_MAX_BODY_BYTES,
} from "./bounded-body.js";
import type { Env } from "./env.js";
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
    // (the callback API has no env arg).
    const provider = createOAuthProvider(env, defaultHandler, new URL(request.url).origin);
    const url = new URL(request.url);
    const ip = clientIpOf(request) ?? "unknown";

    // Skip OAuth/KV once failed-auth already throttled this IP (mcp + token).
    if ((url.pathname === "/mcp" || url.pathname === "/token") && (await isFailedAuthBlocked(ip))) {
      mcpLog({
        event: url.pathname === "/token" ? "token_exchange" : "mcp_request",
        outcome: "rate_limited",
        status: 429,
        toolClass: "failed_auth",
      });
      return url.pathname === "/token" ? oauthRateLimitedResponse() : rateLimitedResponse();
    }

    // Bound /mcp before OAuth dispatch so oversized bodies never spend KV auth work.
    if (url.pathname === "/mcp" && request.method === "POST") {
      if (!(await assertClonedBodyWithinLimit(request, MCP_JSON_MAX_BODY_BYTES))) {
        return payloadTooLargeJson();
      }
    }

    if (url.pathname === "/token" && request.method === "POST") {
      if (!(await assertClonedBodyWithinLimit(request, MCP_TOKEN_MAX_BODY_BYTES))) {
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
      const clientId = await clientIdFromTokenForm(request);
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
      const response = await provider.fetch(request, env, ctx);
      if (response.status === 400 || response.status === 401) {
        const limited = await enforceFailedAuthLimit(env, request, {
          event: "token_exchange",
          oauthShape: true,
        });
        if (limited) {
          return limited;
        }
      }
      return response;
    }

    const response = await provider.fetch(request, env, ctx);
    // Count only presented-but-invalid credentials — bare challenges start OAuth discovery.
    if (
      url.pathname === "/mcp" &&
      response.status === 401 &&
      request.headers.get("authorization")
    ) {
      const limited = await enforceFailedAuthLimit(env, request, {
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
    await createOAuthProvider(env, defaultHandler).purgeExpiredData(env);
  },
} satisfies ExportedHandler<Env>;
