import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleUnavailableRefLink, handleUnparseableRefLink } from "./ref-link-failure.js";
import { redactRefForTelemetry } from "./refs.js";
import { flushReportAppErrorForTests } from "./report-error.js";

// Mock the true boundary (`@sentry/react`) and let the real `reportAppError` +
// scrubbing run, so this exercises the actual reporting seam rather than a faked
// one (CLAUDE.md: mock only third-party boundaries).
const captureMessage = vi.hoisted(() => vi.fn());
vi.mock("@sentry/react", () => ({ captureMessage }));

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // `reportAppError` console.warns in dev; silence it so the suite stays quiet.
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  await flushReportAppErrorForTests();
  warnSpy.mockRestore();
  vi.clearAllMocks();
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
    expect(captureMessage).toHaveBeenCalledWith("Unparseable categoryRef in URL", {
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
    expect(captureMessage).toHaveBeenCalledOnce();
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
    expect(captureMessage).not.toHaveBeenCalled();
  });
});
