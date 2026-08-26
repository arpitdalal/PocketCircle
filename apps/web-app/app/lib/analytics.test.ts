import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("posthog-js", async () => (await import("~/test/posthog-mock.js")).posthogModuleMock);

import type { CaptureResult } from "posthog-js";
import {
  posthogSdk,
  resetPostHogBoundary,
  stubPosthogEnvForTests,
} from "~/test/posthog-boundary.js";
import {
  buildPostHogInitOptions,
  initAnalytics,
  retiredPostHogStorageKeys,
  revertPendingAnalyticsEnabled,
  setAnalyticsEnabled,
  teardownAnalytics,
  track,
} from "./analytics.js";
import { FORBIDDEN_ANALYTICS_PROP_KEYS, sanitizeAnalyticsProps } from "./analytics-events.js";

const readyUser = {
  id: "user-1",
  email: "ada@example.com",
  displayName: "Ada",
  onboardingComplete: true,
  analyticsEnabled: true,
};

function beforeSend(event: CaptureResult) {
  const { before_send } = buildPostHogInitOptions();
  if (typeof before_send !== "function") {
    throw new Error("expected before_send");
  }
  return before_send(event);
}

beforeEach(() => {
  stubPosthogEnvForTests();
});

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetPostHogBoundary();
});

describe("buildPostHogInitOptions", () => {
  it("uses memory persistence and disables session recording, page autocapture, and URL capture", () => {
    const options = buildPostHogInitOptions();

    expect(options).toMatchObject({
      api_host: "https://us.i.posthog.com",
      disable_session_recording: true,
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      persistence: "memory",
      person_profiles: "never",
      save_referrer: false,
      save_campaign_params: false,
      opt_out_persistence_by_default: true,
    });
    expect("opt_out_capturing_by_default" in options).toBe(false);
    expect(options.property_denylist).toEqual(
      expect.arrayContaining(["$current_url", "$pathname", "$referrer", "$title", "$host"]),
    );
    expect(options.before_send).toEqual(expect.any(Function));
  });
});

describe("initAnalytics", () => {
  it("no-ops when the PostHog key is missing", () => {
    stubPosthogEnvForTests("");
    initAnalytics(readyUser);
    expect(posthogSdk.init).not.toHaveBeenCalled();
  });

  it("does not initialize when analytics are disabled", () => {
    initAnalytics({ ...readyUser, analyticsEnabled: false });
    expect(posthogSdk.init).not.toHaveBeenCalled();
  });

  it("wipes leftover PostHog browser storage even when analytics stay disabled", () => {
    window.localStorage.setItem("ph_phc_test_posthog", "{}");
    window.localStorage.setItem("__ph_opt_in_out_phc_test", "1");
    window.localStorage.setItem("unrelated", "keep");

    initAnalytics({ ...readyUser, analyticsEnabled: false });

    expect(window.localStorage.getItem("ph_phc_test_posthog")).toBeNull();
    expect(window.localStorage.getItem("__ph_opt_in_out_phc_test")).toBeNull();
    expect(window.localStorage.getItem("unrelated")).toBe("keep");
    expect(posthogSdk.init).not.toHaveBeenCalled();
  });

  it("initializes once with session recording disabled and without persisted consent APIs", () => {
    initAnalytics(readyUser);
    initAnalytics(readyUser);

    expect(posthogSdk.init).toHaveBeenCalledOnce();
    expect(posthogSdk.init).toHaveBeenCalledWith("phc_test", buildPostHogInitOptions());
    expect(posthogSdk.opt_in_capturing).not.toHaveBeenCalled();
    expect(posthogSdk.opt_out_capturing).not.toHaveBeenCalled();
    expect(posthogSdk.stopSessionRecording).toHaveBeenCalled();
  });

  it("resets PostHog identity when the authenticated user changes", () => {
    initAnalytics(readyUser);
    initAnalytics({ ...readyUser, id: "user-2" });

    expect(posthogSdk.reset).toHaveBeenCalledWith(true);
    expect(posthogSdk.init).toHaveBeenCalledOnce();
    track("feedback_submitted", { type: "bug" });
    expect(posthogSdk.capture).toHaveBeenCalledWith("feedback_submitted", { type: "bug" });
  });

  it("stops capture when the same user disables analytics", () => {
    initAnalytics(readyUser);
    initAnalytics({ ...readyUser, analyticsEnabled: false });
    track("feedback_submitted", { type: "bug" });

    expect(posthogSdk.reset).toHaveBeenCalledWith(true);
    expect(posthogSdk.opt_out_capturing).not.toHaveBeenCalled();
    expect(posthogSdk.capture).not.toHaveBeenCalled();
  });
});

