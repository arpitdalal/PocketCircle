import { afterEach, describe, expect, it, vi } from "vitest";
import { posthogHost, posthogKey } from "./env.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("posthog env", () => {
  it("reads VITE_POSTHOG_KEY at call time without mocking this module", () => {
    vi.stubEnv("VITE_POSTHOG_KEY", "phc_live");
    expect(posthogKey()).toBe("phc_live");
    vi.stubEnv("VITE_POSTHOG_KEY", "");
    expect(posthogKey()).toBeUndefined();
  });

  it("defaults the ingest host when VITE_POSTHOG_HOST is unset", () => {
    vi.stubEnv("VITE_POSTHOG_HOST", "");
    expect(posthogHost()).toBe("https://us.i.posthog.com");
    vi.stubEnv("VITE_POSTHOG_HOST", "https://eu.i.posthog.com");
    expect(posthogHost()).toBe("https://eu.i.posthog.com");
  });
});
