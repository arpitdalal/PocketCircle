import { APP_ORIGIN } from "@pocketcircle/domain/origins";
import type { Plugin } from "vite";
import { pagePath, sitePageFiles } from "./pages.js";

/**
 * The apex used to serve the product SPA, so every product path on it — every
 * bookmark, every link already delivered in an Invitation, welcome, or Account
 * Deletion email, every shared Transaction URL — now has to resolve on the app
 * subdomain (ADR 0035). This is the whole backward-compatibility story, and it is
 * a static `_redirects` file: no Worker script, no invocations, no cold start.
 *
 * A path that is not listed becomes a 404 for whoever holds that link, which is why
 * `legacy-redirects.test.ts` holds this list against the product's own route tree
 * rather than trusting it to stay in step. A rule that outlives the route it was
 * written for, and a route added without one, both fail that test.
 *
 * Two shapes of rule, and the distinction is not cosmetic:
 *
 * - An **exact** path, for a route with no dynamic children. `/settings` is the only
 *   address that has ever existed there, so a splat would add a rule that sends
 *   `/settings/anything` — never a PocketCircle URL — to the app's own not-found.
 * - A **splat** (`/circles/*` → `/circles/:splat`), for a subtree whose members are
 *   too many and too changeable to enumerate. The Circle tree is fifteen routes deep
 *   and grows with every feature; one rule covers all of it, present and future, and
 *   the Invitation and Notification tokens inside `/invite/*` and `/invitations/*`
 *   ride through it verbatim.
 *
 * Cloudflare applies the topmost matching rule and resolves redirects *before* the
 * asset manifest, so a source that collided with a page this Site publishes would
 * silently replace that document with a redirect to the app. The test asserts no
 * rule does.
 *
 * The destination is built from `APP_ORIGIN` rather than written out, so the origin
 * migration #404 made a one-line change stays a one-line change here — and so this
 * file, which has no extension and so is not one of the source types
 * `canonical-origins.test.ts` scans, cannot become a place an origin is spelled by
 * hand.
 */

/** A rule: an apex source, and the app path it hands off to. */
export interface LegacyRedirect {
  /** Apex path pattern, `*` for a subtree. */
  readonly source: string;
  /** The same address on the app origin. `*` becomes `:splat`. */
  readonly path: string;
}

/**
 * Product paths the apex owned. Cloudflare wants static redirects written before
 * dynamic ones, so {@link redirectsFile} sorts them; this is the list, not the file
 * order.
 */
export const LEGACY_REDIRECTS: readonly LegacyRedirect[] = [
  { source: "/connections", path: "/connections" },
  { source: "/delete-account/complete", path: "/delete-account/complete" },
  { source: "/delete-account/verify", path: "/delete-account/verify" },
  { source: "/dev/email-preview", path: "/dev/email-preview" },
  { source: "/feedback", path: "/feedback" },
  { source: "/from-notification", path: "/from-notification" },
  { source: "/home", path: "/home" },
  { source: "/mcp/authorize", path: "/mcp/authorize" },
  { source: "/my-transactions", path: "/my-transactions" },
  { source: "/onboarding", path: "/onboarding" },
  { source: "/settings", path: "/settings" },
  { source: "/signin", path: "/signin" },
  { source: "/transactions/new", path: "/transactions/new" },
  { source: "/circles/*", path: "/circles/:splat" },
  { source: "/invitations/*", path: "/invitations/:splat" },
  { source: "/invite/*", path: "/invite/:splat" },
] as const;

/** Status a rule answers with. 302 rather than 301: the app's URLs are not moving again. */
const REDIRECT_STATUS = 302;

/** Whether a rule's source covers a subtree rather than one address. */
export function isSplat(source: string) {
  return source.endsWith("/*");
}

/**
 * A redirect source as a matcher over concrete paths, for the test that holds this
 * list against the product's route tree.
 *
 * Modelled on what Workers actually does, which is not what the syntax suggests: a
 * splat source `/circles/*` matches `/circles/sample`, `/circles/a/b`, and
 * `/circles/` — but **not** the bare `/circles`, which 404s. So the separator is
 * required and the remainder is not. Getting this wrong in the permissive direction
 * would let the coverage test accept a splat rule for a route the rule does not
 * actually serve, which is the exact failure the test exists to catch.
 */
export function sourceMatcher(source: string) {
  const prefix = source.endsWith("/*") ? source.slice(0, -2) : source;
  const escaped = prefix.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}${source.endsWith("/*") ? "/.*" : ""}$`);
}

/** The `_redirects` document the Workers asset manifest reads, comments and all. */
export function redirectsFile() {
  const order = [...LEGACY_REDIRECTS].sort(
    (a, b) =>
      Number(isSplat(a.source)) - Number(isSplat(b.source)) || a.source.localeCompare(b.source),
  );
  return `${[
    "# Legacy product paths -> the app subdomain. Static redirects, no Worker script,",
    "# no invocations (ADR 0035, #411).",
    "#",
    "# Generated from apps/site/src/legacy-redirects.ts — the destinations come from",
    "# APP_ORIGIN, so the origin migration stays a one-line change. The list is held",
    "# against apps/web-app/app/routes.ts by src/legacy-redirects.test.ts.",
    ...order.map(({ source, path }) => `${source}  ${APP_ORIGIN}${path}  ${REDIRECT_STATUS}`),
  ].join("\n")}\n`;
}

/**
 * The paths this Site answers on the apex, so the test can assert that no redirect
 * source shadows one of them. Derived from the pages themselves rather than listed,
 * which is the same reason `pages.ts` derives the page list.
 */
export function apexOwnedPaths() {
  return sitePageFiles().map(pagePath);
}

export function legacyRedirectsPlugin(): Plugin {
  return {
    name: "pocketcircle:legacy-redirects",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "_redirects", source: redirectsFile() });
    },
  };
}