describe("retiredPostHogStorageKeys", () => {
  it("selects the retired localStorage persistence record and consent flag for this project", () => {
    expect(
      retiredPostHogStorageKeys(
        [
          "ph_phc_test_posthog",
          "__ph_opt_in_out_phc_test",
          "ph_phc_test_window_id",
          "ph_debug",
          "unrelated",
          "ph_other_token_posthog",
        ],
        "phc_test",
      ),
    ).toEqual([
      "ph_phc_test_posthog",
      "__ph_opt_in_out_phc_test",
      "ph_phc_test_window_id",
      "ph_debug",
    ]);
  });
});

describe("teardownAnalytics", () => {
  it("clears in-memory identity so a later user does not reuse the previous session", () => {
    initAnalytics(readyUser);
    teardownAnalytics();
    track("feedback_submitted", { type: "bug" });
    expect(posthogSdk.capture).not.toHaveBeenCalled();

    initAnalytics({ ...readyUser, id: "user-2" });
    expect(posthogSdk.reset).toHaveBeenCalledWith(true);
    expect(posthogSdk.init).toHaveBeenCalledTimes(2);
  });
});

describe("setAnalyticsEnabled", () => {
  it("stops capture, resets in-memory state, and ignores later track calls", () => {
    initAnalytics(readyUser);

    setAnalyticsEnabled(false);
    track("feedback_submitted", { type: "bug" });

    expect(posthogSdk.opt_out_capturing).not.toHaveBeenCalled();
    expect(posthogSdk.stopSessionRecording).toHaveBeenCalled();
    expect(posthogSdk.reset).toHaveBeenCalledWith(true);
    expect(posthogSdk.capture).not.toHaveBeenCalled();
  });

  it("opts back in without requiring a reload or writing PostHog consent", () => {
    initAnalytics(readyUser);
    setAnalyticsEnabled(false);

    setAnalyticsEnabled(true);
    track("feedback_submitted", { type: "feature" });

    expect(posthogSdk.opt_in_capturing).not.toHaveBeenCalled();
    expect(posthogSdk.capture).toHaveBeenCalledWith("feedback_submitted", { type: "feature" });
  });

  it("keeps a local opt-out when the session still reports analytics enabled", () => {
    initAnalytics(readyUser);
    setAnalyticsEnabled(false);
    initAnalytics(readyUser);
    track("feedback_submitted", { type: "bug" });

    expect(posthogSdk.capture).not.toHaveBeenCalled();
  });

  it("clears a failed-toggle override so a later session opt-out can take effect", () => {
    initAnalytics(readyUser);
    setAnalyticsEnabled(false);
    revertPendingAnalyticsEnabled(true);
    initAnalytics({ ...readyUser, analyticsEnabled: false });
    track("feedback_submitted", { type: "bug" });

    expect(posthogSdk.capture).not.toHaveBeenCalled();
  });
});

