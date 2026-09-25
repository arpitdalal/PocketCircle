/**
 * Canonical public origins (#404). This is the only module in the repo allowed
 * to spell out PocketCircle's public hostnames, so the ADR 0035 move of the
 * product SPA off the apex is a one-line change here instead of a hunt across a
 * dozen call sites.
 *
 * Which origin a consumer should use:
 *
 * - **Deployed surfaces** — UI copy, `robots.txt`, the sitemap, plugin
 *   manifests, the MCP Worker's hostname and CORS allowlists — read the
 *   `*_HOSTNAME` / `*_ORIGIN` constants directly. They are the values that ship.
 * - **Per-deployment overrides** — the MCP Worker's `APP_ORIGIN`, Convex's
 *   `SITE_URL`, the app's `VITE_MCP_WORKER_ORIGIN` — stay in the environment,
 *   because a deployment (production, E2E, self-hosted) genuinely varies them.
 *   Their *default* is the matching constant here.
 * - **Local dev and E2E** never spell a loopback literal: they use
 *   {@link LOCAL_APP_ORIGIN} plus the loopback helpers. `127.0.0.1` and
 *   `localhost` are different browser origins, so a loopback origin must be
 *   trusted as a *pair* — Vite may serve one while `.dev.vars` / `SITE_URL` pin
 *   the other. {@link loopbackTrustedOrigins} is that widening, in one place.
 *
 * This module deliberately has no imports (not even a sibling): toolchain config
 * files — `vite.config.ts`, `vitest.config.ts`, and the plain-`node` build
 * scripts — load it directly, and Node resolves the `.ts` extension itself,
 * which it cannot do for a module that reaches for `./x.js`. Inside a workspace
 * package that means `import … from "@pocketcircle/domain/origins"` (the
 * subpath export exists only for this module); at the repo root, where
 * `@pocketcircle/domain` is not a dependency, import the source path directly.
 */

/** Apex host. Owns the marketing surfaces and, until the ADR 0035 cutover, the app. */
export const APEX_HOSTNAME = "pocketcircle.app";

/**
 * Host the authenticated product SPA is served from. Equal to the apex today;
 * the ADR 0035 cutover changes this one line to `app.pocketcircle.app` and every
 * consumer follows.
 */
export const APP_HOSTNAME = APEX_HOSTNAME;

/** Host of the hosted MCP server (OAuth issuer, resource, and PRM allowlist). */
export const MCP_HOSTNAME = `mcp.${APEX_HOSTNAME}`;

export const APEX_ORIGIN = `https://${APEX_HOSTNAME}`;
export const APP_ORIGIN = `https://${APP_HOSTNAME}`;
export const MCP_ORIGIN = `https://${MCP_HOSTNAME}`;

/** OAuth issuer clients discover. Equal to the MCP origin. */
export const MCP_ISSUER = MCP_ORIGIN;

/** Streamable HTTP resource identifier clients bind tokens to. */
export const MCP_RESOURCE_URI = `${MCP_ORIGIN}/mcp`;

/** Host every local app (Vite dev server, the E2E suite) is served on. */
export const LOCAL_APP_HOSTNAME = "127.0.0.1";

/** Port the Vite dev server and the E2E suite use. */
export const LOCAL_APP_PORT = 5173;

/** Local dev / E2E app origin. Matches `SITE_URL` and the Vite `server` block. */
export const LOCAL_APP_ORIGIN = `http://${LOCAL_APP_HOSTNAME}:${LOCAL_APP_PORT}`;

/** Hostnames that address this machine. `URL` keeps IPv6 brackets, hence `[::1]`. */
export const LOOPBACK_HOSTNAMES: readonly string[] = ["localhost", "127.0.0.1", "::1", "[::1]"];

/**
 * Interchangeable loopback hostnames. Only the IPv4/IPv6 *name* pair is a twin:
 * `localhost` and `127.0.0.1` are the same machine, while `::1` may not even be
 * the address the local server bound.
 */
const LOOPBACK_TWIN_HOSTNAMES: ReadonlyMap<string, string> = new Map([
  ["localhost", "127.0.0.1"],
  ["127.0.0.1", "localhost"],
]);

export function isLoopbackHostname(hostname: string) {
  return LOOPBACK_HOSTNAMES.includes(hostname);
}

/**
 * Every origin a browser may legitimately present as `origin`, given the origin
 * the deployment is configured with: `origin` itself, plus its loopback twin when
 * it has one. Throws on an unparseable origin, exactly as `new URL` does.
 */
export function loopbackTrustedOrigins(origin: string) {
  const url = new URL(origin);
  const twinHostname = LOOPBACK_TWIN_HOSTNAMES.get(url.hostname);
  if (!twinHostname) {
    return [url.origin];
  }
  const twin = new URL(url.origin);
  twin.hostname = twinHostname;
  return [url.origin, twin.origin];
}
