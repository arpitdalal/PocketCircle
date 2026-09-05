import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const sentrySdk = vi.hoisted(() => ({
  init: vi.fn(),
  captureMessage: vi.fn(),
  replayIntegration: vi.fn(() => ({ name: "Replay" })),
}));

vi.mock("@sentry/react", () => ({
  init: sentrySdk.init,
  captureMessage: sentrySdk.captureMessage,
  replayIntegration: sentrySdk.replayIntegration,
}));

const env = vi.hoisted(() => {
  const mock: { SENTRY_DSN: string | undefined } = { SENTRY_DSN: undefined };
  return mock;
});

vi.mock("./env.js", () => env);

import { flushReportAppErrorForTests, reportAppError } from "./report-error.js";
import { resetSentryReadyForTests } from "./sentry.js";

afterEach(async () => {
  await flushReportAppErrorForTests();
  vi.clearAllMocks();
  env.SENTRY_DSN = undefined;
  resetSentryReadyForTests();
});

describe("reportAppError", () => {
  it("inits Sentry then forwards scrubbed context to captureMessage", async () => {
    env.SENTRY_DSN = "https://example@sentry.io/1";

    reportAppError("Unparseable ref in URL", { rawRef: "grocery-shopping-bad!" });

    await flushReportAppErrorForTests();
    expect(sentrySdk.init).toHaveBeenCalledOnce();
    expect(sentrySdk.captureMessage).toHaveBeenCalledWith("Unparseable ref in URL", {
      extra: { rawRef: "[unparseable-ref]" },
    });
  });

  it("redacts title-bearing refs and drops financial fields before capture", async () => {
    env.SENTRY_DSN = "https://example@sentry.io/1";

    reportAppError("Unparseable ref in URL", {
      rawRef: "weekly-shop-t1abc",
      title: "Weekly shop",
      amountMinorUnits: 500,
    });

    await flushReportAppErrorForTests();
    const [, options] = sentrySdk.captureMessage.mock.calls[0] ?? [];
    expect(options).toEqual({ extra: { rawRef: "t1abc" } });
  });

  it("no-ops capture when DSN is unset", async () => {
    env.SENTRY_DSN = undefined;

    reportAppError("Unparseable ref in URL", { rawRef: "x" });

    await flushReportAppErrorForTests();
    expect(sentrySdk.init).not.toHaveBeenCalled();
    expect(sentrySdk.captureMessage).not.toHaveBeenCalled();
  });

  it("console.warns in dev so local signal is unchanged", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    reportAppError("test error", { rawRef: "x" });

    if (import.meta.env.DEV) {
      expect(warn).toHaveBeenCalledWith("[app] test error", { rawRef: "x" });
    } else {
      expect(warn).not.toHaveBeenCalled();
    }

    warn.mockRestore();
  });

  it("does not statically import @sentry/react", () => {
    const source = readFileSync(join(import.meta.dirname, "report-error.ts"), "utf8");
    expect(source).not.toMatch(/^import .* from ["']@sentry\/react["']/m);
    expect(source).toMatch(/ensureSentryReady/);
  });
});
