import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const sentrySdk = vi.hoisted(() => ({
  init: vi.fn(),
  replayIntegration: vi.fn(() => ({ name: "Replay" })),
}));

vi.mock("@sentry/react", () => ({
  init: sentrySdk.init,
  replayIntegration: sentrySdk.replayIntegration,
}));

const env = vi.hoisted(() => {
  const mock: { SENTRY_DSN: string | undefined } = { SENTRY_DSN: undefined };
  return mock;
});

vi.mock("./env.js", () => env);

import { buildSentryInitOptions, initSentry } from "./sentry.js";

afterEach(() => {
  vi.clearAllMocks();
  env.SENTRY_DSN = undefined;
});

describe("buildSentryInitOptions", () => {
  it("samples no normal sessions and replays on every error", () => {
    const options = buildSentryInitOptions("https://example@sentry.io/1");

    expect(options.replaysSessionSampleRate).toBe(0);
    expect(options.replaysOnErrorSampleRate).toBeGreaterThan(0);
    expect(options.dsn).toBe("https://example@sentry.io/1");
    expect(options.environment).toBe(import.meta.env.MODE);
    expect(options.release).toBe(__APP_RELEASE__);
  });

  it("wires replay integration with strict masking", () => {
    buildSentryInitOptions("https://example@sentry.io/1");

    expect(sentrySdk.replayIntegration).toHaveBeenCalledWith({
      maskAllText: true,
      blockAllMedia: true,
    });
  });

  it("scrubs title-bearing refs from events before send", () => {
    const options = buildSentryInitOptions("https://example@sentry.io/1");

    expect(options.beforeSend).toBeDefined();
    expect(options.beforeBreadcrumb).toBeDefined();
  });
});

describe("initSentry", () => {
  it("initializes Sentry when a DSN is configured", () => {
    env.SENTRY_DSN = "https://example@sentry.io/1";

    initSentry();

    expect(sentrySdk.init).toHaveBeenCalledOnce();
    expect(sentrySdk.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: "https://example@sentry.io/1",
        replaysSessionSampleRate: 0,
        replaysOnErrorSampleRate: 1.0,
      }),
    );
  });

  it("no-ops when the DSN is absent", () => {
    env.SENTRY_DSN = undefined;

    expect(() => initSentry()).not.toThrow();
    expect(sentrySdk.init).not.toHaveBeenCalled();
  });
});

describe("analytics independence", () => {
  it("never reads analyticsEnabled in sentry wiring", () => {
    const sentrySource = readFileSync(join(import.meta.dirname, "sentry.ts"), "utf8");
    const reportErrorSource = readFileSync(join(import.meta.dirname, "report-error.ts"), "utf8");

    expect(sentrySource).not.toMatch(/analyticsEnabled/);
    expect(reportErrorSource).not.toMatch(/analyticsEnabled/);
  });

  it("initializes even when analytics would be opted out (init is not gated)", () => {
    env.SENTRY_DSN = "https://example@sentry.io/1";

    initSentry();

    expect(sentrySdk.init).toHaveBeenCalledOnce();
  });
});
