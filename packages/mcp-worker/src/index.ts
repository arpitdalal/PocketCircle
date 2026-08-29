import { defaultHandler } from "./authorize.js";
import type { Env } from "./env.js";
import { createOAuthProvider } from "./oauth-options.js";

export { HandoffStore } from "./handoff-store.js";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Per-request provider so tokenExchangeCallback closes over live `env`
    // (the callback API has no env arg).
    return createOAuthProvider(env, defaultHandler, new URL(request.url).origin).fetch(
      request,
      env,
      ctx,
    );
  },
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    await createOAuthProvider(env, defaultHandler).purgeExpiredData(env);
  },
} satisfies ExportedHandler<Env>;
