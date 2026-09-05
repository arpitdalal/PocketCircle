import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The primitive owns navigation, the current location, the snackbar, and error
// reporting. We stub the genuine boundaries — `react-router`'s context hooks and
// the snackbar provider hook (renderHook has neither) — so the state machine is
// asserted in isolation, exactly as ADR 0017 intends ("test the primitive
// directly"). Error reporting is NOT stubbed at our own seam: we mock the true
// boundary (`@sentry/react`) and let the real `reportAppError` run, so a report
// is observed via `captureMessage` (CLAUDE.md: mock only third-party boundaries).
// `location` is mutable so each test sets the URL it canonicalizes.
const { navigate, showUnavailable, location, captureMessage, init, replayIntegration } = vi.hoisted(
  () => ({
    navigate: vi.fn(),
    showUnavailable: vi.fn(),
    location: { pathname: "/circles/home-c1", search: "", hash: "" },
    captureMessage: vi.fn(),
    init: vi.fn(),
    replayIntegration: vi.fn(() => ({ name: "Replay" })),
  }),
);
vi.mock("react-router", () => ({
  useNavigate: () => navigate,
  useLocation: () => location,
}));
vi.mock("./snackbar.js", () => ({
  useSnackbar: () => ({ show: vi.fn(), showUnavailable }),
}));
vi.mock("@sentry/react", () => ({ captureMessage, init, replayIntegration }));
vi.mock("./env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./env.js")>();
  return { ...actual, SENTRY_DSN: "https://example@sentry.io/1" };
});

import { flushReportAppErrorForTests } from "./report-error.js";
import { resetSentryReadyForTests } from "./sentry.js";
import { type ResolvedRefOptions, useResolvedRef } from "./use-resolved-ref.js";

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // `reportAppError` console.warns in dev; silence it so the suite stays quiet.
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

interface TestRef {
  ref: string;
  name: string;
}

function resolve(overrides: Partial<ResolvedRefOptions<TestRef>>) {
  const options: ResolvedRefOptions<TestRef> = {
    rawRef: "home-c1",
    parsed: true,
    value: undefined,
    fallback: "/",
    ...overrides,
  };
  return renderHook(() => useResolvedRef(options)).result.current;
}

afterEach(async () => {
  await flushReportAppErrorForTests();
  warnSpy.mockRestore();
  vi.clearAllMocks();
  resetSentryReadyForTests();
  location.pathname = "/circles/home-c1";
  location.search = "";
  location.hash = "";
});

