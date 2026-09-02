import { defaultHandler } from "./authorize.js";
import type { Env } from "./env.js";
import { createOAuthProvider } from "./oauth-options.js";
import {
  assertWithinRateLimit,
  clientIpOf,
  oauthRateLimitedResponse,
  unauthenticatedRateLimitKey,
} from "./rate-limit.js";
import { mcpLog } from "./safe-log.js";

export { HandoffStore } from "./handoff-store.js";

function clientIdFromTokenForm(request: Request) {
  // OAuth token requests are application/x-www-form-urlencoded; clone so the
  // provider can still read the body.
  return request
    .clone()
    .formData()
    .then((form) => {
      const clientId = form.get("client_id");
      return typeof clientId === "string" && clientId.length > 0 ? clientId : undefined;
    })
    .catch(() => undefined);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Per-request provider so tokenExchangeCallback closes over live `env`
    // (the callback API has no env arg).
    const provider = createOAuthProvider(env, defaultHandler, new URL(request.url).origin);
    const url = new URL(request.url);

    if (url.pathname === "/token" && request.method === "POST") {
      const clientId = await clientIdFromTokenForm(request);
      const withinLimit = await assertWithinRateLimit(
        env,
        "token",
        unauthenticatedRateLimitKey({
          className: "token",
          clientId,
          ip: clientIpOf(request),
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
        const withinFailedAuth = await assertWithinRateLimit(
          env,
          "failed_auth",
          unauthenticatedRateLimitKey({
            className: "failed_auth",
            clientId,
            ip: clientIpOf(request),
          }),
        );
        if (!withinFailedAuth.ok) {
          mcpLog({
            event: "token_exchange",
            outcome: "rate_limited",
            status: 429,
            toolClass: "failed_auth",
          });
          return oauthRateLimitedResponse();
        }
      }
      return response;
    }

    return provider.fetch(request, env, ctx);
  },
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    await createOAuthProvider(env, defaultHandler).purgeExpiredData(env);
  },
} satisfies ExportedHandler<Env>;
