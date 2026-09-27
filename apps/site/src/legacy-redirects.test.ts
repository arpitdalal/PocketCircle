// @vitest-environment node

import { APP_ORIGIN } from "@pocketcircle/domain/origins";
import { describe, expect, it } from "vitest";
/**
 * The apex's legacy redirect list, held against the product's own route tree.
 *
 * `_redirects` is the entire backward-compatibility story of the ADR 0035 cutover,
 * and it fails in the one way that is invisible until somebody follows a link they
 * have had in their history for months: a product path the list forgot becomes a 404
 * on the marketing Site. Nothing in the build would notice — the file is valid, the
 * Worker deploys, the site verifies — so the coverage is asserted here instead, from
 * the route tree rather than from a second list that could agree with the first and
 * both be wrong.
 *
 * The route config is imported, not parsed. It is the product's own statement of what
 * it serves, in the shape its framework produces, so a new route cannot be added in a
 * form this misses; and it resolves from `apps/web-app`'s own `node_modules` because
 * resolution runs from the importing file, which is why the Site needs no dependency
 * on the product's framework to read it.
 *
 * The failure polarity is the point of the design. A route *added* after the cutover
 * has no delivered links behind it — no email, no bookmark — so it needs no legacy
 * redirect, and the honest answer to "this new route is unredirected" is a
 * one-line acknowledgement in {@link POST_CUTOVER_ROUTES} rather than a rule that
 * sends an address nobody ever published to the app. A route *removed or renamed*
 * after the cutover is the opposite: a link that was delivered no longer resolves
 * anywhere, and that fails here.
 */
import appRoutes from "../../web-app/app/routes.js";
import {
  apexForms,
  apexOwnedPaths,
  isSplat,
  LEGACY_REDIRECTS,
  redirectsFile,
  sourceMatcher,
} from "./legacy-redirects.js";

/**
 * Product routes deliberately left without an apex redirect, each with the reason.
 * Empty today: the cutover itself is what makes a path legacy, and every path the
 * apex served before it has a rule.
 */
const POST_CUTOVER_ROUTES: Record<string, string> = {};

/** The app's own catch-all. It is the absence of a route, not a URL. */
const CATCH_ALL = "*";

/**
 * Every path the product serves, as a route pattern (`/circles/:circleRef/setup`).
 *
 * Composed from the tree rather than read off one entry: `prefix()` and `route()`
 * give a nested entry a path relative to its parent, an `index()` entry none at all
 * (it answers *at* its parent), and a pathless `layout()` is not a route — it only
 * contributes children. An entry's own `path` is therefore an address only once its
 * parents are prepended, and the three cases are told apart by what the entry omits.
 */
function servedPaths(entries: readonly RouteEntry[], parent = ""): string[] {
  return entries.flatMap((entry) => {
    if (entry.path === CATCH_ALL) {
      return [];
    }
    const children = servedPaths(entry.children ?? [], parent);
    if (entry.path === undefined) {
      return entry.index === true ? [parent || "/", ...children] : children;
    }
    const own = `${parent}/${entry.path}`;
    return [own, ...servedPaths(entry.children ?? [], own)];
  });
}

/**
 * One entry of the product's route config, read structurally. The framework's own
 * type is not importable from this package, and the fields below are the whole of
 * what the composition above reads.
 */
interface RouteEntry {
  readonly path?: string;
  readonly index?: boolean;
  readonly children?: readonly RouteEntry[];
}

const served = [...new Set(servedPaths(appRoutes))];
const apexOwned = apexOwnedPaths();
const matchers = LEGACY_REDIRECTS.map((redirect) => ({
  redirect,
  matches: sourceMatcher(redirect.source),
}));

/** Every apex address the file publishes a rule for, trailing-slash twins included. */
const emittedForms = LEGACY_REDIRECTS.flatMap(apexForms);

/** A concrete address for a route pattern, for matching against a source. */
function sample(pattern: string) {
  return pattern.replaceAll(/:[^/]+/g, "sample");
}

