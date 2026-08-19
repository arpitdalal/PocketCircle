import { currentMonth } from "@pocketcircle/domain";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Circle } from "~/lib/data.js";
import { RETURN_TO_PARAM } from "~/lib/return-to-url.js";
import {
  configureConvex,
  makeActivationChecklistView,
  makeEligibleCircle,
  renderRoutes,
  renderWithRouter,
  testId,
} from "~/test/convex-react.js";
import {
  posthogSdk,
  primeAnalyticsForTests,
  resetPostHogBoundary,
} from "~/test/posthog-boundary.js";

vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);
vi.mock("posthog-js", async () => (await import("~/test/posthog-mock.js")).posthogModuleMock);

import { ActivationChecklist } from "./activation-checklist.js";

const month = currentMonth(new Date());

beforeEach(() => {
  primeAnalyticsForTests();
});

afterEach(() => {
  cleanup();
  resetPostHogBoundary();
  vi.restoreAllMocks();
});

function renderChecklist() {
  return renderWithRouter(<ActivationChecklist />);
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

  it("hides after dismiss", () => {
    configureConvex({
      activation: makeActivationChecklistView({ dismissed: true, visible: false }),
    });
    renderChecklist();
    expect(screen.queryByRole("heading", { name: "Get started" })).not.toBeInTheDocument();
  });

  it("hides when all four items are complete", () => {
    configureConvex({
      activation: makeActivationChecklistView({
        allComplete: true,
        visible: false,
        completedCount: 4,
        firstIncomplete: null,
        transactionComplete: true,
        categoryComplete: true,
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
        transactionComplete: true,
        completedCount: 1,
        firstIncomplete: "category",
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

  it("links Transaction CTAs with returnTo for single eligible circle", () => {
    const eligible = [
      makeEligibleCircle({
        id: testId<Circle["id"]>("c1"),
        ref: "adas-circle-c1",
        name: "Ada",
      }),
    ];
    configureConvex({
      activation: makeActivationChecklistView({ eligibleCircles: eligible }),
    });
    renderChecklist();

    expect(screen.getByRole("link", { name: "Add expense" })).toHaveAttribute(
      "href",
      expect.stringContaining(
        `/circles/adas-circle-c1/transactions/new?type=expense&month=${month}`,
      ),
    );
    expect(screen.getByRole("link", { name: "Add income" })).toHaveAttribute(
      "href",
      expect.stringContaining(
        `/circles/adas-circle-c1/transactions/new?type=income&month=${month}`,
      ),
    );
  });

  it("shows buttons that open picker when multiple eligible circles exist", () => {
    const eligible = [
      makeEligibleCircle({
        id: testId<Circle["id"]>("c1"),
        ref: "personal-c1",
        name: "Personal",
      }),
      makeEligibleCircle({
        id: testId<Circle["id"]>("c2"),
        ref: "trip-c2",
        name: "Trip",
        kind: "regular",
      }),
    ];
    configureConvex({
      activation: makeActivationChecklistView({ eligibleCircles: eligible }),
    });
    renderChecklist();

    // Instead of links, we get buttons that open the picker
    expect(screen.getByRole("button", { name: "Add expense" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add income" })).toBeInTheDocument();
  });

  it("shows create circle hint when zero eligible circles", () => {
    configureConvex({
      activation: makeActivationChecklistView({ eligibleCircles: [] }),
    });
    renderChecklist();

    expect(screen.getAllByText(/Create a Circle or finish setup first/).length).toBeGreaterThan(0);
  });

  it("shows Invitation pending without a Member CTA", () => {
    configureConvex({
      activation: makeActivationChecklistView({
        regularCircleComplete: true,
        completedCount: 1,
        firstIncomplete: "transaction",
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
        transactionComplete: true,
        categoryComplete: true,
        sharedMemberState: "pending",
        pendingInvitationExpiresAt: Date.now() - 1,
        memberCta: { kind: "members", circleRef: "cabin-c2" },
      }),
    });
    renderChecklist();

    expect(screen.queryByText("Invitation pending")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Invite a member" })).toBeInTheDocument();
  });

  it.each([
    {
      memberCta: { kind: "members" as const, circleRef: "cabin-c2" },
      name: "Invite a member",
      href: /\/circles\/cabin-c2\/members\?returnTo=/,
    },
    {
      memberCta: { kind: "setup" as const, circleRef: "alpha-c3" },
      name: "Finish setup",
      href: /\/circles\/alpha-c3\/setup\?returnTo=/,
    },
  ])("routes the Member CTA to $name", ({ memberCta, name, href }) => {
    configureConvex({ activation: makeActivationChecklistView({ memberCta }) });
    renderChecklist();
    expect(screen.getByRole("link", { name })).toHaveAttribute("href", expect.stringMatching(href));
  });

  it("asks for a shared Circle first when no Circle exists", () => {
    configureConvex({
      activation: makeActivationChecklistView({ memberCta: { kind: "create" } }),
    });
    renderChecklist();
    expect(screen.getByText("Create a shared Circle first.")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Create circle" })).toHaveLength(1);
  });
});

describe("ActivationChecklist skip", () => {
  it("persists Skip and tracks the completed-item count", async () => {
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
              transactionComplete: true,
              firstIncomplete: "category",
            })
          : makeActivationChecklistView({
              completedCount: 1,
              transactionComplete: true,
              firstIncomplete: "category",
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

  it("keeps the card visible and shows an alert when Skip fails", async () => {
    const skip = vi.fn().mockRejectedValue(new Error("offline"));
    configureConvex({
      activation: makeActivationChecklistView(),
      skipActivationChecklist: skip,
    });
    const user = userEvent.setup();
    renderChecklist();

    await user.click(screen.getByRole("button", { name: "Skip onboarding" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't skip onboarding/i);
    expect(screen.getByRole("heading", { name: "Get started" })).toBeInTheDocument();
  });
});

describe("ActivationChecklist circle picker", () => {
  const eligible = [
    makeEligibleCircle({
      id: testId<Circle["id"]>("c1"),
      ref: "personal-c1",
      name: "Personal",
    }),
    makeEligibleCircle({
      id: testId<Circle["id"]>("c2"),
      ref: "trip-c2",
      name: "Trip",
      currency: "CAD",
      kind: "regular",
    }),
  ];

  it("opens picker dialog when clicking Add expense with multiple eligible circles", async () => {
    configureConvex({
      activation: makeActivationChecklistView({ eligibleCircles: eligible }),
    });
    const user = userEvent.setup();
    renderChecklist();

    await user.click(screen.getByRole("button", { name: "Add expense" }));

    expect(screen.getByRole("heading", { name: "Choose a Circle" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Personal.*USD/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Trip.*CAD/ })).toBeInTheDocument();
  });

  it("routes the picker to the canonical form and restores Home Summary returnTo", async () => {
    configureConvex({
      activation: makeActivationChecklistView({ eligibleCircles: eligible }),
    });
    const user = userEvent.setup();
    const view = renderRoutes(<Route path="/" element={<ActivationChecklist />} />, {
      initialEntries: ["/?currency=CAD&range=3"],
    });

    await user.click(screen.getByRole("button", { name: "Add expense" }));
    await user.click(screen.getByRole("button", { name: /Trip.*CAD/ }));

    const dest = new URL(view.location(), "http://t");
    expect(dest.pathname).toBe("/circles/trip-c2/transactions/new");
    expect(dest.searchParams.get("type")).toBe("expense");
    expect(dest.searchParams.get(RETURN_TO_PARAM)).toBe("/?currency=CAD&range=3");
  });

  it("preserves Add income through the picker", async () => {
    configureConvex({
      activation: makeActivationChecklistView({ eligibleCircles: eligible }),
    });
    const user = userEvent.setup();
    const view = renderRoutes(<Route path="/" element={<ActivationChecklist />} />, {
      initialEntries: ["/?currency=USD&range=6"],
    });

    await user.click(screen.getByRole("button", { name: "Add income" }));
    await user.click(screen.getByRole("button", { name: /Trip.*CAD/ }));

    const dest = new URL(view.location(), "http://t");
    expect(dest.pathname).toBe("/circles/trip-c2/transactions/new");
    expect(dest.searchParams.get("type")).toBe("income");
    expect(dest.searchParams.get(RETURN_TO_PARAM)).toBe("/?currency=USD&range=6");
  });

  it("preserves New category through the picker", async () => {
    configureConvex({
      activation: makeActivationChecklistView({ eligibleCircles: eligible }),
    });
    const user = userEvent.setup();
    const view = renderRoutes(<Route path="/" element={<ActivationChecklist />} />, {
      initialEntries: ["/?currency=EUR"],
    });

    await user.click(screen.getByRole("button", { name: "New category" }));
    expect(
      screen.getByRole("heading", { name: "Choose a Circle for the category" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Personal.*USD/ }));

    const dest = new URL(view.location(), "http://t");
    expect(dest.pathname).toBe("/circles/personal-c1/categories/new");
    expect(dest.searchParams.get("type")).toBe("expense");
    expect(dest.searchParams.get(RETURN_TO_PARAM)).toBe("/?currency=EUR");
  });
});
