import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("posthog-js", async () => (await import("~/test/posthog-mock.js")).posthogModuleMock);
vi.mock("~/lib/env.js", async (importOriginal) =>
  (await import("~/test/posthog-mock.js")).createPosthogEnvMock(importOriginal),
);

import { posthogEnv, posthogSdk, resetPostHogBoundary } from "~/test/posthog-boundary.js";
import { buildPostHogInitOptions, initAnalytics, setAnalyticsEnabled, track } from "./analytics.js";
import { FORBIDDEN_ANALYTICS_PROP_KEYS, sanitizeAnalyticsProps } from "./analytics-events.js";

const readyUser = {
  id: "user-1",
  email: "ada@example.com",
  displayName: "Ada",
  onboardingComplete: true,
  analyticsEnabled: true,
};

afterEach(() => {
  resetPostHogBoundary();
});

describe("buildPostHogInitOptions", () => {
  it("disables session recording and page autocapture", () => {
    expect(buildPostHogInitOptions()).toEqual({
      api_host: "https://us.i.posthog.com",
      disable_session_recording: true,
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      persistence: "localStorage",
      opt_out_capturing_by_default: true,
      opt_out_persistence_by_default: true,
    });
  });
});

describe("initAnalytics", () => {
  it("no-ops when the PostHog key is missing", () => {
    posthogEnv.POSTHOG_KEY = undefined;
    initAnalytics(readyUser);
    expect(posthogSdk.init).not.toHaveBeenCalled();
  });

  it("does not initialize before explicit consent", () => {
    initAnalytics({ ...readyUser, analyticsEnabled: false });
    expect(posthogSdk.init).not.toHaveBeenCalled();
  });

  it("initializes once with session recording disabled", () => {
    initAnalytics(readyUser);
    initAnalytics(readyUser);

    expect(posthogSdk.init).toHaveBeenCalledOnce();
    expect(posthogSdk.init).toHaveBeenCalledWith("phc_test", buildPostHogInitOptions());
    expect(posthogSdk.opt_in_capturing).toHaveBeenCalledWith({ captureEventName: false });
    expect(posthogSdk.stopSessionRecording).toHaveBeenCalled();
  });
});

describe("setAnalyticsEnabled", () => {
  it("withdraws consent, resets identity, and stops capture after init", () => {
    initAnalytics(readyUser);

    setAnalyticsEnabled(false);
    track("feedback_submitted", { type: "bug" });

    expect(posthogSdk.opt_out_capturing).toHaveBeenCalled();
    expect(posthogSdk.stopSessionRecording).toHaveBeenCalled();
    expect(posthogSdk.reset).toHaveBeenCalled();
    expect(posthogSdk.capture).not.toHaveBeenCalled();
  });

  it("opts back in without requiring a reload", () => {
    initAnalytics(readyUser);
    setAnalyticsEnabled(false);

    setAnalyticsEnabled(true);
    track("feedback_submitted", { type: "feature" });

    expect(posthogSdk.opt_in_capturing).toHaveBeenCalled();
    expect(posthogSdk.capture).toHaveBeenCalledWith("feedback_submitted", { type: "feature" });
  });
});

describe("track", () => {
  it("no-ops before init", () => {
    track("circle_created", { currency: "USD" });
    expect(posthogSdk.capture).not.toHaveBeenCalled();
  });

  it("drops unknown events", () => {
    initAnalytics(readyUser);
    // @ts-expect-error intentional malformed event name for contract test
    track("not_a_real_event", { currency: "USD" });
    expect(posthogSdk.capture).not.toHaveBeenCalled();
  });

  it("strips unknown prop keys but still captures allowed props", () => {
    initAnalytics(readyUser);
    track("circle_created", { currency: "USD", ...{ title: "secret" } });
    expect(posthogSdk.capture).toHaveBeenCalledWith("circle_created", { currency: "USD" });
  });

  it("rejects unsupported currency codes", () => {
    initAnalytics(readyUser);
    // @ts-expect-error intentional unsupported currency for runtime guard test
    track("circle_created", { currency: "XYZ" });
    expect(posthogSdk.capture).not.toHaveBeenCalled();
  });

  it("never forwards forbidden keys", () => {
    initAnalytics(readyUser);

    for (const forbidden of FORBIDDEN_ANALYTICS_PROP_KEYS) {
      const props = sanitizeAnalyticsProps("transaction_search_submitted", {
        type: "all",
        status: "all",
        hasQuery: true,
        hasDateRange: false,
        hasAmountRange: false,
        categoryCount: 1,
        recordedByCount: 0,
        paidByCount: 0,
        [forbidden]: "leak",
      });
      expect(props).toEqual({
        type: "all",
        status: "all",
        hasQuery: true,
        hasDateRange: false,
        hasAmountRange: false,
        categoryCount: 1,
        recordedByCount: 0,
        paidByCount: 0,
      });
    }

    track("transaction_search_submitted", {
      type: "all",
      status: "all",
      hasQuery: true,
      hasDateRange: false,
      hasAmountRange: false,
      categoryCount: 1,
      recordedByCount: 0,
      paidByCount: 0,
      ...{ query: "rent" },
    });
    expect(posthogSdk.capture).toHaveBeenLastCalledWith("transaction_search_submitted", {
      type: "all",
      status: "all",
      hasQuery: true,
      hasDateRange: false,
      hasAmountRange: false,
      categoryCount: 1,
      recordedByCount: 0,
      paidByCount: 0,
    });
  });

  it("captures whitelisted circle_created props", () => {
    initAnalytics(readyUser);
    track("circle_created", { currency: "EUR" });
    expect(posthogSdk.capture).toHaveBeenCalledWith("circle_created", { currency: "EUR" });
  });

  it("does not throw when PostHog capture rejects", () => {
    initAnalytics(readyUser);
    posthogSdk.capture.mockImplementation(() => {
      throw new Error("posthog down");
    });

    expect(() => track("feedback_submitted", { type: "bug" })).not.toThrow();
  });
});

describe("analytics independence", () => {
  it("never reads analyticsEnabled in sentry wiring", () => {
    const sentrySource = readFileSync(join(import.meta.dirname, "sentry.ts"), "utf8");
    const reportErrorSource = readFileSync(join(import.meta.dirname, "report-error.ts"), "utf8");

    expect(sentrySource).not.toMatch(/analyticsEnabled/);
    expect(reportErrorSource).not.toMatch(/analyticsEnabled/);
    expect(sentrySource).not.toMatch(/posthog/i);
    expect(reportErrorSource).not.toMatch(/posthog/i);
  });
});
