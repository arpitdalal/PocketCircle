import { describe, expect, it } from "vitest";
import { browserOriginAllowed } from "./browser-origin.js";

describe("browserOriginAllowed", () => {
  it("requires an exact match for non-loopback APP_ORIGIN", () => {
    expect(browserOriginAllowed("https://pocketcircle.app", "https://pocketcircle.app")).toBe(true);
    expect(browserOriginAllowed("https://evil.example", "https://pocketcircle.app")).toBe(false);
    expect(browserOriginAllowed("http://localhost:5173", "https://pocketcircle.app")).toBe(false);
  });

  it("treats localhost and 127.0.0.1 as the same loopback app host", () => {
    expect(browserOriginAllowed("http://localhost:5173", "http://127.0.0.1:5173")).toBe(true);
    expect(browserOriginAllowed("http://127.0.0.1:5173", "http://localhost:5173")).toBe(true);
  });

  it("still requires matching protocol and port on loopback", () => {
    expect(browserOriginAllowed("http://localhost:5173", "http://127.0.0.1:5174")).toBe(false);
    expect(browserOriginAllowed("https://localhost:5173", "http://127.0.0.1:5173")).toBe(false);
    expect(browserOriginAllowed(null, "http://127.0.0.1:5173")).toBe(false);
  });
});
