import { currentMonth } from "@pocketcircle/domain";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureConvex,
  makeActivationChecklistView,
  makeCircleView,
  renderInCircle,
} from "~/test/convex-react.js";
import {
  posthogSdk,
  primeAnalyticsForTests,
  resetPostHogBoundary,
} from "~/test/posthog-boundary.js";

vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);
vi.mock("posthog-js", async () => (await import("~/test/posthog-mock.js")).posthogModuleMock);
vi.mock("~/lib/env.js", async (importOriginal) =>
  (await import("~/test/posthog-mock.js")).createPosthogEnvMock(importOriginal),
);

import { ActivationChecklist } from "./activation-checklist.js";

const personal = makeCircleView({
  kind: "personal",
  name: "Ada's Circle",
  ref: "adas-circle-c1",
});
const origin = "/circles/adas-circle-c1";
const month = currentMonth(new Date());

beforeEach(() => {
  primeAnalyticsForTests();
});

afterEach(() => {
  resetPostHogBoundary();
  vi.restoreAllMocks();
});

function renderChecklist() {
  return renderInCircle(personal, <ActivationChecklist circle={personal} />, {
    initialEntries: [origin],
  });
}

describe("ActivationChecklist visibility", () => {
  it("hides while loading and does not initialize", () => {
    const initialize = vi.fn();
    configureConvex({ activation: undefined, initializeActivationChecklist: initialize });
    renderChecklist();

    expect(screen.queryByRole("heading", { name: "Get started" })).not.toBeInTheDocument();
    expect(initialize).not.toHaveBeenCalled();
  });

  it("hides when uninitialized and runs the evidence initializer", async () => {
    const initialize = vi.fn().mockResolvedValue(undefined);
    configureConvex({
      activation: { status: "uninitialized" },
      initializeActivationChecklist: initialize,
    });
    renderChecklist();

    expect(screen.queryByRole("heading", { name: "Get started" })).not.toBeInTheDocument();
    await waitFor(() => expect(initialize).toHaveBeenCalledWith({}));
  });

  it("hides after dismiss and when all four items are complete", () => {
    configureConvex({
      activation: makeActivationChecklistView({ dismissed: true, visible: false }),
    });
    renderChecklist();
    expect(screen.queryByRole("heading", { name: "Get started" })).not.toBeInTheDocument();

    configureConvex({
      activation: makeActivationChecklistView({
        allComplete: true,
        visible: false,
        completedCount: 4,
        firstIncomplete: null,
        personalTransactionComplete: true,
        personalCategoryComplete: true,
        regularCircleComplete: true,
        sharedMemberState: "complete",
      }),
    });
    renderChecklist();
    expect(screen.queryByRole("heading", { name: "Get started" })).not.toBeInTheDocument();
  });
});

