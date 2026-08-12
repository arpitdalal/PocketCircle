import { colorHex, MUTATION_ERRORS, mutationErrorData } from "@pocketcircle/domain";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { Route } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { Member } from "~/lib/data.js";
import {
  makePaletteOnlyUpdateCircleSettingsHandler,
  makeUpdateCircleSettingsHandler,
} from "~/test/convex/circle-settings.js";
import {
  configureConvex,
  makeCircleView,
  makeMemberView,
  renderCircleRoutes,
} from "~/test/convex-react.js";

vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);

import CircleSettings from "./settings.js";

const ownerMember = makeMemberView({ role: "owner", isSelf: true });
const regularMember = makeMemberView({
  id: makeMemberView().id,
  role: "member",
  isSelf: true,
  displayName: "Maya Member",
});

function renderSettings(
  circle = makeCircleView({ ref: "trip-c1", setupAnswers: { purpose: "trip" } }),
  members: Member[] | null | undefined = [ownerMember],
) {
  configureConvex({ members });
  return renderCircleRoutes(
    circle,
    <>
      <Route path="/circles/:circleRef" element={<div>dashboard</div>} />
      <Route path="/circles/:circleRef/settings" element={<CircleSettings />} />
    </>,
    { initialEntries: [`/circles/${circle.ref}/settings`] },
  );
}

