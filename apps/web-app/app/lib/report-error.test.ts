import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const captureMessage = vi.hoisted(() => vi.fn());

vi.mock("@sentry/react", () => ({
  captureMessage,
}));

import { flushReportAppErrorForTests, reportAppError } from "./report-error.js";

afterEach(async () => {
  await flushReportAppErrorForTests();
  vi.clearAllMocks();
});

describe("reportAppError", () => {
  it("forwards scrubbed context to Sentry.captureMessage", async () => {
    reportAppError("Unparseable ref in URL", { rawRef: "grocery-shopping-bad!" });

    await flushReportAppErrorForTests();
    expect(captureMessage).toHaveBeenCalledWith("Unparseable ref in URL", {
      extra: { rawRef: "[unparseable-ref]" },
    });
  });

  it("redacts title-bearing refs and drops financial fields before capture", async () => {
    reportAppError("Unparseable ref in URL", {
      rawRef: "weekly-shop-t1abc",
      title: "Weekly shop",
      amountMinorUnits: 500,
    });

    await flushReportAppErrorForTests();
    const [, options] = captureMessage.mock.calls[0] ?? [];
    expect(options).toEqual({ extra: { rawRef: "t1abc" } });
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
    expect(source).toMatch(/import\(["']@sentry\/react["']\)/);
  });
});
