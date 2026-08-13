import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureConvex, convexReactMock, makeCurrentUserView } from "~/test/convex-react.js";

vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);

import OnboardingRoute from "./onboarding.js";

function renderOnboarding() {
  return render(
    <MemoryRouter initialEntries={["/onboarding"]}>
      <OnboardingRoute />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Onboarding profile form", () => {
  it("calls completeOnboarding with the trimmed display name on submit", async () => {
    const completeOnboarding = vi.fn().mockResolvedValue(undefined);
    configureConvex({
      currentUser: makeCurrentUserView({
        onboardingComplete: false,
        displayName: "Ada Lovelace",
      }),
      completeOnboarding,
    });
    const user = userEvent.setup();
    renderOnboarding();

    const input = await screen.findByLabelText("Display name");
    await user.clear(input);
    await user.type(input, "  Bob Builder  ");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(completeOnboarding).toHaveBeenCalledWith({ displayName: "Bob Builder" });
    });
  });

  it("shows the analytics notice and Privacy Policy link before onboarding completes", async () => {
    configureConvex({
      currentUser: makeCurrentUserView({
        onboardingComplete: false,
        analyticsEnabled: true,
        displayName: "Ada Lovelace",
      }),
    });
    renderOnboarding();

    expect(
      await screen.findByText(/collects limited feature-usage analytics to improve the product/i),
    ).toBeVisible();
    expect(
      screen.getByText(
        /Transaction amounts, titles, notes, names, and other free text are never included/i,
      ),
    ).toBeVisible();
    expect(screen.getByText(/opt out anytime in Settings → Privacy/i)).toBeVisible();
    expect(screen.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute(
      "href",
      "/privacy",
    );
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
});
