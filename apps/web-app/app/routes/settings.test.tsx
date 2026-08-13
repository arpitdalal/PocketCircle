import { MUTATION_ERRORS, mutationErrorData } from "@pocketcircle/domain";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountDeletionBlocker } from "~/lib/data.js";
import { SnackbarProvider } from "~/lib/snackbar.js";
import {
  configureConvex,
  convexReactMock,
  makeAccountDeletionBlocker,
  makeCurrentUserView,
  testId,
} from "~/test/convex-react.js";
import {
  posthogSdk,
  primeAnalyticsForTests,
  resetPostHogBoundary,
} from "~/test/posthog-boundary.js";

const auth = vi.hoisted(() => ({
  deleteUser: vi.fn(),
}));

vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);
vi.mock("posthog-js", async () => (await import("~/test/posthog-mock.js")).posthogModuleMock);
vi.mock("~/lib/env.js", async (importOriginal) =>
  (await import("~/test/posthog-mock.js")).createPosthogEnvMock(importOriginal),
);
vi.mock("@convex-dev/better-auth/client/plugins", () => ({
  convexClient: vi.fn(),
  crossDomainClient: vi.fn(),
}));
vi.mock("better-auth/react", () => ({
  createAuthClient: vi.fn(() => ({
    deleteUser: auth.deleteUser,
  })),
}));

import { initAnalytics, track } from "~/lib/analytics.js";
import Settings from "./settings.js";

function renderSettings() {
  return render(
    <SnackbarProvider>
      <MemoryRouter>
        <Settings />
      </MemoryRouter>
    </SnackbarProvider>,
  );
}

beforeEach(() => {
  convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });
  primeAnalyticsForTests();
  auth.deleteUser.mockReset();
});

afterEach(() => {
  resetPostHogBoundary();
  vi.clearAllMocks();
});

