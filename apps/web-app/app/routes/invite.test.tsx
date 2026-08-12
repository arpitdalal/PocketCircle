import { MUTATION_ERRORS, mutationErrorData } from "@pocketcircle/domain";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { Route } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOCK_INVITATION_PREVIEW } from "~/lib/fixtures.js";
import {
  configureConvex,
  convexReactMock,
  makeCurrentUserView,
  renderRoutes,
} from "~/test/convex-react.js";

const auth = vi.hoisted(() => ({
  social: vi.fn(),
}));

vi.mock("@convex-dev/better-auth/client/plugins", () => ({
  convexClient: vi.fn(),
  crossDomainClient: vi.fn(),
}));

vi.mock("better-auth/react", () => ({
  createAuthClient: vi.fn(() => ({
    signIn: {
      social: auth.social,
    },
  })),
}));

vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);

import Invite from "./invite.js";

const preview = MOCK_INVITATION_PREVIEW;

beforeEach(() => {
  configureConvex();
  convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: false, isLoading: false });
});

afterEach(() => {
  vi.clearAllMocks();
});

function renderInvite(
  token = "test-token",
  opts: { invitationPreview?: typeof preview | null | undefined } = {},
) {
  configureConvex({
    invitationPreview: "invitationPreview" in opts ? opts.invitationPreview : preview,
  });
  return renderRoutes(
    <>
      <Route path="/invite/:token" element={<Invite />} />
      <Route path="/circles/:circleRef" element={<div>circle-home</div>} />
    </>,
    { initialEntries: [`/invite/${token}`] },
  );
}

describe("Invite landing", () => {
  it("shows a skeleton while the preview is loading", () => {
    renderInvite("test-token", { invitationPreview: undefined });
    expect(screen.getByTestId("invite-skeleton")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept invitation" })).not.toBeInTheDocument();
  });

  it("shows a generic invalid message when the preview is null", () => {
    renderInvite("bad-token", { invitationPreview: null });
    expect(screen.getByRole("alert")).toHaveTextContent(MUTATION_ERRORS.inviteInvalid.message);
    expect(screen.queryByRole("button", { name: "Accept invitation" })).not.toBeInTheDocument();
  });

  it("shows a sign-in CTA when the preview is valid and the visitor is signed out", () => {
    renderInvite();
    expect(screen.getByText(preview.circleName)).toBeInTheDocument();
    expect(screen.getByText(preview.ownerDisplayName)).toBeInTheDocument();
    expect(screen.getByText(preview.invitedEmail)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in to accept" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept invitation" })).not.toBeInTheDocument();
  });

  it("shows an accept button when the preview is valid and the visitor is signed in", () => {
    configureConvex({ invitationPreview: preview, currentUser: makeCurrentUserView() });
    convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });

    renderRoutes(<Route path="/invite/:token" element={<Invite />} />, {
      initialEntries: ["/invite/test-token"],
    });

    expect(screen.getByRole("button", { name: "Accept invitation" })).toBeEnabled();
  });

  it("accepts the invitation, disables while in-flight, and redirects to the Circle", async () => {
    const acceptInvitation = vi.fn().mockImplementation(
      () =>
        new Promise<{ circleId: string }>((resolve) => {
          setTimeout(() => resolve({ circleId: "circle123" }), 50);
        }),
    );
    configureConvex({
      invitationPreview: preview,
      currentUser: makeCurrentUserView(),
      acceptInvitation,
    });
    convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });
    const user = userEvent.setup();

    const view = renderRoutes(
      <>
        <Route path="/invite/:token" element={<Invite />} />
        <Route path="/circles/:circleRef" element={<div>circle-home</div>} />
      </>,
      { initialEntries: ["/invite/test-token"] },
    );

    await user.click(screen.getByRole("button", { name: "Accept invitation" }));
    expect(screen.getByRole("button", { name: "Accepting…" })).toBeDisabled();

    expect(await screen.findByText("circle-home")).toBeInTheDocument();
    expect(view.location()).toBe("/circles/circle123");
    expect(acceptInvitation).toHaveBeenCalledWith({ token: "test-token" });
  });

  it("maps an accept error to neutral user copy and re-enables the button", async () => {
    const acceptInvitation = vi
      .fn()
      .mockRejectedValue(new ConvexError(mutationErrorData(MUTATION_ERRORS.inviteInvalid)));
    configureConvex({
      invitationPreview: preview,
      currentUser: makeCurrentUserView(),
      acceptInvitation,
    });
    convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });
    const user = userEvent.setup();

    renderRoutes(<Route path="/invite/:token" element={<Invite />} />, {
      initialEntries: ["/invite/test-token"],
    });

    await user.click(screen.getByRole("button", { name: "Accept invitation" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      MUTATION_ERRORS.inviteInvalid.message,
    );
    expect(screen.getByRole("button", { name: "Accept invitation" })).toBeEnabled();
  });
});
