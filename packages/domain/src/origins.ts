/**
 * Canonical public origins (#404). This is the only module in the repo allowed
 * to spell out PocketCircle's public hostnames, so the ADR 0035 move of the
 * product SPA off the apex is a one-line change here instead of a hunt across a
 * dozen call sites. `canonical-origins.test.ts` fails the build if anyone else
 * spells one out.
 *
 * Which origin a consumer uses, and in which environment:
 *
 * | Consumer                                    | Constant                | Where it comes from                                     |
 * | ------------------------------------------- | ----------------------- | ------------------------------------------------------- |
 * | Marketing copy, `robots.txt`, sitemap        | `APEX_ORIGIN`           | Baked in — the same on every deployment                  |
 * | Browser `Origin` allowlists, consent URLs    | `APP_HOSTNAME`           | Baked in, plus the host of the `APP_ORIGIN` override    |
 * | The app subdomain the SPA also answers on    | `MIGRATION_APP_ORIGIN`  | Baked in — deploy configuration only, never a link      |
 * | MCP issuer / resource URI, plugin manifests  | `MCP_ORIGIN`            | Baked in, plus the `MCP_ISSUER` env override            |
 * | Support and legal mailboxes                  | `APEX_HOSTNAME`         | Baked in                                               |
 * | Vite dev server, Playwright base URL          | `LOCAL_APP_ORIGIN`      | Baked in; local dev and E2E only                        |
 *
 * The split that matters: the **apex** is the marketing Site and the mailbox
 * domain, and the **app origin** is the authenticated SPA. `APP_HOSTNAME` is still
 * the apex, and the app answers on *both* it and `MIGRATION_APP_HOSTNAME` (#410),
 * so every host a User can reach today is still reachable. They are the same app,
 * not two deployments, and anything a browser reaches *while signed in* — a
 * consent `Origin`, a redirect target, a sign-in link — must keep following the
 * app origin rather than the apex, so nothing about the move is visible until the
 * cutover. The two env overrides (`APP_ORIGIN`, `MCP_ISSUER`) exist because a
 * local or E2E Worker genuinely runs somewhere else; they are **not** defaulted
 * from the constants below, so an unset override means "unconfigured", not
 * "production".
 *
 * Out of scope, deliberately: the loopback origins of *auxiliary* local services
 * — the MCP Worker's dev port and the self-hosted Convex backend. Convex assigns
 * its own production subdomain, so there is no canonical value to record for it,
 * and the local ports are per-tool dev wiring documented in the env templates.
 *
 * `127.0.0.1` and `localhost` are different browser origins even though they
 * are the same machine, and Vite may serve one while `.dev.vars` / `SITE_URL`
 * pin the other — so a loopback origin is trusted as a *pair*.
 * {@link loopbackTrustedOrigins} is that widening, in one place.
 *
 * This module deliberately has no imports (not even a sibling): toolchain config
 * files — `vite.config.ts`, `vitest.config.ts`, and the plain-`node` build
 * scripts — load it directly, and Node resolves the `.ts` extension itself,
 * which it cannot do for a module that reaches for `./x.js`. Inside a workspace
 * package that means `import … from "@pocketcircle/domain/origins"` (the
 * subpath export exists only for this module); from a file that is not in a
 * workspace package — the repo root's Playwright config, the E2E suite, the
 * shell and plugin scripts — import the source path directly, because
 * `@pocketcircle/domain` is not a dependency there.
 */

/** Apex host. Owns the marketing surfaces and, until the ADR 0035 cutover, the app. */
export const APEX_HOSTNAME = "pocketcircle.app";

/**
 * Host the authenticated product SPA is served from. Equal to the apex today; the
 * ADR 0035 cutover changes this one line to `MIGRATION_APP_HOSTNAME` and every
 * consumer follows.
 */
export const APP_HOSTNAME = APEX_HOSTNAME;

/**
 * Host the cutover moves the SPA to, claimed as a second custom domain on the same
 * Worker while the apex still serves the same app (#410). `APP_HOSTNAME` therefore
 * stays the apex for the whole window: the app's own links, the MCP Worker's consent
 * redirect, and the deploy workflow all keep naming the host that has been in
 * production, so serving the app on two hosts is rehearsal rather than a change a
 * User can notice. The cutover promotes this to `APP_HOSTNAME` and drops the apex
 * route in the same deploy.
 *
 * Named for the Convex `MIGRATION_APP_ORIGIN` variable that trusts this origin
 * alongside `SITE_URL` (#409) — the same origin, deliberately, so the deploy and the
 * runbook that widen auth and the config that claims the host cannot drift.
 */
export const MIGRATION_APP_HOSTNAME = `app.${APEX_HOSTNAME}`;

/** Host of the hosted MCP server (OAuth issuer, resource, and PRM allowlist). */
export const MCP_HOSTNAME = `mcp.${APEX_HOSTNAME}`;

export const APEX_ORIGIN = `https://${APEX_HOSTNAME}`;
export const APP_ORIGIN = `https://${APP_HOSTNAME}`;

/**
 * The second origin the product app is served from during the ADR 0035 cutover
 * window. Deployment configuration, not a link target: nothing a User clicks names
 * it, and the apex is not redirected to it — both hosts answer the same app, so
 * which one a User is on is theirs to choose, and the sign-in callback follows them
 * there.
 */
export const MIGRATION_APP_ORIGIN = `https://${MIGRATION_APP_HOSTNAME}`;

export const MCP_ORIGIN = `https://${MCP_HOSTNAME}`;

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
 * Interchangeable loopback hostnames. `localhost` and `127.0.0.1` are two names
 * for one address, so either may be presented for the other. `::1` is a
 * different address on the same machine — loopback, but not a stand-in: a server
 * bound to one is not necessarily reachable on the other.
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
 * the deployment is configured with — `[origin]`, or `[origin, twin]` when it is
 * loopback with a twin. Throws on an unparseable origin, as `new URL` does.
 */
export function loopbackTrustedOrigins(origin: string): [string] | [string, string] {
  const url = new URL(origin);
  const twinHostname = LOOPBACK_TWIN_HOSTNAMES.get(url.hostname);
  if (!twinHostname) {
    return [url.origin];
  }
  const twin = new URL(url.origin);
  twin.hostname = twinHostname;
  return [url.origin, twin.origin];
}

/** The other name for the local app origin. Trust it wherever `LOCAL_APP_ORIGIN` is trusted. */
export const LOCAL_APP_TWIN_ORIGIN =
  loopbackTrustedOrigins(LOCAL_APP_ORIGIN)[1] ?? LOCAL_APP_ORIGIN;