describe("ActivationChecklist items", () => {
  it("emphasizes the first incomplete item while keeping others actionable", () => {
    configureConvex({
      activation: makeActivationChecklistView({
        personalTransactionComplete: true,
        completedCount: 1,
        firstIncomplete: "personalCategory",
      }),
    });
    renderChecklist();

    expect(screen.getByText("1 of 4 complete")).toBeInTheDocument();
    const txn = screen.getByText("Record your first Transaction").closest("li");
    const category = screen.getByText("Create a Category").closest("li");
    const circle = screen.getByText("Create a shared Circle").closest("li");
    if (!txn || !category || !circle) {
      throw new Error("expected checklist items");
    }
    expect(txn).not.toHaveAttribute("aria-current");
    expect(within(txn).getByText(", complete")).toBeInTheDocument();
    expect(category).toHaveAttribute("aria-current", "step");
    expect(within(category).getByRole("link", { name: "New category" })).toBeInTheDocument();
    expect(circle).not.toHaveAttribute("aria-current");
    expect(within(circle).getByRole("link", { name: "Create circle" })).toBeInTheDocument();
  });

  it("links Transaction and Category CTAs to canonical create routes with returnTo", () => {
    configureConvex({ activation: makeActivationChecklistView() });
    renderChecklist();

    expect(screen.getByRole("link", { name: "Add expense" })).toHaveAttribute(
      "href",
      `/circles/${personal.ref}/transactions/new?type=expense&month=${month}&returnTo=${encodeURIComponent(origin)}`,
    );
    expect(screen.getByRole("link", { name: "Add income" })).toHaveAttribute(
      "href",
      `/circles/${personal.ref}/transactions/new?type=income&month=${month}&returnTo=${encodeURIComponent(origin)}`,
    );
    expect(screen.getByRole("link", { name: "New category" })).toHaveAttribute(
      "href",
      `/circles/${personal.ref}/categories/new?type=expense&returnTo=${encodeURIComponent(origin)}`,
    );
  });

  it("shows Invitation pending without a Member CTA", () => {
    configureConvex({
      activation: makeActivationChecklistView({
        regularCircleComplete: true,
        completedCount: 1,
        firstIncomplete: "personalTransaction",
        sharedMemberState: "pending",
        pendingInvitationExpiresAt: Date.now() + 60_000,
        memberCta: { kind: "members", circleRef: "cabin-c2" },
      }),
    });
    renderChecklist();

    expect(screen.getByText("Invitation pending")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Invite a member" })).not.toBeInTheDocument();
  });

  it("treats an already-expired pending invitation as not started", () => {
    configureConvex({
      activation: makeActivationChecklistView({
        regularCircleComplete: true,
        completedCount: 3,
        firstIncomplete: "sharedMember",
        personalTransactionComplete: true,
        personalCategoryComplete: true,
        sharedMemberState: "pending",
        pendingInvitationExpiresAt: Date.now() - 1,
        memberCta: { kind: "members", circleRef: "cabin-c2" },
      }),
    });
    renderChecklist();

    expect(screen.queryByText("Invitation pending")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Invite a member" })).toBeInTheDocument();
  });

  it("routes the Member CTA to Members, Setup, or create", () => {
    configureConvex({
      activation: makeActivationChecklistView({
        memberCta: { kind: "members", circleRef: "cabin-c2" },
      }),
    });
    renderChecklist();
    expect(screen.getByRole("link", { name: "Invite a member" })).toHaveAttribute(
      "href",
      `/circles/cabin-c2/members?returnTo=${encodeURIComponent(origin)}`,
    );

    configureConvex({
      activation: makeActivationChecklistView({
        memberCta: { kind: "setup", circleRef: "alpha-c3" },
      }),
    });
    renderChecklist();
    expect(screen.getByRole("link", { name: "Finish setup" })).toHaveAttribute(
      "href",
      `/circles/alpha-c3/setup?returnTo=${encodeURIComponent(origin)}`,
    );

    configureConvex({
      activation: makeActivationChecklistView({ memberCta: { kind: "create" } }),
    });
    renderChecklist();
    expect(screen.getByText("Create a shared Circle first.")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Create circle" }).length).toBeGreaterThan(0);
  });
});

describe("ActivationChecklist skip", () => {
  it("persists Skip then hides and tracks the completed-item count", async () => {
    let dismissed = false;
    const skip = vi.fn().mockImplementation(async () => {
      dismissed = true;
      return { completedCount: 1, claimed: true };
    });
    configureConvex({
      activation: () =>
        dismissed
          ? makeActivationChecklistView({
              dismissed: true,
              visible: false,
              completedCount: 1,
              personalTransactionComplete: true,
              firstIncomplete: "personalCategory",
            })
          : makeActivationChecklistView({
              completedCount: 1,
              personalTransactionComplete: true,
              firstIncomplete: "personalCategory",
            }),
      skipActivationChecklist: skip,
    });
    const user = userEvent.setup();
    renderChecklist();

    expect(screen.getByRole("heading", { name: "Get started" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Skip onboarding" }));

    await waitFor(() => expect(skip).toHaveBeenCalledWith({}));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Get started" })).not.toBeInTheDocument(),
    );
    expect(posthogSdk.capture).toHaveBeenCalledWith("activation_checklist_skipped", {
      completedCount: 1,
    });
  });

  it("does not recapture Skip when the dismissal was already claimed", async () => {
    const skip = vi.fn().mockResolvedValue({ completedCount: 1, claimed: false });
    configureConvex({
      activation: makeActivationChecklistView({
        completedCount: 1,
        personalTransactionComplete: true,
        firstIncomplete: "personalCategory",
      }),
      skipActivationChecklist: skip,
    });
    const user = userEvent.setup();
    renderChecklist();

    await user.click(screen.getByRole("button", { name: "Skip onboarding" }));

    await waitFor(() => expect(skip).toHaveBeenCalledWith({}));
    expect(posthogSdk.capture).not.toHaveBeenCalled();
  });

  it("keeps the card visible and shows an alert when Skip fails", async () => {
    const skip = vi.fn().mockRejectedValue(new Error("offline"));
    configureConvex({
      activation: makeActivationChecklistView(),
      skipActivationChecklist: skip,
    });
    const user = userEvent.setup();
    renderChecklist();

    await user.click(screen.getByRole("button", { name: "Skip onboarding" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn’t skip onboarding/i);
    expect(screen.getByRole("heading", { name: "Get started" })).toBeInTheDocument();
    expect(posthogSdk.capture).not.toHaveBeenCalled();
  });
});

describe("ActivationChecklist completion analytics", () => {
  it("claims and captures completion once even when the card is hidden", async () => {
    const acknowledge = vi.fn().mockResolvedValue({ claimed: true });
    configureConvex({
      activation: makeActivationChecklistView({
        allComplete: true,
        visible: false,
        completedCount: 4,
        firstIncomplete: null,
        personalTransactionComplete: true,
        personalCategoryComplete: true,
        regularCircleComplete: true,
        sharedMemberState: "complete",
        completionEventPending: true,
      }),
      acknowledgeActivationCompleted: acknowledge,
    });
    renderChecklist();

    await waitFor(() => expect(acknowledge).toHaveBeenCalledWith({}));
    expect(posthogSdk.capture).toHaveBeenCalledWith("activation_checklist_completed", {});
    expect(screen.queryByRole("heading", { name: "Get started" })).not.toBeInTheDocument();
  });

  it("does not recapture when the claim is already delivered", async () => {
    const acknowledge = vi.fn().mockResolvedValue({ claimed: false });
    configureConvex({
      activation: makeActivationChecklistView({
        allComplete: true,
        visible: false,
        completedCount: 4,
        firstIncomplete: null,
        personalTransactionComplete: true,
        personalCategoryComplete: true,
        regularCircleComplete: true,
        sharedMemberState: "complete",
        completionEventPending: true,
      }),
      acknowledgeActivationCompleted: acknowledge,
    });
    renderChecklist();

    await waitFor(() => expect(acknowledge).toHaveBeenCalledWith({}));
    expect(posthogSdk.capture).not.toHaveBeenCalled();
  });
});