describe("Settings profile form", () => {
  it("initializes display name when the session resolves after loading", async () => {
    configureConvex({ currentUser: undefined });
    const { rerender } = renderSettings();

    expect(screen.queryByLabelText("Display name")).not.toBeInTheDocument();

    configureConvex({
      currentUser: makeCurrentUserView({ displayName: "Ada Lovelace" }),
    });
    rerender(
      <SnackbarProvider>
        <MemoryRouter>
          <Settings />
        </MemoryRouter>
      </SnackbarProvider>,
    );

    expect(await screen.findByLabelText("Display name")).toHaveValue("Ada Lovelace");
  });

  it("blocks save when the display name is empty or whitespace-only", async () => {
    configureConvex({
      currentUser: makeCurrentUserView({ displayName: "Ada Lovelace" }),
      updateProfile: vi.fn(),
    });
    const user = userEvent.setup();
    renderSettings();

    const input = await screen.findByLabelText("Display name");
    const save = screen.getByRole("button", { name: "Save profile" });

    await user.clear(input);
    expect(save).toBeDisabled();

    await user.type(input, "   ");
    expect(save).toBeDisabled();
  });

  it("validates on submit and does not call updateProfile for an empty name", async () => {
    const updateProfile = vi.fn();
    configureConvex({
      currentUser: makeCurrentUserView({ displayName: "Ada Lovelace" }),
      updateProfile,
    });
    const user = userEvent.setup();
    renderSettings();

    const input = await screen.findByLabelText("Display name");
    await user.clear(input);

    const form = input.closest("form");
    if (!form) throw new Error("profile form missing");
    fireEvent.submit(form);

    expect(screen.getByText("Name is required")).toBeInTheDocument();
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it("saves a valid display name and shows confirmation", async () => {
    const updateProfile = vi.fn().mockResolvedValue(undefined);
    configureConvex({
      currentUser: makeCurrentUserView({ displayName: "Ada Lovelace" }),
      updateProfile,
    });
    const user = userEvent.setup();
    renderSettings();

    const input = await screen.findByLabelText("Display name");
    await user.clear(input);
    await user.type(input, "  Bob Builder  ");
    await user.click(screen.getByRole("button", { name: "Save profile" }));

    await waitFor(() => {
      expect(updateProfile).toHaveBeenCalledWith({ displayName: "Bob Builder" });
    });
    expect(screen.getByText("Profile updated.")).toBeInTheDocument();
  });
});

describe("Settings product-analytics preference", () => {
  it("reflects analyticsEnabled false as switch off", async () => {
    configureConvex({
      currentUser: makeCurrentUserView({ analyticsEnabled: false }),
      setAnalyticsEnabled: vi.fn(),
    });
    renderSettings();

    expect(await screen.findByRole("switch", { name: /share product analytics/i })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("reflects analyticsEnabled true as switch on", async () => {
    configureConvex({
      currentUser: makeCurrentUserView({ analyticsEnabled: true }),
      setAnalyticsEnabled: vi.fn(),
    });
    renderSettings();

    expect(await screen.findByRole("switch", { name: /share product analytics/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByText(/on by default for new accounts/i)).toBeVisible();
    expect(screen.queryByText(/off by default/i)).not.toBeInTheDocument();
  });

  it("persists opt-in from a disabled preference", async () => {
    const setAnalyticsEnabled = vi.fn().mockResolvedValue(undefined);
    configureConvex({
      currentUser: makeCurrentUserView({ analyticsEnabled: false }),
      setAnalyticsEnabled,
    });
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole("switch", { name: /share product analytics/i }));

    await waitFor(() => {
      expect(setAnalyticsEnabled).toHaveBeenCalledWith({ enabled: true });
    });
    expect(screen.getByText("Privacy preference updated.")).toBeInTheDocument();
  });

  it("persists opt-out from an enabled preference", async () => {
    const setAnalyticsEnabled = vi.fn().mockResolvedValue(undefined);
    configureConvex({
      currentUser: makeCurrentUserView({ analyticsEnabled: true }),
      setAnalyticsEnabled,
    });
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole("switch", { name: /share product analytics/i }));

    await waitFor(() => {
      expect(setAnalyticsEnabled).toHaveBeenCalledWith({ enabled: false });
    });
    expect(screen.getByText("Privacy preference updated.")).toBeInTheDocument();
  });

  it("stops capture before the preference mutation resolves", async () => {
    let resolveMutation!: () => void;
    const setAnalyticsEnabled = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveMutation = resolve;
        }),
    );
    configureConvex({
      currentUser: makeCurrentUserView({ analyticsEnabled: true }),
      setAnalyticsEnabled,
    });
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole("switch", { name: /share product analytics/i }));
    await waitFor(() => {
      expect(setAnalyticsEnabled).toHaveBeenCalledWith({ enabled: false });
    });

    track("feedback_submitted", { type: "bug" });
    expect(posthogSdk.capture).not.toHaveBeenCalled();

    resolveMutation();
    expect(await screen.findByText("Privacy preference updated.")).toBeInTheDocument();
  });

  it("restores capture when opt-out persistence fails", async () => {
    const setAnalyticsEnabled = vi.fn().mockRejectedValue(new Error("network"));
    configureConvex({
      currentUser: makeCurrentUserView({ analyticsEnabled: true }),
      setAnalyticsEnabled,
    });
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole("switch", { name: /share product analytics/i }));
    expect(
      await screen.findByText("Couldn't update your privacy preference. Please try again."),
    ).toBeInTheDocument();

    track("feedback_submitted", { type: "bug" });
    expect(posthogSdk.capture).toHaveBeenCalledWith("feedback_submitted", { type: "bug" });
  });

  it("does not keep capturing after a failed opt-out when the session later reports disabled", async () => {
    const currentUser = makeCurrentUserView({ analyticsEnabled: true });
    primeAnalyticsForTests(currentUser);
    const setAnalyticsEnabled = vi.fn().mockRejectedValue(new Error("network"));
    configureConvex({
      currentUser,
      setAnalyticsEnabled,
    });
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole("switch", { name: /share product analytics/i }));
    expect(
      await screen.findByText("Couldn't update your privacy preference. Please try again."),
    ).toBeInTheDocument();

    initAnalytics({ id: currentUser.id, analyticsEnabled: false });
    track("feedback_submitted", { type: "bug" });
    expect(posthogSdk.capture).not.toHaveBeenCalled();
  });

  it("shows an error when setAnalyticsEnabled fails", async () => {
    const setAnalyticsEnabled = vi.fn().mockRejectedValue(new Error("network"));
    configureConvex({
      currentUser: makeCurrentUserView({ analyticsEnabled: false }),
      setAnalyticsEnabled,
    });
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole("switch", { name: /share product analytics/i }));

    expect(
      await screen.findByText("Couldn't update your privacy preference. Please try again."),
    ).toBeInTheDocument();
    expect(await screen.findByRole("switch", { name: /share product analytics/i })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });
});

