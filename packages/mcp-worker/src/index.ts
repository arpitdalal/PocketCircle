import type { Env } from "./env.js";
import { createOAuthProvider } from "./oauth-options.js";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Per-request provider so tokenExchangeCallback closes over live `env`
    // (the callback API has no env arg).
    return createOAuthProvider(env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
