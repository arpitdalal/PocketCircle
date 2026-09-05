import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sentrySdk } from "~/test/sentry-mock.js";
import { handleUnavailableRefLink, handleUnparseableRefLink } from "./ref-link-failure.js";
import { redactRefForTelemetry } from "./refs.js";
import { flushReportAppErrorForTests } from "./report-error.js";
import { resetSentryReadyForTests } from "./sentry.js";

vi.mock("@sentry/react", async () => (await import("~/test/sentry-mock.js")).sentryModuleMock);
vi.mock("./env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./env.js")>();
  return { ...actual, SENTRY_DSN: "https://example@sentry.io/1" };
});

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  await flushReportAppErrorForTests();
  warnSpy.mockRestore();
  vi.clearAllMocks();
  resetSentryReadyForTests();
});

describe("ref-link-failure", () => {
  it("reports an unparseable ref and marks consumed without a snackbar by default", async () => {
    const showUnavailable = vi.fn();
    const onConsumed = vi.fn();

    handleUnparseableRefLink({
      rawRef: "bad-ref",
      reportMessage: "Unparseable categoryRef in URL",
      showUnavailable,
      onConsumed,
    });

    await flushReportAppErrorForTests();
    expect(sentrySdk.captureMessage).toHaveBeenCalledWith("Unparseable categoryRef in URL", {
      extra: { rawRef: redactRefForTelemetry("bad-ref") },
    });
    expect(showUnavailable).not.toHaveBeenCalled();
    expect(onConsumed).toHaveBeenCalledOnce();
  });

  it("reports and shows unavailable when alsoShowUnavailable is set", async () => {
    const showUnavailable = vi.fn();
    const onConsumed = vi.fn();

    handleUnparseableRefLink({
      rawRef: "bad-ref",
      reportMessage: "Unparseable ref in URL",
      showUnavailable,
      unavailableTarget: "circle",
      alsoShowUnavailable: true,
      onConsumed,
    });

    await flushReportAppErrorForTests();
    expect(sentrySdk.captureMessage).toHaveBeenCalledOnce();
    expect(showUnavailable).toHaveBeenCalledWith("circle");
    expect(onConsumed).toHaveBeenCalledOnce();
  });

  it("fires the unavailable snackbar for a missing target", async () => {
    const showUnavailable = vi.fn();
    const onConsumed = vi.fn();

    handleUnavailableRefLink({
      showUnavailable,
      onConsumed,
    });

    await flushReportAppErrorForTests();
    expect(showUnavailable).toHaveBeenCalledWith("link");
    expect(onConsumed).toHaveBeenCalledOnce();
    expect(sentrySdk.captureMessage).not.toHaveBeenCalled();
  });
});
