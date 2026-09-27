/**
 * Browser Origin checks for MCP Worker consent / revoke endpoints.
 * Loopback hostnames are interchangeable when APP_ORIGIN is also loopback
 * (Vite may serve `localhost` while .dev.vars pins `127.0.0.1`), so the trusted
 * set comes from `@pocketcircle/domain` — the one place that rule is written
 * down (#404).
 *
 * More than one app origin, because the ADR 0035 handover is two deploys and this
 * Worker's variable is not in both of them. The product Worker drops the apex and
 * the marketing Site claims it, and *then* the MCP Worker is deployed with
 * `APP_ORIGIN` naming the app subdomain — so between the first and the last there is
 * a window in which the app is served from the subdomain and this Worker still
 * refuses it, and the consent, revoke, and handoff endpoints answer 403 to the only
 * origin a User can reach. Two verification steps sit in that window, and if either
 * fails the release stops and the Worker stays wrong until somebody re-runs it.
 *
 * So the trust decision takes the retired origin too, for as long as the handover
 * needs it, and correctness stops depending on the order the deploys happen to run
 * in. That is the same shape as the Convex `MIGRATION_APP_ORIGIN` the auth side
 * carried for the same window, and it comes out with the same follow-up (#412).
 *
 * The cost is a second trusted browser origin for the length of the window, and it
 * is a small one: the apex is a static marketing Site with no client runtime, so
 * nothing running on it can call these endpoints. It is the *previous* state of this
 * very Worker, which trusts the apex today.
 */
import { loopbackTrustedOrigins } from "@pocketcircle/domain";

/**
 * Whether a presented browser `Origin` may drive the consent and revoke endpoints.
 *
 * `appOrigins` is the configured origin first and any retired one after it, so the
 * loopback-twin widening applies to every entry rather than to a single value.
 */
export function browserOriginAllowed(
  requestOrigin: string | null,
  ...appOrigins: readonly (string | undefined)[]
) {
  if (!requestOrigin) {
    return false;
  }
  let presented: string;
  try {
    // Normalize the presented origin too: a hand-written `Origin` header may
    // carry a path or a trailing slash, and `loopbackTrustedOrigins` compares
    // bare origins.
    presented = new URL(requestOrigin).origin;
  } catch {
    return false;
  }
  return appOrigins.some(
    (appOrigin) => appOrigin !== undefined && loopbackTrustedOrigins(appOrigin).includes(presented),
  );
}
