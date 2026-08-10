import { MUTATION_ERRORS, mutationErrorData } from "@spend-circle/domain";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { Circle, Member, PendingInvitation } from "~/lib/data.js";
import { MOCK_PENDING_INVITATIONS } from "~/lib/fixtures.js";
import {
  configureConvex,
  makeCircleView,
  makeMemberView,
  renderInCircle,
  testId,
} from "~/test/convex-react.js";

const navigate = vi.fn();
vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return { ...actual, useNavigate: () => navigate };
});

/**
 * Behavior test for the Member List surface (jsdom). Only `convex/react` is
 * doubled (the shared helper); the real `useMembers` hook, the real `useCircle`
 * Outlet seam, and the real route logic run against the modeled backend state, so
 * a drift between the route, the data layer, and the `listMembers` contract is
 * caught here rather than mocked away (ADR 0006).
 */
vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);

import CircleMembers from "./members.js";

function setup(
  opts: {
    members?: Member[] | null;
    createInvitation?: Mock;
    transferOwnership?: Mock;
    removeMember?: Mock;
    pendingInvitations?: PendingInvitation[] | null;
    resendInvitation?: Mock;
    revokeInvitation?: Mock;
    leaveCircle?: Mock;
    circle?: Circle;
  } = {},
) {
  configureConvex({
    members: opts.members,
    createInvitation: opts.createInvitation,
    transferOwnership: opts.transferOwnership,
    removeMember: opts.removeMember,
    pendingInvitations: "pendingInvitations" in opts ? opts.pendingInvitations : [],
    resendInvitation: opts.resendInvitation,
    revokeInvitation: opts.revokeInvitation,
    leaveCircle: opts.leaveCircle,
  });
  return renderInCircle(opts.circle ?? makeCircleView(), <CircleMembers />);
}

const owner = makeMemberView({
  id: testId<Member["id"]>("mem-owner"),
  displayName: "Olive Owner",
  role: "owner",
  isSelf: false,
});
const maya = makeMemberView({
  id: testId<Member["id"]>("mem-maya"),
  displayName: "Maya Member",
  role: "member",
  isSelf: false,
});

afterEach(() => {
  vi.clearAllMocks();
});

beforeEach(() => {
  navigate.mockReset();
});

describe("CircleMembers", () => {
  it("does not render the circle history panel", () => {
    setup({ members: [owner, maya] });
    expect(screen.queryByRole("region", { name: "Circle history" })).not.toBeInTheDocument();
  });

  it("lists members in the order the query returns them (Owner-first)", () => {
    setup({ members: [owner, maya] });
    const items = within(screen.getByRole("list", { name: "Circle members" })).getAllByRole(
      "listitem",
    );
    expect(items[0]).toHaveTextContent("Olive Owner");
    expect(items[1]).toHaveTextContent("Maya Member");
  });

  it("shows an Owner badge for the Owner only", () => {
    setup({ members: [owner, maya] });
    const badges = screen.getAllByText("Owner"); // exact: the badge, not the name "Olive Owner"
    expect(badges).toHaveLength(1);
    expect(screen.getByText("Olive Owner").closest("li")).toContainElement(badges[0] ?? null);
  });

  it("marks the calling Member with (You)", () => {
    setup({ members: [owner, makeMemberView({ ...maya, isSelf: true })] });
    const marks = screen.getAllByText("(You)");
    expect(marks).toHaveLength(1);
    expect(screen.getByText("Maya Member").closest("li")).toContainElement(marks[0] ?? null);
  });

  it("renders the Profile Picture when present", () => {
    const { container } = setup({
      members: [makeMemberView({ ...owner, image: "https://example.com/olive.png" })],
    });
    const img = container.querySelector("img");
    expect(img).toHaveAttribute("src", "https://example.com/olive.png");
  });

  it("renders a generated initials avatar when there is no Profile Picture", () => {
    const { container } = setup({ members: [owner] });
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("OO")).toBeInTheDocument();
  });

  it("renders exactly one row for a Personal Circle", () => {
    setup({ members: [makeMemberView({ displayName: "You", isSelf: true })] });
    expect(
      within(screen.getByRole("list", { name: "Circle members" })).getAllByRole("listitem"),
    ).toHaveLength(1);
  });

  it("shows a skeleton while members resolve", () => {
    setup({ members: undefined });
    const skeleton = screen.getByTestId("members-skeleton");
    expect(skeleton).toHaveAttribute("aria-busy", "true");
    expect(within(skeleton).getByText(/Loading members/)).toBeInTheDocument();
  });

  it("shows an unavailable state when the query returns null (inaccessible)", () => {
    setup({ members: null });
    expect(screen.getByText(/members are unavailable/i)).toBeInTheDocument();
  });
});

