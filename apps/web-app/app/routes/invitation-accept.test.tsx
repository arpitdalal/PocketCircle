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

vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);

import InvitationAccept from "./invitation-accept.js";

const preview = { ...MOCK_INVITATION_PREVIEW, ref: "trip-inv123" };

beforeEach(() => {
  configureConvex();
  convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });
});

afterEach(() => {
  vi.clearAllMocks();
});

function renderInvitationAccept(
  invitationRef = "trip-inv123",
  opts: { invitationPreviewById?: typeof preview | null | undefined } = {},
) {
  configureConvex({
    currentUser: makeCurrentUserView(),
    invitationPreviewById: "invitationPreviewById" in opts ? opts.invitationPreviewById : preview,
  });
  return renderRoutes(
    <>
      <Route path="/invitations/:invitationRef" element={<InvitationAccept />} />
      <Route path="/circles/:circleRef" element={<div>circle-home</div>} />
    </>,
    { initialEntries: [`/invitations/${invitationRef}`] },
  );
}

describe("Authenticated invitation accept (#375)", () => {
  it("shows a skeleton while the preview is loading", () => {
    renderInvitationAccept("trip-inv123", { invitationPreviewById: undefined });
    expect(screen.getByTestId("invite-skeleton")).toBeInTheDocument();
  });

  it("shows a generic invalid message when the preview is null", () => {
    renderInvitationAccept("trip-inv123", { invitationPreviewById: null });
    expect(screen.getByRole("alert")).toHaveTextContent(MUTATION_ERRORS.inviteInvalid.message);
    expect(screen.queryByRole("button", { name: "Accept invitation" })).not.toBeInTheDocument();
  });

  it("rewrites a stale invitation ref in place, preserving query", async () => {
    configureConvex({
      currentUser: makeCurrentUserView(),
      invitationPreviewById: preview,
    });
    const view = renderRoutes(
      <>
        <Route path="/invitations/:invitationRef" element={<InvitationAccept />} />
        <Route path="/circles/:circleRef" element={<div>circle-home</div>} />
      </>,
      { initialEntries: ["/invitations/stale-inv123?from=tray"] },
    );
    expect(await screen.findByRole("button", { name: "Accept invitation" })).toBeInTheDocument();
    expect(view.location()).toBe("/invitations/trip-inv123?from=tray");
  });

  it("accepts by invitation id and redirects to the Circle", async () => {
    const acceptInvitationById = vi.fn().mockResolvedValue({ circleId: "circle123" });
    configureConvex({
      currentUser: makeCurrentUserView(),
      invitationPreviewById: preview,
      acceptInvitationById,
    });
    const user = userEvent.setup();

    renderRoutes(
      <>
        <Route path="/invitations/:invitationRef" element={<InvitationAccept />} />
        <Route path="/circles/:circleRef" element={<div>circle-home</div>} />
      </>,
      { initialEntries: ["/invitations/trip-inv123"] },
    );

    await user.click(screen.getByRole("button", { name: "Accept invitation" }));

    expect(await screen.findByText("circle-home")).toBeInTheDocument();
    expect(acceptInvitationById).toHaveBeenCalledWith({ invitationId: "inv123" });
  });

  it("maps an accept error to neutral user copy", async () => {
    const acceptInvitationById = vi
      .fn()
      .mockRejectedValue(new ConvexError(mutationErrorData(MUTATION_ERRORS.inviteInvalid)));
    configureConvex({
      currentUser: makeCurrentUserView(),
      invitationPreviewById: preview,
      acceptInvitationById,
    });
    const user = userEvent.setup();

    renderRoutes(<Route path="/invitations/:invitationRef" element={<InvitationAccept />} />, {
      initialEntries: ["/invitations/trip-inv123"],
    });

    await user.click(screen.getByRole("button", { name: "Accept invitation" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      MUTATION_ERRORS.inviteInvalid.message,
    );
    expect(screen.getByRole("button", { name: "Accept invitation" })).toBeEnabled();
  });
});
