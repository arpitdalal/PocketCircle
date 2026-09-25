import { APP_ORIGIN, LOCAL_APP_ORIGIN, LOCAL_APP_TWIN_ORIGIN } from "@pocketcircle/domain";
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

  it("rejects a missing or opaque Origin", () => {
    expect(browserOriginAllowed(null, LOCAL_APP_ORIGIN)).toBe(false);
    expect(browserOriginAllowed("null", LOCAL_APP_ORIGIN)).toBe(false);
    expect(browserOriginAllowed("not a url", LOCAL_APP_ORIGIN)).toBe(false);
  });
});