describe("Circle settings", () => {
  it("lets the owner rename the circle and update color and setup answers", async () => {
    const user = userEvent.setup();
    const renameCircle = vi.fn().mockResolvedValue(undefined);
    const updateCircleSettings = vi.fn().mockResolvedValue(undefined);
    const circle = makeCircleView({ ref: "trip-c1", setupAnswers: { purpose: "trip" } });
    configureConvex({ members: [ownerMember], renameCircle, updateCircleSettings });
    renderCircleRoutes(
      circle,
      <>
        <Route path="/circles/:circleRef" element={<div>dashboard</div>} />
        <Route path="/circles/:circleRef/settings" element={<CircleSettings />} />
      </>,
      { initialEntries: [`/circles/${circle.ref}/settings`] },
    );

    await user.clear(screen.getByLabelText("Circle name"));
    await user.type(screen.getByLabelText("Circle name"), "Japan Trip");
    await user.click(screen.getByRole("button", { name: "Save name" }));
    expect(renameCircle).toHaveBeenCalledWith({ circleId: circle.id, name: "Japan Trip" });

    await user.click(screen.getByRole("button", { name: "Green" }));
    expect(updateCircleSettings).toHaveBeenCalledWith({ circleId: circle.id, color: "green" });
    expect(screen.getByTestId("mark-tint")).toHaveAttribute("data-color-hex", colorHex("green"));

    await user.selectOptions(screen.getByLabelText("Circle use"), "residence");
    await user.selectOptions(screen.getByLabelText("Residence type"), "leased");
    await user.click(screen.getByRole("button", { name: "Save setup answers" }));
    expect(updateCircleSettings).toHaveBeenCalledWith({
      circleId: circle.id,
      setupAnswers: { purpose: "residence", residenceType: "leased" },
    });
  });

  it("redirects non-owners to the dashboard", async () => {
    const circle = makeCircleView({ ref: "trip-c1" });
    const view = renderSettings(circle, [regularMember]);

    await waitFor(() => {
      expect(view.location()).toBe(`/circles/${circle.ref}`);
    });
    expect(screen.getByText("dashboard")).toBeInTheDocument();
  });

  it("saves iris on Personal Circle settings with kind-aware server validation", async () => {
    const user = userEvent.setup();
    const circle = makeCircleView({
      ref: "personal-c0",
      kind: "personal",
      color: "green",
      setupComplete: true,
    });
    const updateCircleSettings = makeUpdateCircleSettingsHandler(circle);
    configureConvex({ members: [ownerMember], updateCircleSettings });
    renderCircleRoutes(
      circle,
      <>
        <Route path="/circles/:circleRef" element={<div>dashboard</div>} />
        <Route path="/circles/:circleRef/settings" element={<CircleSettings />} />
      </>,
      { initialEntries: [`/circles/${circle.ref}/settings`] },
    );

    await user.click(screen.getByRole("button", { name: "Iris" }));

    expect(updateCircleSettings).toHaveBeenCalledWith({ circleId: circle.id, color: "iris" });
    expect(await screen.findByText(/Circle color updated/)).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't save the color/)).not.toBeInTheDocument();
    expect(screen.getByTestId("mark-tint")).toHaveAttribute("data-color-hex", colorHex("iris"));
  });

  it("surfaces a save failure when iris is rejected by palette-only validation", async () => {
    const user = userEvent.setup();
    const circle = makeCircleView({
      ref: "personal-c0",
      kind: "personal",
      color: "green",
      setupComplete: true,
    });
    configureConvex({
      members: [ownerMember],
      updateCircleSettings: makePaletteOnlyUpdateCircleSettingsHandler(),
    });
    renderCircleRoutes(
      circle,
      <>
        <Route path="/circles/:circleRef" element={<div>dashboard</div>} />
        <Route path="/circles/:circleRef/settings" element={<CircleSettings />} />
      </>,
      { initialEntries: [`/circles/${circle.ref}/settings`] },
    );

    await user.click(screen.getByRole("button", { name: "Iris" }));

    expect(await screen.findByText(/Couldn't save the color/)).toBeInTheDocument();
    expect(screen.getByTestId("mark-tint")).toHaveAttribute("data-color-hex", colorHex("green"));
  });

  it("does not offer iris on regular circle settings", () => {
    renderSettings(makeCircleView({ ref: "trip-c1", kind: "regular", color: "blue" }));
    expect(screen.queryByRole("button", { name: "Iris" })).not.toBeInTheDocument();
  });

  it("does not call mutations when setup answers are unchanged", async () => {
    const user = userEvent.setup();
    const updateCircleSettings = vi.fn();
    const circle = makeCircleView({
      ref: "trip-c1",
      setupAnswers: { purpose: "residence", residenceType: "leased" },
    });
    configureConvex({ members: [ownerMember], updateCircleSettings });
    renderCircleRoutes(
      circle,
      <Route path="/circles/:circleRef/settings" element={<CircleSettings />} />,
      { initialEntries: [`/circles/${circle.ref}/settings`] },
    );

    expect(screen.getByRole("button", { name: "Save setup answers" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Save setup answers" }));
    expect(updateCircleSettings).not.toHaveBeenCalled();
  });
});

describe("Personal Circle name auto-sync toggle", () => {
  it("renders ON for an auto-tracking Personal Circle and OFF when customized", () => {
    const autoCircle = makeCircleView({
      ref: "personal-c0",
      kind: "personal",
      nameCustomized: false,
    });
    const { rerender } = renderSettings(autoCircle);
    expect(screen.getByRole("switch", { name: "Match my display name" })).toBeChecked();

    rerender(
      makeCircleView({
        ref: "personal-c0",
        kind: "personal",
        nameCustomized: true,
      }),
    );

    expect(screen.getByRole("switch", { name: "Match my display name" })).not.toBeChecked();
  });

  it("calls setPersonalCircleNameAutoSync with enabled true when turned on", async () => {
    const user = userEvent.setup();
    const setPersonalCircleNameAutoSync = vi.fn().mockResolvedValue(undefined);
    const circle = makeCircleView({
      ref: "personal-c0",
      kind: "personal",
      nameCustomized: true,
    });
    configureConvex({ members: [ownerMember], setPersonalCircleNameAutoSync });
    renderCircleRoutes(
      circle,
      <>
        <Route path="/circles/:circleRef" element={<div>dashboard</div>} />
        <Route path="/circles/:circleRef/settings" element={<CircleSettings />} />
      </>,
      { initialEntries: [`/circles/${circle.ref}/settings`] },
    );

    await user.click(screen.getByRole("switch", { name: "Match my display name" }));

    expect(setPersonalCircleNameAutoSync).toHaveBeenCalledWith({ enabled: true });
  });

  it("shows OFF after a rename when the circle view becomes customized", () => {
    const customizedCircle = makeCircleView({
      ref: "personal-c0",
      kind: "personal",
      name: "Vacation Fund",
      nameCustomized: true,
    });
    renderSettings(customizedCircle);
    expect(screen.getByRole("switch", { name: "Match my display name" })).not.toBeChecked();
  });

  it("is hidden for regular circles", () => {
    renderSettings(makeCircleView({ ref: "trip-c1", kind: "regular" }));
    expect(screen.queryByRole("switch", { name: "Match my display name" })).not.toBeInTheDocument();
  });
});

describe("Circle archive and restore", () => {
  it("archives a regular circle after confirmation", async () => {
    const user = userEvent.setup();
    const archiveCircle = vi.fn().mockResolvedValue(undefined);
    const circle = makeCircleView({ ref: "trip-c1", kind: "regular", status: "active" });
    configureConvex({ members: [ownerMember], archiveCircle });
    renderCircleRoutes(
      circle,
      <Route path="/circles/:circleRef/settings" element={<CircleSettings />} />,
      { initialEntries: [`/circles/${circle.ref}/settings`] },
    );

    await user.click(screen.getByRole("button", { name: "Archive circle" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Archive circle" }),
    );

    expect(archiveCircle).toHaveBeenCalledWith({ circleId: circle.id });
  });

  it("disables settings forms when archived and offers restore", async () => {
    const user = userEvent.setup();
    const restoreCircle = vi.fn().mockResolvedValue(undefined);
    const circle = makeCircleView({ ref: "trip-c1", kind: "regular", status: "archived" });
    configureConvex({ members: [ownerMember], restoreCircle });
    renderCircleRoutes(
      circle,
      <Route path="/circles/:circleRef/settings" element={<CircleSettings />} />,
      { initialEntries: [`/circles/${circle.ref}/settings`] },
    );

    expect(screen.getByText(/This circle is archived/)).toBeInTheDocument();
    expect(screen.getByLabelText("Circle name")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save name" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Archive circle" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Restore circle" }));
    expect(restoreCircle).toHaveBeenCalledWith({ circleId: circle.id });
  });

  it("hides archive controls on a Personal Circle", () => {
    renderSettings(makeCircleView({ ref: "personal-c0", kind: "personal" }));
    expect(screen.queryByRole("button", { name: "Archive circle" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore circle" })).not.toBeInTheDocument();
  });

  it("hides archive controls before setup is complete", () => {
    renderSettings(
      makeCircleView({ ref: "trip-c1", kind: "regular", setupComplete: false, status: "active" }),
    );
    expect(screen.queryByRole("button", { name: "Archive circle" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore circle" })).not.toBeInTheDocument();
  });

  it("flips to read-only when the live circle query archives mid-view", () => {
    const active = makeCircleView({ ref: "trip-c1", kind: "regular", status: "active" });
    configureConvex({ members: [ownerMember] });
    const view = renderCircleRoutes(
      active,
      <Route path="/circles/:circleRef/settings" element={<CircleSettings />} />,
      { initialEntries: [`/circles/${active.ref}/settings`] },
    );

    expect(screen.getByRole("button", { name: "Archive circle" })).toBeInTheDocument();

    view.rerender(makeCircleView({ ref: "trip-c1", kind: "regular", status: "archived" }));

    expect(screen.getByRole("button", { name: "Restore circle" })).toBeInTheDocument();
    expect(screen.getByLabelText("Circle name")).toBeDisabled();
  });
});

describe("Circle delete", () => {
  it("deletes an empty regular circle after confirmation and navigates home", async () => {
    const user = userEvent.setup();
    const deleteCircle = vi.fn().mockResolvedValue(undefined);
    const circle = makeCircleView({
      ref: "trip-c1",
      kind: "regular",
      setupComplete: false,
      status: "active",
    });
    configureConvex({
      members: [ownerMember],
      circleHasTransactions: false,
      deleteCircle,
    });
    const view = renderCircleRoutes(
      circle,
      <>
        <Route path="/" element={<div>home</div>} />
        <Route path="/circles/:circleRef/settings" element={<CircleSettings />} />
      </>,
      { initialEntries: [`/circles/${circle.ref}/settings`] },
    );

    await user.click(screen.getByRole("button", { name: "Delete circle" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete circle" }),
    );

    expect(deleteCircle).toHaveBeenCalledWith({ circleId: circle.id });
    await waitFor(() => {
      expect(view.location()).toBe("/");
    });
    expect(screen.getByText("home")).toBeInTheDocument();
  });

  it("surfaces coded server rejection in the delete dialog", async () => {
    const user = userEvent.setup();
    const deleteCircle = vi
      .fn()
      .mockRejectedValue(new ConvexError(mutationErrorData(MUTATION_ERRORS.circleDeleteNotEmpty)));
    const circle = makeCircleView({ ref: "trip-c1", kind: "regular", setupComplete: false });
    configureConvex({
      members: [ownerMember],
      circleHasTransactions: false,
      deleteCircle,
    });
    renderCircleRoutes(
      circle,
      <Route path="/circles/:circleRef/settings" element={<CircleSettings />} />,
      { initialEntries: [`/circles/${circle.ref}/settings`] },
    );

    await user.click(screen.getByRole("button", { name: "Delete circle" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete circle" }),
    );

    expect(
      await screen.findByText(MUTATION_ERRORS.circleDeleteNotEmpty.message),
    ).toBeInTheDocument();
  });

  it("points owners with history toward archive instead of delete", () => {
    const circle = makeCircleView({ ref: "trip-c1", kind: "regular", setupComplete: true });
    configureConvex({
      members: [ownerMember, makeMemberView({ id: makeMemberView().id, displayName: "Guest" })],
      circleHasTransactions: false,
    });
    renderCircleRoutes(
      circle,
      <Route path="/circles/:circleRef/settings" element={<CircleSettings />} />,
      { initialEntries: [`/circles/${circle.ref}/settings`] },
    );

    expect(screen.queryByRole("button", { name: "Delete circle" })).not.toBeInTheDocument();
    expect(screen.getByText(/cannot be deleted/i)).toBeInTheDocument();
    expect(screen.getByText(/Archive it instead/i)).toBeInTheDocument();
  });

  it("hides delete controls on a Personal Circle", () => {
    renderSettings(makeCircleView({ ref: "personal-c0", kind: "personal" }), [ownerMember]);
    expect(screen.queryByRole("button", { name: "Delete circle" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Delete circle/)).not.toBeInTheDocument();
  });
});

describe("Circle settings — currency", () => {
  it("lets the owner pick a currency when unlocked", async () => {
    const user = userEvent.setup();
    const setCurrency = vi.fn().mockResolvedValue(undefined);
    const circle = makeCircleView({ ref: "trip-c1", currency: "USD", currencyLocked: false });
    configureConvex({
      members: [ownerMember],
      circleHasTransactions: false,
      setCurrency,
    });
    renderCircleRoutes(
      circle,
      <Route path="/circles/:circleRef/settings" element={<CircleSettings />} />,
      { initialEntries: [`/circles/${circle.ref}/settings`] },
    );

    await user.selectOptions(screen.getByLabelText("Circle currency"), "EUR");

    expect(setCurrency).toHaveBeenCalledWith({ circleId: circle.id, currency: "EUR" });
    expect(await screen.findByText(/Circle currency updated/)).toBeInTheDocument();
  });

  it("shows currency read-only when locked via currencyLocked", () => {
    const circle = makeCircleView({
      ref: "trip-c1",
      currency: "USD",
      currencyLocked: true,
    });
    configureConvex({ members: [ownerMember], circleHasTransactions: false });
    renderCircleRoutes(
      circle,
      <Route path="/circles/:circleRef/settings" element={<CircleSettings />} />,
      { initialEntries: [`/circles/${circle.ref}/settings`] },
    );

    expect(screen.getByText("USD · US Dollar")).toBeInTheDocument();
    expect(screen.getByText(/Locked once the circle has a transaction/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Circle currency")).not.toBeInTheDocument();
  });

  it("shows currency read-only when the circle has transactions", () => {
    const circle = makeCircleView({
      ref: "trip-c1",
      currency: "CAD",
      currencyLocked: false,
    });
    configureConvex({ members: [ownerMember], circleHasTransactions: true });
    renderCircleRoutes(
      circle,
      <Route path="/circles/:circleRef/settings" element={<CircleSettings />} />,
      { initialEntries: [`/circles/${circle.ref}/settings`] },
    );

    expect(screen.getByText("CAD · Canadian Dollar")).toBeInTheDocument();
    expect(screen.queryByLabelText("Circle currency")).not.toBeInTheDocument();
  });
});