describe("CircleMembers — invite form", () => {
  it("shows the invite form for the Owner", () => {
    setup({
      members: [makeMemberView({ displayName: "Olive Owner", role: "owner", isSelf: true })],
    });
    expect(screen.getByRole("form", { name: "Invite member" })).toBeInTheDocument();
    expect(screen.getByLabelText("Email address")).toBeInTheDocument();
  });

  it("hides the invite form for a non-owner Member", () => {
    setup({
      members: [
        owner,
        makeMemberView({ ...maya, isSelf: true, role: "member", displayName: "Maya Member" }),
      ],
    });
    expect(screen.queryByRole("form", { name: "Invite member" })).not.toBeInTheDocument();
  });

  it("hides the invite form on a Personal Circle", () => {
    setup({
      circle: makeCircleView({ kind: "personal" }),
      members: [makeMemberView({ displayName: "You", role: "owner", isSelf: true })],
    });
    expect(screen.queryByRole("form", { name: "Invite member" })).not.toBeInTheDocument();
  });

  it("hides the invite form on an archived Circle", () => {
    setup({
      circle: makeCircleView({ status: "archived" }),
      members: [makeMemberView({ displayName: "Olive Owner", role: "owner", isSelf: true })],
    });
    expect(screen.queryByRole("form", { name: "Invite member" })).not.toBeInTheDocument();
  });

  it("shows a field error for an invalid email without calling the mutation", async () => {
    const createInvitation = vi.fn();
    const user = userEvent.setup();
    setup({
      members: [makeMemberView({ displayName: "Olive Owner", role: "owner", isSelf: true })],
      createInvitation,
    });

    await user.type(screen.getByLabelText("Email address"), "not-an-email");
    await user.click(screen.getByRole("button", { name: "Invite member" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid email address");
    expect(createInvitation).not.toHaveBeenCalled();
  });

  it("shows a success confirmation on invite and disables submit while in-flight", async () => {
    const createInvitation = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(undefined), 50);
        }),
    );
    const user = userEvent.setup();
    setup({
      members: [makeMemberView({ displayName: "Olive Owner", role: "owner", isSelf: true })],
      createInvitation,
    });

    await user.type(screen.getByLabelText("Email address"), "ada@example.com");
    const submit = screen.getByRole("button", { name: "Invite member" });
    await user.click(submit);

    expect(submit).toBeDisabled();
    expect(submit).toHaveTextContent("Inviting…");

    expect(await screen.findByRole("status")).toHaveTextContent(
      /invitation sent to ada@example\.com/i,
    );
    expect(screen.queryByLabelText("Invitation link")).not.toBeInTheDocument();
    expect(createInvitation).toHaveBeenCalledWith({
      circleId: makeCircleView().id,
      email: "ada@example.com",
    });
  });

  it("maps a coded mutation error to shared user copy", async () => {
    const createInvitation = vi
      .fn()
      .mockRejectedValue(new ConvexError(mutationErrorData(MUTATION_ERRORS.inviteAlreadyPending)));
    const user = userEvent.setup();
    setup({
      members: [makeMemberView({ displayName: "Olive Owner", role: "owner", isSelf: true })],
      createInvitation,
    });

    await user.type(screen.getByLabelText("Email address"), "ada@example.com");
    await user.click(screen.getByRole("button", { name: "Invite member" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      MUTATION_ERRORS.inviteAlreadyPending.message,
    );
  });

  it("shows remaining seats from active members plus pending invitations", () => {
    const ownerSelf = makeMemberView({
      displayName: "Olive Owner",
      role: "owner",
      isSelf: true,
    });
    const mockPendingInvite = MOCK_PENDING_INVITATIONS[0];
    if (!mockPendingInvite) {
      throw new Error("MOCK_PENDING_INVITATIONS must include at least one row");
    }
    setup({
      members: [ownerSelf, maya],
      pendingInvitations: [mockPendingInvite],
    });

    expect(screen.getByText("253 of 256 seats remaining")).toBeInTheDocument();
  });

  it("disables invite submit and shows at-capacity copy when no seats remain", () => {
    const mockPendingInvite = MOCK_PENDING_INVITATIONS[0];
    if (!mockPendingInvite) {
      throw new Error("MOCK_PENDING_INVITATIONS must include at least one row");
    }
    const members = Array.from({ length: 255 }, (_, index) =>
      makeMemberView({
        id: testId<Member["id"]>(`mem-capacity-${index}`),
        displayName: `Member ${index}`,
        role: index === 0 ? "owner" : "member",
        isSelf: index === 0,
      }),
    );
    setup({
      members,
      pendingInvitations: [mockPendingInvite],
    });

    expect(
      screen.getByText(
        /this circle is full\. revoke a pending invitation or remove a member to free a seat\./i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("0 of 256 seats remaining")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Invite member" })).toBeDisabled();
  });

  it("does not disable invite submit for at-capacity while seat counts are loading", async () => {
    const ownerSelf = makeMemberView({
      displayName: "Olive Owner",
      role: "owner",
      isSelf: true,
    });
    setup({
      members: [ownerSelf],
      pendingInvitations: undefined,
    });

    expect(
      screen.queryByText(
        /this circle is full\. revoke a pending invitation or remove a member to free a seat\./i,
      ),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Loading seat availability…")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Email address"), "ada@example.com");

    expect(screen.getByRole("button", { name: "Invite member" })).toBeEnabled();
  });
});

function pickTransferTarget(user: ReturnType<typeof userEvent.setup>, targetName: string) {
  return (async () => {
    const form = screen.getByRole("region", { name: "Transfer ownership" });
    await user.click(within(form).getByRole("combobox", { name: "Transfer to member" }));
    await user.click(await screen.findByRole("option", { name: targetName }));
  })();
}

describe("CircleMembers — transfer ownership", () => {
  it("renders the transfer form for an owner on a regular circle with another member", () => {
    setup({
      members: [makeMemberView({ displayName: "Olive Owner", role: "owner", isSelf: true }), maya],
    });
    expect(screen.getByRole("region", { name: "Transfer ownership" })).toBeInTheDocument();
  });

  it("renders the transfer form on an archived regular Circle with another member", () => {
    setup({
      circle: makeCircleView({ status: "archived" }),
      members: [makeMemberView({ displayName: "Olive Owner", role: "owner", isSelf: true }), maya],
    });
    expect(screen.getByRole("region", { name: "Transfer ownership" })).toBeInTheDocument();
  });

  it("hides the transfer form when the owner is solo", () => {
    setup({
      members: [makeMemberView({ displayName: "Olive Owner", role: "owner", isSelf: true })],
    });
    expect(screen.queryByRole("region", { name: "Transfer ownership" })).not.toBeInTheDocument();
  });

  it("hides the transfer form for a non-owner member", () => {
    setup({
      members: [
        owner,
        makeMemberView({ ...maya, isSelf: true, role: "member", displayName: "Maya Member" }),
      ],
    });
    expect(screen.queryByRole("region", { name: "Transfer ownership" })).not.toBeInTheDocument();
  });

  it("hides the transfer form on a Personal Circle", () => {
    setup({
      circle: makeCircleView({ kind: "personal" }),
      members: [makeMemberView({ displayName: "You", role: "owner", isSelf: true })],
    });
    expect(screen.queryByRole("region", { name: "Transfer ownership" })).not.toBeInTheDocument();
  });

  it("shows a confirm section after picking a target", async () => {
    const user = userEvent.setup();
    setup({
      members: [makeMemberView({ displayName: "Olive Owner", role: "owner", isSelf: true }), maya],
    });

    await pickTransferTarget(user, "Maya Member");

    expect(screen.getByText("Transfer ownership to Maya Member?")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Confirm transfer ownership to Maya Member" }),
    ).toBeInTheDocument();
  });

  it("clears the selection on Cancel without calling the mutation", async () => {
    const transferOwnership = vi.fn();
    const user = userEvent.setup();
    setup({
      members: [makeMemberView({ displayName: "Olive Owner", role: "owner", isSelf: true }), maya],
      transferOwnership,
    });

    await pickTransferTarget(user, "Maya Member");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText("Transfer ownership to Maya Member?")).not.toBeInTheDocument();
    expect(transferOwnership).not.toHaveBeenCalled();
  });

  it("calls transferOwnership with correct args and disables Confirm while in-flight", async () => {
    const transferOwnership = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(resolve, 50);
        }),
    );
    const user = userEvent.setup();
    setup({
      members: [makeMemberView({ displayName: "Olive Owner", role: "owner", isSelf: true }), maya],
      transferOwnership,
    });

    await pickTransferTarget(user, "Maya Member");
    const confirm = screen.getByRole("button", {
      name: "Confirm transfer ownership to Maya Member",
    });
    await user.click(confirm);

    expect(confirm).toBeDisabled();
    expect(confirm).toHaveTextContent("Transferring…");
    expect(transferOwnership).toHaveBeenCalledWith({
      circleId: makeCircleView().id,
      toMemberId: maya.id,
    });
  });

  it("shows a success message and clears the form on success", async () => {
    const transferOwnership = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    setup({
      members: [makeMemberView({ displayName: "Olive Owner", role: "owner", isSelf: true }), maya],
      transferOwnership,
    });

    await pickTransferTarget(user, "Maya Member");
    await user.click(
      screen.getByRole("button", { name: "Confirm transfer ownership to Maya Member" }),
    );

    expect(
      await screen.findByRole("status", { name: "Ownership transfer result" }),
    ).toHaveTextContent("Ownership transferred to Maya Member.");
    expect(screen.queryByText("Transfer ownership to Maya Member?")).not.toBeInTheDocument();
  });

  it("maps a coded mutation error to shared user copy", async () => {
    const transferOwnership = vi
      .fn()
      .mockRejectedValue(
        new ConvexError(mutationErrorData(MUTATION_ERRORS.transferTargetNotMember)),
      );
    const user = userEvent.setup();
    setup({
      members: [makeMemberView({ displayName: "Olive Owner", role: "owner", isSelf: true }), maya],
      transferOwnership,
    });

    await pickTransferTarget(user, "Maya Member");
    await user.click(
      screen.getByRole("button", { name: "Confirm transfer ownership to Maya Member" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      MUTATION_ERRORS.transferTargetNotMember.message,
    );
    expect(transferOwnership).toHaveBeenCalledTimes(1);
  });
});

