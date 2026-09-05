import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/react", async () => (await import("~/test/sentry-mock.js")).sentryModuleMock);

const env = vi.hoisted(() => {
  const mock: { SENTRY_DSN: string | undefined } = { SENTRY_DSN: undefined };
  return mock;
});

vi.mock("./env.js", () => env);

import * as SentryReact from "@sentry/react";
import { resetSentryBoundary, sentrySdk } from "~/test/sentry-boundary.js";
import { buildSentryInitOptions, initSentry } from "./sentry.js";

afterEach(async () => {
  env.SENTRY_DSN = undefined;
  await resetSentryBoundary();
});

describe("buildSentryInitOptions", () => {
  it("samples no normal sessions and replays on every error", () => {
    const options = buildSentryInitOptions("https://example@sentry.io/1", SentryReact);

    expect(options.replaysSessionSampleRate).toBe(0);
    expect(options.replaysOnErrorSampleRate).toBeGreaterThan(0);
    expect(options.dsn).toBe("https://example@sentry.io/1");
    expect(options.environment).toBe(import.meta.env.MODE);
    expect(options.release).toBe(__APP_RELEASE__);
  });

  it("wires replay integration with strict masking", () => {
    buildSentryInitOptions("https://example@sentry.io/1", SentryReact);

    expect(sentrySdk.replayIntegration).toHaveBeenCalledWith({
      maskAllText: true,
      blockAllMedia: true,
    });
  });

  it("scrubs title-bearing refs from events before send", () => {
    const options = buildSentryInitOptions("https://example@sentry.io/1", SentryReact);

    expect(options.beforeSend).toBeDefined();
    expect(options.beforeBreadcrumb).toBeDefined();
  });
});

describe("initSentry", () => {
  it("initializes Sentry when a DSN is configured", async () => {
    env.SENTRY_DSN = "https://example@sentry.io/1";

    await initSentry();

    expect(sentrySdk.init).toHaveBeenCalledOnce();
    expect(sentrySdk.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: "https://example@sentry.io/1",
        replaysSessionSampleRate: 0,
        replaysOnErrorSampleRate: 1.0,
      }),
    );
  });

  it("no-ops when the DSN is absent", async () => {
    env.SENTRY_DSN = undefined;

    await expect(initSentry()).resolves.toBeUndefined();
    expect(sentrySdk.init).not.toHaveBeenCalled();
  });

  it("does not statically import @sentry/react (keeps SDK off the entry chunk)", () => {
    const sentrySource = readFileSync(join(import.meta.dirname, "sentry.ts"), "utf8");
    const entrySource = readFileSync(join(import.meta.dirname, "../entry.client.tsx"), "utf8");

    expect(sentrySource).not.toMatch(/^import .* from ["']@sentry\/react["']/m);
    expect(sentrySource).toMatch(/await import\(["']@sentry\/react["']\)/);
    expect(entrySource).not.toMatch(/from ["']\.\/lib\/sentry/);
    expect(entrySource).toMatch(/import\(["']\.\/lib\/sentry\.js["']\)/);
  });
});

describe("analytics independence", () => {
  it("never reads analyticsEnabled in sentry wiring", () => {
    const sentrySource = readFileSync(join(import.meta.dirname, "sentry.ts"), "utf8");
    const reportErrorSource = readFileSync(join(import.meta.dirname, "report-error.ts"), "utf8");

    expect(sentrySource).not.toMatch(/analyticsEnabled/);
    expect(reportErrorSource).not.toMatch(/analyticsEnabled/);
  });

  it("initializes even when analytics would be opted out (init is not gated)", async () => {
    env.SENTRY_DSN = "https://example@sentry.io/1";

    await initSentry();

    expect(sentrySdk.init).toHaveBeenCalledOnce();
  });
});