describe("the rule semantics the coverage assertions above rely on", () => {
  // These are assertions about Workers' behaviour, not about this file's regex, and
  // they exist because the regex is a *model* of it. Modelled permissively, the
  // coverage test would accept a splat rule for a route the rule does not actually
  // serve — the precise failure it is here to catch, reintroduced through its own
  // helper. Each expectation below was read off a real Workers runtime
  // (`wrangler dev` over the built Site), not inferred from the syntax.
  it("matches a splat's whole subtree", () => {
    const circles = sourceMatcher("/circles/*");
    expect(circles.test("/circles/sample")).toBe(true);
    expect(circles.test("/circles/a/b/c")).toBe(true);
    // The trailing-slash form is a real request and is redirected.
    expect(circles.test("/circles/")).toBe(true);
  });

  it("does not match a splat's bare prefix, which 404s", () => {
    // `/circles` is not a PocketCircle address — the routes are `circles/new` and
    // `circles/:circleRef` — so nothing is lost here. What matters is that the
    // matcher does not *claim* it: a bare prefix is a 404 on the apex, and a test
    // that believed otherwise would let a future bare route through unredirected.
    expect(sourceMatcher("/circles/*").test("/circles")).toBe(false);
    expect(sourceMatcher("/invite/*").test("/invite")).toBe(false);
  });

  it("matches an exact source on that address and nothing else", () => {
    const settings = sourceMatcher("/settings");
    expect(settings.test("/settings")).toBe(true);
    expect(settings.test("/settings/anything")).toBe(false);
    expect(settings.test("/signin")).toBe(false);
  });
});

describe("the paths the product serves", () => {
  it("are the ones this test reasons about, so it cannot pass by reading nothing", () => {
    // A walker that stopped composing would see only the top level and the coverage
    // assertions below would pass while most of the app was unredirected.
    expect(served).toEqual(
      expect.arrayContaining([
        "/",
        "/signin",
        "/invite/:token",
        "/delete-account/verify",
        "/circles/:circleRef",
        "/circles/:circleRef/transactions/:transactionRef/edit",
        "/circles/:circleRef/categories/:categoryRef",
      ]),
    );
    expect(served.length).toBeGreaterThan(25);
  });
});

describe("every product path resolves on the app subdomain", () => {
  const unredirected = served.filter(
    (path) =>
      !apexOwned.includes(path) &&
      !(path in POST_CUTOVER_ROUTES) &&
      !matchers.some(({ matches }) => matches.test(sample(path))),
  );

  it("is either a page the apex owns, an acknowledged post-cutover route, or redirected", () => {
    expect(
      unredirected,
      unredirected.length === 0
        ? ""
        : [
            "These product paths answer 404 on the apex, and a path that is not listed is",
            "a 404 for whoever holds the link. Add a rule to LEGACY_REDIRECTS, or — for a",
            "route added after the cutover, which has no delivered links behind it — a",
            "reason in POST_CUTOVER_ROUTES:",
            ...unredirected.map((path) => `  ${path}`),
          ].join("\n"),
    ).toEqual([]);
  });

  it("leaves the apex's own marketing pages to the apex", () => {
    // `/`, `/privacy`, `/terms`, `/support`, and `/whats-new` are the documents Google
    // reads for branding and the URLs already published to third parties. A redirect
    // here is not a broken link, it is a branding failure.
    expect(apexOwned).toEqual(
      expect.arrayContaining(["/", "/privacy", "/terms", "/support", "/whats-new"]),
    );
  });
});

describe("every rule points at an address the product serves", () => {
  it("so a route that was renamed or deleted cannot leave a rule behind", () => {
    const orphaned = LEGACY_REDIRECTS.filter(
      ({ source }) => !served.some((path) => sourceMatcher(source).test(sample(path))),
    );
    expect(
      orphaned.map(({ source }) => source),
      orphaned.length === 0
        ? ""
        : "These rules redirect to an app URL that does not exist, so a link that used to work now dead-ends at the app's not-found. Delete the rule, or restore the route.",
    ).toEqual([]);
  });

  it("and none of them shadows a document this Site publishes", () => {
    // Cloudflare resolves redirects before the asset manifest, so a rule matching
    // `/privacy` would replace the document with a hop to the app. Nothing else in the
    // build can see that: the document is still published, and still correct.
    //
    // Over the *emitted* forms rather than the list, because a trailing-slash twin is
    // a rule like any other and could shadow just as effectively.
    const shadowing = emittedForms.filter((source) =>
      apexOwned.some((path) => sourceMatcher(source).test(path)),
    );
    expect(
      shadowing,
      shadowing.length === 0 ? "" : "The apex owns these paths; a redirect outranks the asset.",
    ).toEqual([]);
  });
});

