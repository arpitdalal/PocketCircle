import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { Member } from "~/lib/data.js";
import { testId } from "~/test/convex/ids.js";
import {
  type ConvexState,
  configureConvex,
  makeCircleView,
  makeMemberView,
  renderCircleRoutes,
} from "~/test/convex-react.js";

vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);

import CircleSetup from "./setup.js";

const ownerMember = makeMemberView({ role: "owner", isSelf: true });
const regularMember = makeMemberView({
  id: testId<Member["id"]>("member-maya"),
  role: "member",
  isSelf: true,
  displayName: "Maya Member",
});

function renderSetup(
  circle = makeCircleView({ setupComplete: false }),
  convex: ConvexState = {},
  initialEntry?: string,
) {
  configureConvex({ members: [ownerMember], ...convex });
  return renderCircleRoutes(
    circle,
    <>
      <Route path="/circles/:circleRef" element={<div>dashboard</div>} />
      <Route path="/circles/personal-p1" element={<div>personal dashboard</div>} />
      <Route path="/circles/:circleRef/setup" element={<CircleSetup />} />
    </>,
    { initialEntries: [initialEntry ?? `/circles/${circle.ref}/setup`] },
  );
}

describe("Circle setup", () => {
  it("submits optional answers, then returns to the circle dashboard", async () => {
    const user = userEvent.setup();
    const completeCircleSetup = vi.fn().mockResolvedValue({ createdCategoryIds: ["cat-rent"] });
    const circle = makeCircleView({ ref: "home-c1", currency: "USD", setupComplete: false });
    const view = renderSetup(circle, { completeCircleSetup });

    await user.selectOptions(screen.getByLabelText("Circle use"), "residence");
    await user.selectOptions(screen.getByLabelText("Residence type"), "leased");
    await user.click(screen.getByRole("button", { name: "Finish setup" }));

    expect(completeCircleSetup).toHaveBeenCalledWith({
      circleId: circle.id,
      answers: { purpose: "residence", residenceType: "leased" },
    });
    await waitFor(() => {
      expect(view.location()).toBe(`/circles/${circle.ref}`);
    });
    expect(await screen.findByText("Circle setup complete.")).toBeInTheDocument();
  });

  it("finishes with default answers when no purpose is chosen", async () => {
    const user = userEvent.setup();
    const completeCircleSetup = vi.fn().mockResolvedValue({ createdCategoryIds: [] });
    const circle = makeCircleView({ ref: "trip-c1", setupComplete: false });
    const view = renderSetup(circle, { completeCircleSetup });

    await user.click(screen.getByRole("button", { name: "Finish setup" }));

    expect(completeCircleSetup).toHaveBeenCalledWith({ circleId: circle.id, answers: {} });
    await waitFor(() => {
      expect(view.location()).toBe(`/circles/${circle.ref}`);
    });
  });

  it("returns to returnTo origin after finishing setup", async () => {
    const user = userEvent.setup();
    const completeCircleSetup = vi.fn().mockResolvedValue({ createdCategoryIds: [] });
    const circle = makeCircleView({ ref: "trip-c1", setupComplete: false });
    const origin = "/circles/personal-p1";
    const view = renderSetup(
      circle,
      { completeCircleSetup },
      `/circles/${circle.ref}/setup?returnTo=${encodeURIComponent(origin)}`,
    );

    await user.click(screen.getByRole("button", { name: "Finish setup" }));

    await waitFor(() => {
      expect(view.location()).toBe(origin);
    });
  });

  it("keeps placeholder choices non-selectable", async () => {
    const user = userEvent.setup();
    renderSetup(undefined, { completeCircleSetup: vi.fn() });

    expect(screen.getByRole("option", { name: "Not sure yet" })).toBeDisabled();

    await user.selectOptions(screen.getByLabelText("Circle use"), "residence");

    for (const option of screen.getAllByRole("option", { name: "Not sure yet" })) {
      expect(option).toBeDisabled();
    }
  });

  it("redirects completed setup away from the setup route", async () => {
    const completeCircleSetup = vi.fn();
    const circle = makeCircleView({
      ref: "home-c1",
      setupComplete: true,
      setupAnswers: { purpose: "residence", residenceType: "leased" },
    });
    const view = renderSetup(circle, { completeCircleSetup });

    await waitFor(() => {
      expect(view.location()).toBe(`/circles/${circle.ref}`);
    });
    expect(completeCircleSetup).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Finish setup" })).not.toBeInTheDocument();
  });

  it("shows a waiting notice to non-owners instead of looping", async () => {
    const completeCircleSetup = vi.fn();
    const circle = makeCircleView({ ref: "trip-c1", setupComplete: false });
    const view = renderSetup(circle, {
      completeCircleSetup,
      members: [regularMember],
    });

    expect(await screen.findByText(/owner is still setting things up/i)).toBeInTheDocument();
    expect(view.location()).toBe(`/circles/${circle.ref}/setup`);
    expect(completeCircleSetup).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Finish setup" })).not.toBeInTheDocument();
  });

  it("surfaces setup failure and keeps the form enabled for retry", async () => {
    const user = userEvent.setup();
    const completeCircleSetup = vi.fn().mockRejectedValue(new Error("network"));
    const view = renderSetup(undefined, { completeCircleSetup });

    await user.click(screen.getByRole("button", { name: "Finish setup" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/Couldn't complete setup/);
    expect(screen.getByRole("button", { name: "Finish setup" })).toBeEnabled();
    expect(view.location()).toBe("/circles/trip-c1/setup");
  });
});
