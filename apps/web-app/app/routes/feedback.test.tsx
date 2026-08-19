import { MUTATION_ERRORS, mutationErrorData } from "@pocketcircle/domain";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { Route } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RETURN_TO_PARAM } from "~/lib/return-to-url.js";
import {
  configureConvex,
  convexReactMock,
  makeCurrentUserView,
  renderRoutes,
} from "~/test/convex-react.js";
import {
  posthogSdk,
  primeAnalyticsForTests,
  resetPostHogBoundary,
} from "~/test/posthog-boundary.js";

vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);
vi.mock("posthog-js", async () => (await import("~/test/posthog-mock.js")).posthogModuleMock);

import Feedback from "./feedback.js";

function renderFeedback(initialEntries = ["/feedback"]) {
  return renderRoutes(
    <>
      <Route path="/" element={<div>home-screen</div>} />
      <Route path="/feedback" element={<Feedback />} />
      <Route path="/circles/:circleRef/transactions" element={<div>ledger</div>} />
    </>,
    { initialEntries },
  );
}

beforeEach(() => {
  convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });
  primeAnalyticsForTests();
});

afterEach(() => {
  resetPostHogBoundary();
  vi.clearAllMocks();
});

describe("Global Feedback", () => {
  it("shows Circle context None and submits without circleId", async () => {
    const submitFeedback = vi.fn().mockResolvedValue(undefined);
    configureConvex({
      currentUser: makeCurrentUserView({
        email: "ada@example.com",
        displayName: "Ada Lovelace",
      }),
      submitFeedback,
    });
    const user = userEvent.setup();
    renderFeedback();

    expect(await screen.findByText(/Ada Lovelace/)).toBeInTheDocument();
    expect(screen.getByText(/ada@example.com/)).toBeInTheDocument();
    expect(screen.getAllByText(__APP_VERSION__, { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getByText(/Circle context:/).closest("p")).toHaveTextContent(
      "Circle context: None",
    );

    await user.type(screen.getByLabelText("Message"), "Please add dark mode");
    await user.click(screen.getByRole("button", { name: "Send feedback" }));

    await waitFor(() => {
      expect(submitFeedback).toHaveBeenCalledWith({
        type: "bug",
        message: "Please add dark mode",
        appVersion: __APP_VERSION__,
      });
    });
    expect(submitFeedback.mock.calls[0]?.[0]).not.toHaveProperty("circleId");
    expect(submitFeedback.mock.calls[0]?.[0]).not.toHaveProperty("circleRef");
    expect(submitFeedback.mock.calls[0]?.[0]).not.toHaveProperty("circleName");
  });

  it("blocks submit when the message is empty", async () => {
    configureConvex({
      currentUser: makeCurrentUserView(),
      submitFeedback: vi.fn(),
    });
    renderFeedback();

    expect(await screen.findByRole("button", { name: "Send feedback" })).toBeDisabled();
  });

  it("submits trimmed feedback, disables while pending, and clears on success", async () => {
    let resolveSubmit: (() => void) | undefined;
    const submitFeedback = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    configureConvex({
      currentUser: makeCurrentUserView(),
      submitFeedback,
    });
    const user = userEvent.setup();
    const view = renderFeedback();

    const message = await screen.findByLabelText("Message");
    await user.type(message, "  Please add dark mode  ");
    const submit = screen.getByRole("button", { name: "Send feedback" });
    await user.click(submit);

    expect(submit).toBeDisabled();
    expect(submitFeedback).toHaveBeenCalledWith({
      type: "bug",
      message: "Please add dark mode",
      appVersion: __APP_VERSION__,
    });

    resolveSubmit?.();
    await waitFor(() => {
      expect(screen.getByText("Thanks — your feedback was sent.")).toBeInTheDocument();
    });
    expect(posthogSdk.capture).toHaveBeenCalledWith("feedback_submitted", { type: "bug" });
    expect(posthogSdk.capture.mock.calls[0]?.[1]).toEqual({ type: "bug" });
    expect(message).toHaveValue("");
    expect(screen.getByRole("button", { name: "Send feedback" })).toBeDisabled();
    expect(view.location()).toBe("/feedback");
  });

  it("does not call submitFeedback when validation fails on submit", async () => {
    const submitFeedback = vi.fn();
    configureConvex({
      currentUser: makeCurrentUserView(),
      submitFeedback,
    });
    renderFeedback();

    const message = await screen.findByLabelText("Message");
    const form = message.closest("form");
    if (!form) throw new Error("feedback form missing");
    fireEvent.submit(form);

    expect(screen.getByText("Message is required")).toBeInTheDocument();
    expect(submitFeedback).not.toHaveBeenCalled();
  });

  it("shows the coded daily-cap user message", async () => {
    const submitFeedback = vi
      .fn()
      .mockRejectedValue(
        new ConvexError(mutationErrorData(MUTATION_ERRORS.feedbackDailyCapReached)),
      );
    configureConvex({
      currentUser: makeCurrentUserView(),
      submitFeedback,
    });
    const user = userEvent.setup();
    renderFeedback();

    await user.type(await screen.findByLabelText("Message"), "Another one");
    await user.click(screen.getByRole("button", { name: "Send feedback" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You've sent too much feedback today. Try again tomorrow.",
    );
  });

  it("shows a fallback alert for unexpected failures", async () => {
    const submitFeedback = vi.fn().mockRejectedValue(new Error("network"));
    configureConvex({
      currentUser: makeCurrentUserView(),
      submitFeedback,
    });
    const user = userEvent.setup();
    renderFeedback();

    await user.type(await screen.findByLabelText("Message"), "Broken");
    await user.click(screen.getByRole("button", { name: "Send feedback" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't send your feedback. Please try again.",
    );
  });

  it("returns Back to a valid Circle-scoped returnTo", () => {
    const origin = "/circles/trip-c1/transactions?month=2026-05";
    configureConvex({
      currentUser: makeCurrentUserView(),
      submitFeedback: vi.fn(),
    });
    renderFeedback([`/feedback?${RETURN_TO_PARAM}=${encodeURIComponent(origin)}`]);

    expect(screen.getByRole("link", { name: /Back/ })).toHaveAttribute("href", origin);
  });

  it.each([
    ["missing returnTo", "/feedback"],
    ["protocol-relative", `/feedback?${RETURN_TO_PARAM}=${encodeURIComponent("//evil.com")}`],
    ["cross-origin", `/feedback?${RETURN_TO_PARAM}=${encodeURIComponent("https://evil.com")}`],
    ["non-Circle path", `/feedback?${RETURN_TO_PARAM}=${encodeURIComponent("/settings")}`],
  ])("falls back to Home for %s", (_name, url) => {
    configureConvex({
      currentUser: makeCurrentUserView(),
      submitFeedback: vi.fn(),
    });
    renderFeedback([url]);

    expect(screen.getByRole("link", { name: /Back/ })).toHaveAttribute("href", "/");
  });

  it("does not import PostHog directly", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const dir = dirname(fileURLToPath(import.meta.url));
    const moduleText = readFileSync(join(dir, "../components/feedback-page.tsx"), "utf8");
    expect(moduleText).not.toMatch(/from\s+["'][^"']*posthog/i);
    expect(moduleText).not.toMatch(/import\s*\(\s*["'][^"']*posthog/i);
    expect(moduleText).toMatch(/from\s+["']~\/lib\/analytics\.js["']/);
  });
});