describe("CircleMembers — remove member", () => {
  it("shows Remove on non-owner rows for the Owner only", () => {
    setup({
      members: [makeMemberView({ displayName: "Olive Owner", role: "owner", isSelf: true }), maya],
    });
    expect(screen.getByRole("button", { name: "Remove Maya Member" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove Olive Owner/ })).not.toBeInTheDocument();
  });

  it("does not show Remove on the Owner's own row", () => {
    setup({
      members: [makeMemberView({ displayName: "Olive Owner", role: "owner", isSelf: true })],
    });
    expect(screen.queryByRole("button", { name: /Remove / })).not.toBeInTheDocument();
  });

  it("hides Remove buttons for a non-owner Member", () => {
    setup({
      members: [
        owner,
        makeMemberView({ ...maya, isSelf: true, role: "member", displayName: "Maya Member" }),
      ],
    });
    expect(screen.queryByRole("button", { name: /Remove / })).not.toBeInTheDocument();
  });

  it("hides Remove buttons on a Personal Circle", () => {
    setup({
      circle: makeCircleView({ kind: "personal" }),
      members: [makeMemberView({ displayName: "Olive Owner", role: "owner", isSelf: true }), maya],
    });
    expect(screen.queryByRole("button", { name: /Remove / })).not.toBeInTheDocument();
  });

  it("hides Remove buttons on an archived Circle", () => {
    setup({
      circle: makeCircleView({ status: "archived" }),
      members: [makeMemberView({ displayName: "Olive Owner", role: "owner", isSelf: true }), maya],
    });
    expect(screen.queryByRole("button", { name: /Remove / })).not.toBeInTheDocument();
  });

  it("opens a confirmation dialog with the member's name", async () => {
    const user = userEvent.setup();
    setup({
      members: [makeMemberView({ displayName: "Olive Owner", role: "owner", isSelf: true }), maya],
    });

    await user.click(screen.getByRole("button", { name: "Remove Maya Member" }));

    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("Maya Member");
    expect(within(dialog).getByRole("button", { name: "Remove member" })).toBeInTheDocument();
  });

  it("closes the dialog on Cancel without calling the mutation", async () => {
    const removeMember = vi.fn();
    const user = userEvent.setup();
    setup({
      members: [makeMemberView({ displayName: "Olive Owner", role: "owner", isSelf: true }), maya],
      removeMember,
    });

    await user.click(screen.getByRole("button", { name: "Remove Maya Member" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }),
    );

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(removeMember).not.toHaveBeenCalled();
  });

  it("calls removeMember and disables Confirm while in-flight", async () => {
    const removeMember = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(resolve, 50);
        }),
    );
    const user = userEvent.setup();
    setup({
      members: [makeMemberView({ displayName: "Olive Owner", role: "owner", isSelf: true }), maya],
      removeMember,
    });

    await user.click(screen.getByRole("button", { name: "Remove Maya Member" }));
    const confirm = within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Remove member",
    });
    await user.click(confirm);

    expect(confirm).toBeDisabled();
    expect(confirm).toHaveTextContent("Removing…");
    expect(removeMember).toHaveBeenCalledWith({
      circleId: makeCircleView().id,
      memberId: maya.id,
    });
  });

  it("maps a coded mutation error inside the dialog", async () => {
    const removeMember = vi
      .fn()
      .mockRejectedValue(new ConvexError(mutationErrorData(MUTATION_ERRORS.memberRemoveForbidden)));
    const user = userEvent.setup();
    setup({
      members: [makeMemberView({ displayName: "Olive Owner", role: "owner", isSelf: true }), maya],
      removeMember,
    });

    await user.click(screen.getByRole("button", { name: "Remove Maya Member" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Remove member" }),
    );

    expect(await within(screen.getByRole("alertdialog")).findByRole("alert")).toHaveTextContent(
      MUTATION_ERRORS.memberRemoveForbidden.message,
    );
  });

  it("drops the row after a successful removal", async () => {
    const liveMembers = [
      makeMemberView({ displayName: "Olive Owner", role: "owner", isSelf: true }),
      maya,
    ];
    const removeMember = vi.fn().mockImplementation(async () => {
      liveMembers.pop();
    });
    const user = userEvent.setup();
    setup({ members: liveMembers, removeMember });

    await user.click(screen.getByRole("button", { name: "Remove Maya Member" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Remove member" }),
    );

    await expect(
      within(screen.getByRole("list", { name: "Circle members" })).findByRole("listitem"),
    ).resolves.toHaveTextContent("Olive Owner");
    expect(screen.queryByText("Maya Member")).not.toBeInTheDocument();
  });
});

describe("CircleMembers — pending invitations", () => {
  const ownerSelf = makeMemberView({
    displayName: "Olive Owner",
    role: "owner",
    isSelf: true,
  });
  const mockPendingInvite = MOCK_PENDING_INVITATIONS[0];
  if (!mockPendingInvite) {
    throw new Error("MOCK_PENDING_INVITATIONS must include at least one row");
  }

  it("shows pending invitations for the Owner", () => {
    setup({
      members: [ownerSelf],
      pendingInvitations: MOCK_PENDING_INVITATIONS,
    });
    expect(screen.getByRole("region", { name: "Pending invitations" })).toBeInTheDocument();
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
  });

  it("hides pending invitations for a non-owner Member", () => {
    setup({
      members: [owner, makeMemberView({ ...maya, isSelf: true, role: "member" })],
      pendingInvitations: MOCK_PENDING_INVITATIONS,
    });
    expect(screen.queryByRole("region", { name: "Pending invitations" })).not.toBeInTheDocument();
  });

  it("renders a skeleton while pending invitations load", () => {
    setup({
      members: [ownerSelf],
      pendingInvitations: undefined,
    });
    const skeleton = screen.getByTestId("pending-invitations-skeleton");
    expect(skeleton).toHaveAttribute("aria-busy", "true");
  });

  it("renders gracefully when there are no pending invitations", () => {
    setup({
      members: [ownerSelf],
      pendingInvitations: [],
    });
    expect(screen.getByText(/no pending invitations/i)).toBeInTheDocument();
  });

  it("calls resend and shows a success status on success", async () => {
    const resendInvitation = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(undefined), 50);
        }),
    );
    const user = userEvent.setup();
    setup({
      members: [ownerSelf],
      pendingInvitations: [mockPendingInvite],
      resendInvitation,
    });

    const resend = screen.getByRole("button", { name: "Resend" });
    await user.click(resend);

    expect(resend).toBeDisabled();
    expect(resend).toHaveTextContent("Resending…");

    expect(await screen.findByRole("status")).toHaveTextContent(
      /invitation resent to ada@example.com/i,
    );
    expect(screen.queryByLabelText("Invitation link")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy link" })).not.toBeInTheDocument();
    expect(resendInvitation).toHaveBeenCalledWith({
      invitationId: mockPendingInvite.id,
    });
  });

  it("calls revoke and shows a confirmation status", async () => {
    const revokeInvitation = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    setup({
      members: [ownerSelf],
      pendingInvitations: [mockPendingInvite],
      revokeInvitation,
    });

    await user.click(screen.getByRole("button", { name: "Revoke" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      /revoked invitation for ada@example.com/i,
    );
    expect(revokeInvitation).toHaveBeenCalledWith({
      invitationId: mockPendingInvite.id,
    });
  });

  it("maps invite.resendCapReached to shared user copy", async () => {
    const resendInvitation = vi
      .fn()
      .mockRejectedValue(
        new ConvexError(mutationErrorData(MUTATION_ERRORS.inviteResendCapReached)),
      );
    const user = userEvent.setup();
    setup({
      members: [ownerSelf],
      pendingInvitations: [mockPendingInvite],
      resendInvitation,
    });

    await user.click(screen.getByRole("button", { name: "Resend" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      MUTATION_ERRORS.inviteResendCapReached.message,
    );
  });

  it("maps invite.dailyCapReached to shared user copy", async () => {
    const resendInvitation = vi
      .fn()
      .mockRejectedValue(new ConvexError(mutationErrorData(MUTATION_ERRORS.inviteDailyCapReached)));
    const user = userEvent.setup();
    setup({
      members: [ownerSelf],
      pendingInvitations: [mockPendingInvite],
      resendInvitation,
    });

    await user.click(screen.getByRole("button", { name: "Resend" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      MUTATION_ERRORS.inviteDailyCapReached.message,
    );
  });
});

describe("CircleMembers — leave circle", () => {
  it("hides the leave section on a Personal Circle", () => {
    setup({
      circle: makeCircleView({ kind: "personal" }),
      members: [makeMemberView({ displayName: "You", role: "owner", isSelf: true })],
    });
    expect(screen.queryByRole("region", { name: "Leave circle" })).not.toBeInTheDocument();
  });

  it("shows a transfer-first notice for the Owner instead of a leave button", () => {
    setup({
      members: [makeMemberView({ displayName: "Olive Owner", role: "owner", isSelf: true })],
    });
    expect(screen.getByText(/transfer ownership before leaving/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Leave Circle" })).not.toBeInTheDocument();
  });

  it("shows a leave button for a non-owner self member", () => {
    setup({
      members: [
        owner,
        makeMemberView({ ...maya, isSelf: true, role: "member", displayName: "Maya Member" }),
      ],
    });
    expect(screen.getByRole("button", { name: "Leave Circle" })).toBeInTheDocument();
  });

  it("does not show a leave button for other members' rows", () => {
    setup({ members: [owner, maya] });
    expect(screen.queryByRole("button", { name: "Leave Circle" })).not.toBeInTheDocument();
  });

  it("shows confirmation on leave click and dismisses on cancel without calling the mutation", async () => {
    const leaveCircle = vi.fn();
    const user = userEvent.setup();
    setup({
      members: [
        owner,
        makeMemberView({ ...maya, isSelf: true, role: "member", displayName: "Maya Member" }),
      ],
      leaveCircle,
    });

    await user.click(screen.getByRole("button", { name: "Leave Circle" }));
    expect(screen.getByText(/are you sure/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(/are you sure/i)).not.toBeInTheDocument();
    expect(leaveCircle).not.toHaveBeenCalled();
  });

  it("calls leaveCircle on confirm, disables buttons while in-flight, and navigates home on success", async () => {
    const leaveCircle = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(resolve, 50);
        }),
    );
    const user = userEvent.setup();
    setup({
      members: [
        owner,
        makeMemberView({ ...maya, isSelf: true, role: "member", displayName: "Maya Member" }),
      ],
      leaveCircle,
    });

    await user.click(screen.getByRole("button", { name: "Leave Circle" }));
    const confirm = screen.getByRole("button", { name: "Confirm Leave" });
    await user.click(confirm);

    expect(confirm).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(confirm).toHaveTextContent("Leaving…");

    await vi.waitFor(() => {
      expect(leaveCircle).toHaveBeenCalledWith({ circleId: makeCircleView().id });
      expect(navigate).toHaveBeenCalledWith("/");
    });
  });

  it("maps a coded leave error to shared user copy", async () => {
    const leaveCircle = vi
      .fn()
      .mockRejectedValue(new ConvexError(mutationErrorData(MUTATION_ERRORS.ownerMustTransfer)));
    const user = userEvent.setup();
    setup({
      members: [
        owner,
        makeMemberView({ ...maya, isSelf: true, role: "member", displayName: "Maya Member" }),
      ],
      leaveCircle,
    });

    await user.click(screen.getByRole("button", { name: "Leave Circle" }));
    await user.click(screen.getByRole("button", { name: "Confirm Leave" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      MUTATION_ERRORS.ownerMustTransfer.message,
    );
  });

  it("shows fallback copy for an unexpected leave error", async () => {
    const leaveCircle = vi.fn().mockRejectedValue(new Error("network"));
    const user = userEvent.setup();
    setup({
      members: [
        owner,
        makeMemberView({ ...maya, isSelf: true, role: "member", displayName: "Maya Member" }),
      ],
      leaveCircle,
    });

    await user.click(screen.getByRole("button", { name: "Leave Circle" }));
    await user.click(screen.getByRole("button", { name: "Confirm Leave" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't leave. Please try again.");
  });
});