describe("Settings app version", () => {
  it("renders the build-injected app version", async () => {
    configureConvex({
      currentUser: makeCurrentUserView(),
      setAnalyticsEnabled: vi.fn(),
    });
    renderSettings();

    expect(await screen.findByText(`App version ${__APP_VERSION__}`)).toBeInTheDocument();
  });
});

describe("Settings feedback form", () => {
  it("renders support context with user email, name, and app version", async () => {
    configureConvex({
      currentUser: makeCurrentUserView({
        email: "ada@example.com",
        displayName: "Ada Lovelace",
      }),
      submitFeedback: vi.fn(),
    });
    renderSettings();

    expect(await screen.findByText(/Ada Lovelace/)).toBeInTheDocument();
    expect(screen.getByText(/ada@example.com/)).toBeInTheDocument();
    expect(screen.getAllByText(__APP_VERSION__, { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getByText(/Circle context:/)).toBeInTheDocument();
  });

  it("blocks submit when the message is empty", async () => {
    configureConvex({
      currentUser: makeCurrentUserView(),
      submitFeedback: vi.fn(),
    });
    renderSettings();

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
    renderSettings();

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
    expect(message).toHaveValue("");
    expect(screen.getByRole("button", { name: "Send feedback" })).toBeDisabled();
  });

  it("does not call submitFeedback when validation fails on submit", async () => {
    const submitFeedback = vi.fn();
    configureConvex({
      currentUser: makeCurrentUserView(),
      submitFeedback,
    });
    renderSettings();

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
    renderSettings();

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
    renderSettings();

    await user.type(await screen.findByLabelText("Message"), "Broken");
    await user.click(screen.getByRole("button", { name: "Send feedback" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't send your feedback. Please try again.",
    );
  });

  it("does not import PostHog directly", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const dir = dirname(fileURLToPath(import.meta.url));
    const moduleText = readFileSync(join(dir, "settings.tsx"), "utf8");
    expect(moduleText).not.toMatch(/from\s+["'][^"']*posthog/i);
    expect(moduleText).not.toMatch(/import\s*\(\s*["'][^"']*posthog/i);
    expect(moduleText).toMatch(/from\s+["']~\/lib\/analytics\.js["']/);
  });
});

describe("Settings danger zone", () => {
  it("lists blocker archive and transfer links and hides phrase confirmation", async () => {
    configureConvex({
      currentUser: makeCurrentUserView(),
      accountDeletionBlockers: [
        makeAccountDeletionBlocker({
          circleId: testId<AccountDeletionBlocker["circleId"]>("c-archive"),
          ref: "solo-carc",
          name: "Solo Trip",
          action: "archive",
        }),
        makeAccountDeletionBlocker({
          circleId: testId<AccountDeletionBlocker["circleId"]>("c-transfer"),
          ref: "shared-ctrans",
          name: "Shared Home",
          action: "transfer",
        }),
      ],
    });
    renderSettings();

    expect(await screen.findByRole("heading", { name: "Danger zone" })).toBeInTheDocument();
    const archive = screen.getByRole("link", { name: "Archive Solo Trip" });
    expect(archive).toHaveAttribute("href", "/circles/solo-carc/settings");
    const transfer = screen.getByRole("link", { name: "Transfer ownership of Shared Home" });
    expect(transfer).toHaveAttribute("href", "/circles/shared-ctrans/members");
    expect(screen.queryByLabelText(/DELETE MY ACCOUNT/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete my account" })).not.toBeInTheDocument();
  });

  it("loads more blockers when more pages remain", async () => {
    const loadMore = vi.fn();
    configureConvex({
      currentUser: makeCurrentUserView(),
      accountDeletionBlockers: [
        makeAccountDeletionBlocker({ name: "First Circle", ref: "first-c1" }),
      ],
      accountDeletionBlockersStatus: "CanLoadMore",
      accountDeletionBlockersLoadMore: loadMore,
    });
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole("button", { name: "Load more" }));
    expect(loadMore).toHaveBeenCalled();
  });

  it("gates delete on exact phrase, omits Account Export, and shows check-your-email after request", async () => {
    auth.deleteUser.mockResolvedValue({ data: {}, error: null });
    configureConvex({
      currentUser: makeCurrentUserView(),
      accountDeletionBlockers: [],
    });
    const user = userEvent.setup();
    renderSettings();

    expect(await screen.findByRole("button", { name: "Delete my account" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Export account data" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Account export/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Unavailable in this pre-alpha slice/i)).not.toBeInTheDocument();

    const submit = screen.getByRole("button", { name: "Delete my account" });
    expect(submit).toBeDisabled();

    const phrase = screen.getByLabelText(/DELETE MY ACCOUNT/);
    await user.type(phrase, "delete my account");
    expect(submit).toBeDisabled();

    await user.clear(phrase);
    await user.type(phrase, "DELETE MY ACCOUNT");
    expect(submit).toBeEnabled();

    await user.click(submit);
    expect(auth.deleteUser).toHaveBeenCalledOnce();
    expect(await screen.findByText(/Check your email/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete my account" })).not.toBeInTheDocument();
  });

  it("prevents duplicate in-flight deletion requests", async () => {
    let resolveRequest: ((value: { data: object; error: null }) => void) | undefined;
    auth.deleteUser.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        }),
    );
    configureConvex({
      currentUser: makeCurrentUserView(),
      accountDeletionBlockers: [],
    });
    const user = userEvent.setup();
    renderSettings();

    await user.type(await screen.findByLabelText(/DELETE MY ACCOUNT/), "DELETE MY ACCOUNT");
    const submit = screen.getByRole("button", { name: "Delete my account" });
    await user.click(submit);
    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Sending…" }));
    expect(auth.deleteUser).toHaveBeenCalledOnce();

    resolveRequest?.({ data: {}, error: null });
    expect(await screen.findByText(/Check your email/i)).toBeInTheDocument();
  });

  it("shows coded blocker error and fallback for unexpected failures", async () => {
    auth.deleteUser
      .mockRejectedValueOnce(
        new ConvexError(mutationErrorData(MUTATION_ERRORS.accountDeletionBlocked)),
      )
      .mockRejectedValueOnce(new Error("network"));
    configureConvex({
      currentUser: makeCurrentUserView(),
      accountDeletionBlockers: [],
    });
    const user = userEvent.setup();
    renderSettings();

    const phrase = await screen.findByLabelText(/DELETE MY ACCOUNT/);
    await user.type(phrase, "DELETE MY ACCOUNT");
    await user.click(screen.getByRole("button", { name: "Delete my account" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      MUTATION_ERRORS.accountDeletionBlocked.message,
    );

    await user.click(screen.getByRole("button", { name: "Delete my account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't start account deletion. Please try again.",
    );
  });
});