describe("useResolvedRef", () => {
  it("is pending while the value is loading, with no side effects", () => {
    const result = resolve({ value: undefined });
    expect(result).toEqual({ status: "pending" });
    expect(navigate).not.toHaveBeenCalled();
    expect(showUnavailable).not.toHaveBeenCalled();
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it("is ready when the value resolves on its canonical ref, with no navigation", () => {
    const value: TestRef = { ref: "home-c1", name: "Home" };
    const result = resolve({ value });
    expect(result).toEqual({ status: "ready", value });
    expect(navigate).not.toHaveBeenCalled();
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it("falls back and reports when the ref is unparseable (an app-emitted bad link)", async () => {
    resolve({ parsed: false, value: undefined, fallback: "/safe" });
    expect(showUnavailable).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith("/safe", { replace: true });
    await flushReportAppErrorForTests();
    expect(captureMessage).toHaveBeenCalledOnce();
  });

  it("falls back silently when the target is inaccessible (no report — permission outcome)", async () => {
    resolve({ parsed: true, value: null, fallback: "/safe" });
    expect(showUnavailable).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith("/safe", { replace: true });
    await flushReportAppErrorForTests();
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it("fires the default 'link' unavailable message when no target is given", () => {
    resolve({ parsed: true, value: null });
    expect(showUnavailable).toHaveBeenCalledWith("link");
  });

  it("fires the caller's unavailable target token (e.g. the Circle guard's 'circle')", () => {
    resolve({ parsed: true, value: null, unavailableTarget: "circle" });
    expect(showUnavailable).toHaveBeenCalledWith("circle");
  });

  it("canonicalizes a stale bare-id ref via replace navigation without a snackbar", () => {
    location.pathname = "/circles/c1";
    const value: TestRef = { ref: "home-c1", name: "Home" };
    resolve({ rawRef: "c1", value }); // bare id ⇒ stale vs canonical "home-c1"
    expect(navigate).toHaveBeenCalledWith("/circles/home-c1", { replace: true });
    expect(showUnavailable).not.toHaveBeenCalled();
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it("preserves the child route segment when canonicalizing a stale ref", () => {
    location.pathname = "/circles/c1/transactions";
    const value: TestRef = { ref: "home-c1", name: "Home" };
    resolve({ rawRef: "c1", value });
    expect(navigate).toHaveBeenCalledWith("/circles/home-c1/transactions", {
      replace: true,
    });
  });

  it("preserves query and hash when canonicalizing a stale ref", () => {
    location.pathname = "/circles/c1/transactions";
    location.search = "?month=2026-05";
    location.hash = "#row-3";
    const value: TestRef = { ref: "home-c1", name: "Home" };
    resolve({ rawRef: "c1", value });
    expect(navigate).toHaveBeenCalledWith("/circles/home-c1/transactions?month=2026-05#row-3", {
      replace: true,
    });
  });

  it("rewrites only the exact stale segment, never a substring of another", () => {
    // `c1` is also a substring of the trailing segment; a naive string replace
    // would corrupt it. Exact-segment matching must leave `x-c1-archive` intact.
    location.pathname = "/circles/c1/x-c1-archive";
    const value: TestRef = { ref: "home-c1", name: "Home" };
    resolve({ rawRef: "c1", value });
    expect(navigate).toHaveBeenCalledWith("/circles/home-c1/x-c1-archive", {
      replace: true,
    });
  });

  it("rewrites only the Circle segment on a deep nested object path (ADR 0016)", () => {
    // ADR 0016's own example: /circles/<circleRef>/transactions/<objectRef>.
    // The stale Circle segment is rewritten; the object ref segment is preserved.
    location.pathname = "/circles/c1/transactions/rent-t1";
    const value: TestRef = { ref: "home-c1", name: "Home" };
    resolve({ rawRef: "c1", value });
    expect(navigate).toHaveBeenCalledWith("/circles/home-c1/transactions/rent-t1", {
      replace: true,
    });
  });

  it("does not navigate when the ref is already canonical", () => {
    location.pathname = "/circles/home-c1/transactions";
    const value: TestRef = { ref: "home-c1", name: "Home" };
    const result = resolve({ rawRef: "home-c1", value });
    expect(result).toEqual({ status: "ready", value });
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("useResolvedRef — disabled (inert)", () => {
  it("is pending with no effects for an unparseable ref when disabled", () => {
    // The key case: a malformed ref must NOT fire the unavailable/report path while the
    // adapter has disabled resolution (e.g. an archived read-only route that redirects
    // itself) — otherwise the generic bad-link snackbar races the route's own nav.
    const result = resolve({ enabled: false, parsed: false, value: undefined });
    expect(result).toEqual({ status: "pending" });
    expect(navigate).not.toHaveBeenCalled();
    expect(showUnavailable).not.toHaveBeenCalled();
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it("is pending with no fallback for a null (inaccessible) value when disabled", () => {
    const result = resolve({ enabled: false, parsed: true, value: null, fallback: "/safe" });
    expect(result).toEqual({ status: "pending" });
    expect(navigate).not.toHaveBeenCalled();
    expect(showUnavailable).not.toHaveBeenCalled();
  });

  it("does not canonicalize a stale ref when disabled", () => {
    location.pathname = "/circles/c1";
    const value: TestRef = { ref: "home-c1", name: "Home" };
    resolve({ enabled: false, rawRef: "c1", value });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("stays pending even with a ready value when disabled", () => {
    const value: TestRef = { ref: "home-c1", name: "Home" };
    const result = resolve({ enabled: false, rawRef: "home-c1", value });
    expect(result).toEqual({ status: "pending" });
    expect(navigate).not.toHaveBeenCalled();
  });
});
