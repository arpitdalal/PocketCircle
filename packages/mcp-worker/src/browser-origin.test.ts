import {
  APEX_ORIGIN,
  APP_ORIGIN,
  LOCAL_APP_ORIGIN,
  LOCAL_APP_TWIN_ORIGIN,
} from "@pocketcircle/domain";
import { describe, expect, it } from "vitest";
import { browserOriginAllowed } from "./browser-origin.js";

describe("browserOriginAllowed", () => {
  it("requires an exact match for a deployed app origin", () => {
    expect(browserOriginAllowed(APP_ORIGIN, APP_ORIGIN)).toBe(true);
    expect(browserOriginAllowed("https://evil.example", APP_ORIGIN)).toBe(false);
    expect(browserOriginAllowed(LOCAL_APP_TWIN_ORIGIN, APP_ORIGIN)).toBe(false);
  });

  it("treats the two loopback names as the same app host", () => {
    expect(browserOriginAllowed(LOCAL_APP_TWIN_ORIGIN, LOCAL_APP_ORIGIN)).toBe(true);
    expect(browserOriginAllowed(LOCAL_APP_ORIGIN, LOCAL_APP_TWIN_ORIGIN)).toBe(true);
  });

  it("normalizes a presented origin that carries a path or trailing slash", () => {
    expect(browserOriginAllowed(`${LOCAL_APP_ORIGIN}/`, LOCAL_APP_ORIGIN)).toBe(true);
    expect(browserOriginAllowed(`${APP_ORIGIN}/mcp/authorize`, APP_ORIGIN)).toBe(true);
  });

  it("still requires matching protocol and port on loopback", () => {
    expect(browserOriginAllowed(LOCAL_APP_TWIN_ORIGIN, "http://127.0.0.1:5174")).toBe(false);
    expect(
      browserOriginAllowed(LOCAL_APP_TWIN_ORIGIN.replace("http:", "https:"), LOCAL_APP_ORIGIN),
    ).toBe(false);
  });

  it("does not treat the IPv6 loopback name as the IPv4 one", () => {
    // The two are different addresses, not two names for one machine: a server
    // bound to `::1` is not necessarily reachable as `127.0.0.1`.
    const ipv6App = "http://[::1]:5173";
    expect(browserOriginAllowed(ipv6App, ipv6App)).toBe(true);
    expect(browserOriginAllowed(LOCAL_APP_ORIGIN, ipv6App)).toBe(false);
  });

  // The ADR 0035 handover is two deploys and this Worker's variable is in neither of
  // the first two steps of the release, so between them the app is served from the
  // subdomain while this Worker still names the apex alone — and the consent, revoke,
  // and handoff endpoints answer 403 to the only origin a User can reach. These
  // assert the second origin is honoured, because the alternative is a release whose
  // correctness depends on step order.
  it("honours a retired app origin alongside the current one", () => {
    expect(browserOriginAllowed(APEX_ORIGIN, APP_ORIGIN, APEX_ORIGIN)).toBe(true);
    expect(browserOriginAllowed(APP_ORIGIN, APP_ORIGIN, APEX_ORIGIN)).toBe(true);
    // Still not a widened net: an origin that is neither is refused, and so is a
    // substring of one.
    expect(browserOriginAllowed("https://evil.example", APP_ORIGIN, APEX_ORIGIN)).toBe(false);
    expect(browserOriginAllowed(`${APEX_ORIGIN}.evil.example`, APP_ORIGIN, APEX_ORIGIN)).toBe(
      false,
    );
  });

  it("treats an absent retired origin as one app origin, which is the settled state", () => {
    // The variable is optional on purpose: after the cutover there is nothing to
    // straddle, and `undefined` must mean "no second origin" rather than "a crash".
    expect(browserOriginAllowed(APP_ORIGIN, APP_ORIGIN, undefined)).toBe(true);
    expect(browserOriginAllowed(APEX_ORIGIN, APP_ORIGIN, undefined)).toBe(false);
    // And the one-argument form the single-origin callers use still works.
    expect(browserOriginAllowed(APP_ORIGIN, APP_ORIGIN)).toBe(true);
  });

  it("applies the loopback-twin widening to every app origin, not just the first", () => {
    // The widening is per-origin, and skipping it for the second would mean a local
    // E2E run that serves the app on `localhost` and pins the retired origin to
    // `127.0.0.1` is refused — the exact bug the pair exists to prevent, reintroduced
    // one argument in.
    expect(
      browserOriginAllowed(LOCAL_APP_TWIN_ORIGIN, LOCAL_APP_ORIGIN, LOCAL_APP_TWIN_ORIGIN),
    ).toBe(true);
    expect(browserOriginAllowed(LOCAL_APP_ORIGIN, LOCAL_APP_ORIGIN, LOCAL_APP_TWIN_ORIGIN)).toBe(
      true,
    );
  });

  it("rejects a missing or opaque Origin", () => {
    expect(browserOriginAllowed(null, LOCAL_APP_ORIGIN)).toBe(false);
    expect(browserOriginAllowed("null", LOCAL_APP_ORIGIN)).toBe(false);
    expect(browserOriginAllowed("not a url", LOCAL_APP_ORIGIN)).toBe(false);
  });
});