describe("the trailing-slash form of every legacy address", () => {
  // The apex was an SPA behind Cloudflare's `single-page-application` fallback, so it
  // served the shell for *any* path and React Router accepted `/settings/` as readily
  // as `/settings`. A saved or hand-typed trailing-slash link was a working
  // PocketCircle URL; after the handover it matches no rule and no document, so it is
  // a 404 on the marketing Site. These are the addresses that regressed silently.
  const emitted = emittedForms.filter((source) => !isSplat(source));

  it("is served for every exact rule", () => {
    // Verified against a real Workers runtime, not inferred: `/settings/`,
    // `/signin/`, `/delete-account/verify/?token=…` and the rest each answer 302.
    for (const { source, path } of LEGACY_REDIRECTS.filter(({ source }) => !isSplat(source))) {
      expect(emitted, source).toContain(`${source}/`);
      // Both spellings hand off to the one canonical app path, so the app's router
      // never has to know a slashed form exists.
      const twin = redirectsFile()
        .split("\n")
        .find((line) => line.startsWith(`${source}/ `));
      expect(twin, `${source}/ has no rule`).toBeDefined();
      expect(twin, `${source}/`).toContain(`${APP_ORIGIN}${path} `);
    }
  });

  it("needs no twin of its own for a splat, which already covers it", () => {
    // `/circles/*` matches `/circles/` but *not* the bare `/circles` — verified
    // against the same runtime, and the reason the twin is only for exact rules. A
    // splat emitted a twin as well would be a rule matching nothing.
    for (const { source } of LEGACY_REDIRECTS.filter(({ source }) => isSplat(source))) {
      expect(emitted).not.toContain(`${source.slice(0, -1)}/`);
    }
  });
});

describe("the published _redirects document", () => {
  const file = redirectsFile();

  it("carries every rule, in the order Cloudflare documents, with no placeholder left", () => {
    const rules = file
      .split("\n")
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => line.split(/\s+/));
    // The ceilings are counted over the emitted rules rather than the list, because
    // the file is what Cloudflare parses and the trailing-slash twins are rules in it.
    const statics = emittedForms.filter((source) => !isSplat(source));
    const dynamics = emittedForms.length - statics.length;

    expect(rules).toHaveLength(emittedForms.length);
    // "Static redirects should appear before dynamic redirects" — and a splat rule
    // above an exact one would swallow it, which is the failure mode an ordering slip
    // produces rather than an error.
    expect(rules.slice(0, statics.length).every(([source]) => !source?.endsWith("/*"))).toBe(true);
    expect(rules.slice(statics.length).every(([source]) => source?.endsWith("/*"))).toBe(true);
    // Cloudflare's per-file ceilings. Far away, but a list that grew into them would
    // be silently truncated at the last rule — at the *last* rule, silently, which is
    // the worst place to discover a limit.
    expect(statics.length).toBeLessThan(2_000);
    expect(dynamics).toBeLessThan(100);

    for (const [source, destination, status] of rules) {
      expect(emittedForms, source).toContain(source);
      // Every rule's destination is the app origin, spelled once from the constant.
      expect(destination, source).toMatch(new RegExp(`^${APP_ORIGIN}/`));
      expect(status, source).toBe("302");
    }
    // No rule is written twice, and none is missing: a duplicate is dead weight and a
    // gap is a 404, and both are invisible in a diff of a generated file.
    expect(
      new Set(emittedForms).size,
      `${emittedForms.length} addresses, ${new Set(emittedForms).size} distinct`,
    ).toBe(emittedForms.length);
    expect(file).not.toMatch(/%[A-Z_]+%/);
  });

  it("hands each subtree to the app under the same path, splat included", () => {
    // A `:splat` that does not line up with the source prefix would land the User on
    // a different page than the one they asked for — an Invitation token rewritten
    // into a Circle ref, say — and it would still be a 200, so nothing else sees it.
    for (const { source, path } of LEGACY_REDIRECTS.filter(({ source }) => isSplat(source))) {
      expect(path, source).toBe(`${source.slice(0, -1)}:splat`);
    }
  });
});

/*
 * Query preservation is not asserted here and cannot be: Cloudflare documents that
 * `_redirects` cannot *match* on a query parameter, and says nothing about whether an
 * untouched one survives a plain redirect. It does survive — verified by serving this
 * build with `wrangler dev` and reading the `Location` back, including
 * `/delete-account/verify?token=…`, which is the Account Deletion verification link
 * that carries its token in exactly that query
 * (`packages/convex/convex/accountDeletion.ts`) — so the minimal Worker on this origin
 * scoped to `/delete-account/*` that the runbook describes as the fallback is not
 * built. Billed invocations are not worth spending on a question that has an answer.
 *
 * The deployed origin is still where it is proved for real, because a Worker runtime
 * is not the only thing that could differ: `deploy.yml`'s "Verify marketing Site"
 * fetches every rule from the apex with a query and parses the `Location` it gets
 * back. If Cloudflare ever changes this, that step fails on the release rather than on
 * a User's Account Deletion email.
 */
