import { APP_ORIGIN, LOCAL_APP_ORIGIN } from "@pocketcircle/domain";
import { describe, expect, it } from "vitest";
import { browserOriginAllowed } from "./browser-origin.js";

/** The other name for the same loopback machine (see `loopbackTrustedOrigins`). */
const LOOPBACK_TWIN = "http://localhost:5173";

describe("browserOriginAllowed", () => {
  it("requires an exact match for non-loopback APP_ORIGIN", () => {
    expect(browserOriginAllowed(APP_ORIGIN, APP_ORIGIN)).toBe(true);
    expect(browserOriginAllowed("https://evil.example", APP_ORIGIN)).toBe(false);
    expect(browserOriginAllowed(LOOPBACK_TWIN, APP_ORIGIN)).toBe(false);
  });

  it("treats localhost and 127.0.0.1 as the same loopback app host", () => {
    expect(browserOriginAllowed(LOOPBACK_TWIN, LOCAL_APP_ORIGIN)).toBe(true);
    expect(browserOriginAllowed(LOCAL_APP_ORIGIN, LOOPBACK_TWIN)).toBe(true);
  });

  it("still requires matching protocol and port on loopback", () => {
    expect(browserOriginAllowed(LOOPBACK_TWIN, "http://127.0.0.1:5174")).toBe(false);
    expect(browserOriginAllowed(LOOPBACK_TWIN.replace("http:", "https:"), LOCAL_APP_ORIGIN)).toBe(
      false,
    );
    expect(browserOriginAllowed(null, LOCAL_APP_ORIGIN)).toBe(false);
  });
});