describe("outgoing capture scrubbing", () => {
  it("drops automatic URL fields and person-profile payloads from allowlisted events", () => {
    initAnalytics(readyUser);

    expect(
      beforeSend({
        uuid: "evt-1",
        event: "circle_created",
        properties: {
          currency: "USD",
          $browser: "Chrome",
          $current_url: "https://app.example/circles/family-circle-abc",
          $pathname: "/circles/family-circle-abc?q=rent",
          $referrer: "https://mail.example/inbox",
          $title: "Family Circle",
        },
        $set: { email: "ada@example.com" },
        $set_once: { $initial_current_url: "https://app.example/circles/secret" },
      }),
    ).toEqual({
      uuid: "evt-1",
      event: "circle_created",
      properties: {
        currency: "USD",
        $browser: "Chrome",
      },
    });
  });

  it("drops SDK events that are not on the product allowlist", () => {
    initAnalytics(readyUser);

    expect(
      beforeSend({
        uuid: "evt-2",
        event: "$pageview",
        properties: { $current_url: "https://app.example/circles/family-circle-abc" },
      }),
    ).toBeNull();
  });

  it("drops events until capture is enabled after init", () => {
    expect(
      beforeSend({
        uuid: "evt-3",
        event: "circle_created",
        properties: { currency: "USD" },
      }),
    ).toBeNull();

    initAnalytics(readyUser);
    setAnalyticsEnabled(false);
    expect(
      beforeSend({
        uuid: "evt-4",
        event: "circle_created",
        properties: { currency: "USD" },
      }),
    ).toBeNull();
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

  it("captures save_and_new_clicked only with the exact entity/surface matrix", () => {
    initAnalytics(readyUser);

    const transactionGlobal = { entity: "transaction", surface: "global" } as const;
    const categoryScoped = { entity: "category", surface: "circle_scoped" } as const;
    expect(sanitizeAnalyticsProps("save_and_new_clicked", transactionGlobal)).toEqual(
      transactionGlobal,
    );
    expect(sanitizeAnalyticsProps("save_and_new_clicked", categoryScoped)).toEqual(categoryScoped);
    track("save_and_new_clicked", transactionGlobal);
    expect(posthogSdk.capture).toHaveBeenLastCalledWith("save_and_new_clicked", transactionGlobal);
  });

  it("rejects invalid save_and_new_clicked payloads", () => {
    initAnalytics(readyUser);

    expect(
      sanitizeAnalyticsProps("save_and_new_clicked", {
        // @ts-expect-error intentional unsupported entity
        entity: "circle",
        surface: "global",
      }),
    ).toBeNull();
    expect(
      sanitizeAnalyticsProps("save_and_new_clicked", {
        entity: "transaction",
        // @ts-expect-error intentional unsupported surface
        surface: "home",
      }),
    ).toBeNull();
    expect(
      sanitizeAnalyticsProps(
        "save_and_new_clicked",
        // @ts-expect-error intentionally missing surface
        { entity: "transaction" },
      ),
    ).toBeNull();
    // Forbidden / unknown extras are stripped; only the exact allowlisted pair survives.
    expect(
      sanitizeAnalyticsProps("save_and_new_clicked", {
        entity: "transaction",
        surface: "global",
        // @ts-expect-error intentional forbidden financial content
        amount: 12,
        title: "leak",
      }),
    ).toEqual({ entity: "transaction", surface: "global" });
    track("save_and_new_clicked", {
      // @ts-expect-error intentional unsupported entity
      entity: "member",
      surface: "circle_scoped",
    });
    expect(posthogSdk.capture).not.toHaveBeenCalled();
  });

  it("captures transaction_added only with the full coarse payload incl. surface and method", () => {
    initAnalytics(readyUser);

    const circleScopedManual = {
      type: "expense",
      paidBySelf: true,
      categoryCount: 2,
      surface: "circle_scoped",
      method: "manual",
    } as const;
    expect(sanitizeAnalyticsProps("transaction_added", circleScopedManual)).toEqual(
      circleScopedManual,
    );
    track("transaction_added", circleScopedManual);
    expect(posthogSdk.capture).toHaveBeenLastCalledWith("transaction_added", circleScopedManual);

    const globalDuplicate = {
      type: "income",
      paidBySelf: false,
      categoryCount: 0,
      surface: "global",
      method: "duplicate",
    } as const;
    expect(sanitizeAnalyticsProps("transaction_added", globalDuplicate)).toEqual(globalDuplicate);
  });

  it("drops transaction_added with an unknown surface or method", () => {
    initAnalytics(readyUser);

    track("transaction_added", {
      type: "expense",
      paidBySelf: true,
      categoryCount: 1,
      // @ts-expect-error intentional unsupported surface for runtime guard test
      surface: "home",
      method: "manual",
    });
    track("transaction_added", {
      type: "expense",
      paidBySelf: true,
      categoryCount: 1,
      surface: "global",
      // @ts-expect-error intentional unsupported method for runtime guard test
      method: "import",
    });
    expect(posthogSdk.capture).not.toHaveBeenCalled();
  });

  it("drops transaction_added missing required surface or method, and strips financial content", () => {
    const coarse = { type: "expense", paidBySelf: true, categoryCount: 1 } as const;

    expect(
      sanitizeAnalyticsProps(
        "transaction_added",
        // @ts-expect-error intentionally missing required surface
        { ...coarse, method: "manual" },
      ),
    ).toBeNull();
    expect(
      sanitizeAnalyticsProps(
        "transaction_added",
        // @ts-expect-error intentionally missing required method
        { ...coarse, surface: "circle_scoped" },
      ),
    ).toBeNull();
    expect(
      sanitizeAnalyticsProps("transaction_added", {
        ...coarse,
        surface: "circle_scoped",
        method: "manual",
        ...{ title: "Weekly shop", amountMinorUnits: 1250, transactionId: "t1", url: "/x" },
      }),
    ).toEqual({
      type: "expense",
      paidBySelf: true,
      categoryCount: 1,
      surface: "circle_scoped",
      method: "manual",
    });
  });

  it("captures activation skip with completedCount 0–3 and empty completion payload", () => {
    initAnalytics(readyUser);

    expect(sanitizeAnalyticsProps("activation_checklist_skipped", { completedCount: 0 })).toEqual({
      completedCount: 0,
    });
    expect(sanitizeAnalyticsProps("activation_checklist_skipped", { completedCount: 3 })).toEqual({
      completedCount: 3,
    });
    expect(
      sanitizeAnalyticsProps("activation_checklist_skipped", { completedCount: 4 }),
    ).toBeNull();
    expect(
      sanitizeAnalyticsProps("activation_checklist_skipped", { completedCount: -1 }),
    ).toBeNull();
    expect(
      sanitizeAnalyticsProps("activation_checklist_skipped", { completedCount: 2.5 }),
    ).toBeNull();
    expect(
      sanitizeAnalyticsProps("activation_checklist_skipped", {
        completedCount: 2,
        ...{ email: "ada@example.com", circleId: "c1" },
      }),
    ).toEqual({ completedCount: 2 });
    expect(sanitizeAnalyticsProps("activation_checklist_completed", {})).toEqual({});
    expect(sanitizeAnalyticsProps("activation_checklist_completed", undefined)).toEqual({});
    expect(
      sanitizeAnalyticsProps(
        "activation_checklist_completed",
        // @ts-expect-error intentional extra key for runtime allowlist
        { email: "ada@example.com" },
      ),
    ).toEqual({});

    track("activation_checklist_skipped", { completedCount: 1 });
    expect(posthogSdk.capture).toHaveBeenCalledWith("activation_checklist_skipped", {
      completedCount: 1,
    });
    track("activation_checklist_completed", {});
    expect(posthogSdk.capture).toHaveBeenCalledWith("activation_checklist_completed", {});
  });

  it("captures whats_new_opened with allowlisted latestVersion only", () => {
    initAnalytics(readyUser);

    expect(sanitizeAnalyticsProps("whats_new_opened", { latestVersion: "v0.2.0" })).toEqual({
      latestVersion: "v0.2.0",
    });
    expect(sanitizeAnalyticsProps("whats_new_opened", { latestVersion: "0.2.0" })).toBeNull();
    expect(sanitizeAnalyticsProps("whats_new_opened", { latestVersion: "local-dev" })).toBeNull();
    expect(sanitizeAnalyticsProps("whats_new_opened", { latestVersion: "v01.0.0" })).toBeNull();
    expect(
      sanitizeAnalyticsProps("whats_new_opened", {
        latestVersion: "v0.2.0",
        ...{ email: "ada@example.com", id: "user-1" },
      }),
    ).toEqual({ latestVersion: "v0.2.0" });

    track("whats_new_opened", { latestVersion: "v0.2.0" });
    expect(posthogSdk.capture).toHaveBeenCalledWith("whats_new_opened", {
      latestVersion: "v0.2.0",
    });
  });

  it("captures feature announcement events with allowlisted announcement only", () => {
    initAnalytics(readyUser);

    for (const event of [
      "feature_announcement_impression",
      "feature_announcement_cta_clicked",
      "feature_announcement_dismissed",
    ] as const) {
      expect(sanitizeAnalyticsProps(event, { announcement: "duplicate-transaction" })).toEqual({
        announcement: "duplicate-transaction",
      });
      expect(
        // @ts-expect-error intentional invalid announcement id for allowlist coverage
        sanitizeAnalyticsProps(event, { announcement: "nope" }),
      ).toBeNull();
      expect(
        sanitizeAnalyticsProps(event, {
          announcement: "duplicate-transaction",
          ...{ circleId: "c1", transactionId: "t1", url: "/circles/x" },
        }),
      ).toEqual({ announcement: "duplicate-transaction" });
      track(event, { announcement: "duplicate-transaction" });
      expect(posthogSdk.capture).toHaveBeenCalledWith(event, {
        announcement: "duplicate-transaction",
      });
    }
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
