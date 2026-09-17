import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Circle } from "~/lib/data.js";
import { RETURN_TO_PARAM } from "~/lib/return-to-url.js";
import { renderSidebarRow } from "~/test/activation-hosts.js";
import {
  configureConvex,
  makeActivationChecklistView,
  makeEligibleCircle,
  testId,
} from "~/test/convex-react.js";
import { primeAnalyticsForTests, resetPostHogBoundary } from "~/test/posthog-boundary.js";

vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);
vi.mock("posthog-js", async () => (await import("~/test/posthog-mock.js")).posthogModuleMock);

import { ActivationChecklistLauncher } from "./activation-checklist-launcher.js";

/**
 * The desktop presentation of the Activation Checklist (issue #351). Item, CTA, skip,
 * and picker RULES are covered once against the shared content in
 * `activation-checklist.test.tsx`; these cover what the launcher adds — eligibility,
 * progress on the row, opening/closing, and the modal handoff.
 */
beforeEach(async () => {
  await primeAnalyticsForTests();
});

afterEach(() => {
  cleanup();
  resetPostHogBoundary();
  vi.restoreAllMocks();
});

function renderLauncher(initialEntry = "/") {
  return renderSidebarRow(<ActivationChecklistLauncher />, { initialEntries: [initialEntry] });
}

function launcher() {
  return screen.getByRole("button", { name: /Get started/ });
}

describe("ActivationChecklistLauncher visibility", () => {
  it("renders nothing while the checklist query is loading", () => {
    configureConvex({ activation: undefined });
    renderLauncher();
    expect(screen.queryByRole("button", { name: /Get started/ })).not.toBeInTheDocument();
  });

  it("renders nothing while uninitialized", () => {
    configureConvex({
      activation: { status: "uninitialized" },
      initializeActivationChecklist: vi.fn().mockResolvedValue(undefined),
    });
    renderLauncher();
    expect(screen.queryByRole("button", { name: /Get started/ })).not.toBeInTheDocument();
  });

  it("renders nothing once the checklist is skipped or complete", () => {
    configureConvex({
      activation: makeActivationChecklistView({ dismissed: true, visible: false }),
    });
    renderLauncher();
    expect(screen.queryByRole("button", { name: /Get started/ })).not.toBeInTheDocument();
  });
});

describe("ActivationChecklistLauncher flyout", () => {
  it("shows progress on the row and opens the shared checklist", async () => {
    configureConvex({
      activation: makeActivationChecklistView({
        completedCount: 1,
        transactionComplete: true,
        firstIncomplete: "category",
      }),
    });
    const user = userEvent.setup();
    renderLauncher();

    // Progress reaches the row by description: the badge is a positioned sibling.
    expect(launcher()).toHaveAccessibleDescription("1 of 4");
    expect(launcher()).toHaveAttribute("aria-expanded", "false");
    // `keepMounted` leaves the body in the tree while closed; it must stay hidden.
    expect(screen.getByText("Create a Category")).not.toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(launcher());

    const flyout = await screen.findByRole("dialog");
    expect(flyout).toHaveAccessibleName("Get started");
    expect(flyout).toHaveAccessibleDescription("1 of 4 complete");
    expect(launcher()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Create a Category")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skip onboarding" })).toBeInTheDocument();
  });

  // Opening focus must not land on the first tabbable child: here that is the
  // irreversible "Skip onboarding", one Enter or Space away.
  it("opens with focus on the dialog itself, not on Skip onboarding", async () => {
    configureConvex({ activation: makeActivationChecklistView() });
    const user = userEvent.setup();
    renderLauncher();

    await user.click(launcher());

    const flyout = await screen.findByRole("dialog");
    await waitFor(() => expect(flyout).toHaveFocus());
    expect(screen.getByRole("button", { name: "Skip onboarding" })).not.toHaveFocus();
  });

  it("closes from the dialog's own Close control and returns focus to the launcher", async () => {
    configureConvex({ activation: makeActivationChecklistView() });
    const user = userEvent.setup();
    renderLauncher();

    await user.click(launcher());
    const flyout = await screen.findByRole("dialog");

    await user.click(within(flyout).getByRole("button", { name: "Close" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(launcher()).toHaveFocus();
  });

  it("closes on Escape and returns focus to the launcher", async () => {
    configureConvex({ activation: makeActivationChecklistView() });
    const user = userEvent.setup();
    renderLauncher();

    await user.click(launcher());
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(launcher()).toHaveFocus();
  });

  it("closes when a CTA starts navigating, keeping the CTA's destination", async () => {
    configureConvex({
      activation: makeActivationChecklistView({
        eligibleCircles: [
          makeEligibleCircle({ id: testId<Circle["id"]>("c1"), ref: "personal-c1" }),
        ],
      }),
    });
    const user = userEvent.setup();
    const view = renderLauncher("/?currency=CAD");

    await user.click(launcher());
    await user.click(await screen.findByRole("link", { name: "Add expense" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const dest = new URL(view.location(), "http://t");
    expect(dest.pathname).toBe("/transactions/new");
    expect(dest.searchParams.get(RETURN_TO_PARAM)).toBe("/?currency=CAD");
  });

  // The picker is a modal the flyout's own content renders, so it must outlive the
  // flyout closing ahead of it (`keepMounted`).
  it("hands off to the modal Circle picker, closing the flyout first", async () => {
    configureConvex({
      activation: makeActivationChecklistView({
        eligibleCircles: [
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
        ],
      }),
    });
    const user = userEvent.setup();
    const view = renderLauncher("/?currency=EUR");

    await user.click(launcher());
    await user.click(await screen.findByRole("button", { name: "New category" }));

    expect(
      await screen.findByRole("heading", { name: "Choose a Circle for the category" }),
    ).toBeInTheDocument();
    // The flyout closed first: the modal is the only dialog left, and it survived the
    // close instead of unmounting with the popover that opened it.
    const dialogs = screen.getAllByRole("dialog");
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]).toHaveAccessibleName("Choose a Circle for the category");

    await user.click(screen.getByRole("button", { name: /Personal.*USD/ }));

    const dest = new URL(view.location(), "http://t");
    expect(dest.pathname).toBe("/circles/personal-c1/categories/new");
    expect(dest.searchParams.get(RETURN_TO_PARAM)).toBe("/?currency=EUR");
  });

  it("disappears through the reactive query after a successful skip", async () => {
    let dismissed = false;
    const skip = vi.fn().mockImplementation(async () => {
      dismissed = true;
      return { completedCount: 1, claimed: true };
    });
    configureConvex({
      activation: () =>
        dismissed
          ? makeActivationChecklistView({ dismissed: true, visible: false })
          : makeActivationChecklistView(),
      skipActivationChecklist: skip,
    });
    const user = userEvent.setup();
    renderLauncher();

    await user.click(launcher());
    await user.click(await screen.findByRole("button", { name: "Skip onboarding" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /Get started/ })).not.toBeInTheDocument();
    });
  });
});
