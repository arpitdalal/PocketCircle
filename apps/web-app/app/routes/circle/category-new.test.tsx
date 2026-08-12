import { COLOR_PALETTE, MUTATION_ERRORS, mutationErrorData } from "@pocketcircle/domain";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { Route } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Circle } from "~/lib/data.js";
import {
  circleLayoutHeadingChrome,
  configureConvex,
  makeCircleView,
  renderCircleRoutes,
} from "~/test/convex-react.js";
import {
  posthogSdk,
  primeAnalyticsForTests,
  resetPostHogBoundary,
} from "~/test/posthog-boundary.js";

/**
 * Behavior test for the new-Category OBJECT route (jsdom, issue #96; revised #138). Doubles
 * ONLY Convex's reactive client and runs the REAL route + REAL `NewCategoryForm` + REAL
 * `~/lib/data.js` hooks under a REAL router, so the create page's optional `type` seed, the
 * in-form Expense/Income toggle, the `returnTo` lifecycle, and the archived-Circle guard are
 * exercised exactly as in the app (ADR 0006).
 */
vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);
vi.mock("posthog-js", async () => (await import("~/test/posthog-mock.js")).posthogModuleMock);
vi.mock("~/lib/env.js", async (importOriginal) =>
  (await import("~/test/posthog-mock.js")).createPosthogEnvMock(importOriginal),
);

import CategoryNew from "./category-new.js";

const REF = "trip-c1";
const createCategory = vi.fn();

// The validated `returnTo` origin a create page is opened with (issue #123): a filtered
// categories list. Close / save / invalid-`type` / archived redirect all land back here.
const LIST_ORIGIN = `/circles/${REF}/categories?type=expense&status=all&q=food`;
const LIST = encodeURIComponent(LIST_ORIGIN);

const ROUTES = (
  <>
    <Route path="circles/:circleRef/categories" element={<div>categories list</div>} />
    <Route path="circles/:circleRef/categories/new" element={<CategoryNew />} />
  </>
);

function setup(opts: { circle?: Partial<Circle>; url?: string } = {}) {
  const circle = makeCircleView(opts.circle);
  createCategory.mockReset();
  createCategory.mockResolvedValue("new-id");
  configureConvex({ createCategory });
  const url = opts.url ?? `/circles/${REF}/categories/new?type=expense&returnTo=${LIST}`;
  return renderCircleRoutes(circle, ROUTES, {
    initialEntries: [url],
    chrome: circleLayoutHeadingChrome(circle),
  });
}

beforeEach(() => {
  primeAnalyticsForTests();
});

afterEach(() => {
  resetPostHogBoundary();
  vi.clearAllMocks();
});

describe("CategoryNew — heading hierarchy", () => {
  it("renders the form title as h2 under the Circle layout h1", () => {
    setup();
    expect(screen.getByRole("heading", { level: 1, name: "Trip" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "New category" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });
});

describe("CategoryNew — render and submit", () => {
  it("renders the expense create form for ?type=expense", () => {
    setup();
    expect(screen.getByLabelText(/New expense category/)).toBeInTheDocument();
  });

  it("pre-selects exactly one palette swatch on open", () => {
    setup();
    const pressed = COLOR_PALETTE.filter(
      (paletteColor) =>
        screen.queryByRole("button", { name: paletteColor.name, pressed: true }) != null,
    );
    expect(pressed).toHaveLength(1);
  });

  it("renders the income create form for ?type=income", () => {
    setup({ url: `/circles/${REF}/categories/new?type=income&returnTo=${LIST}` });
    expect(screen.getByLabelText(/New income category/)).toBeInTheDocument();
  });

  it("submits the entered name, the URL type, and the selected color", async () => {
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText(/New expense category/), "Dining");
    await user.click(screen.getByRole("button", { name: "Teal" }));
    await user.click(screen.getByRole("button", { name: "Add category" }));

    expect(createCategory).toHaveBeenCalledWith({
      circleId: "c1",
      name: "Dining",
      type: "expense",
      color: "teal",
    });
    expect(posthogSdk.capture).toHaveBeenCalledWith("category_created", {
      type: "expense",
      source: "standalone",
    });
  });

  it("deep-links the income type from the URL", async () => {
    const user = userEvent.setup();
    setup({ url: `/circles/${REF}/categories/new?type=income&returnTo=${LIST}` });
    await user.type(screen.getByLabelText(/New income category/), "Bonus");
    await user.click(screen.getByRole("button", { name: "Add category" }));

    expect(createCategory).toHaveBeenCalledWith(expect.objectContaining({ type: "income" }));
  });

  it("disables the submit button until a name is entered", async () => {
    const user = userEvent.setup();
    setup();
    const submit = screen.getByRole("button", { name: "Add category" });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText(/New expense category/), "Dining");
    expect(submit).toBeEnabled();
  });
});

describe("CategoryNew — return navigation", () => {
  it("returns to the returnTo origin after a successful create", async () => {
    const user = userEvent.setup();
    const { location } = setup();
    await user.type(screen.getByLabelText(/New expense category/), "Dining");
    await user.click(screen.getByRole("button", { name: "Add category" }));

    await waitFor(() => expect(createCategory).toHaveBeenCalled());
    await waitFor(() => expect(location()).toBe(LIST_ORIGIN));
  });

  it("returns to the returnTo origin on cancel", async () => {
    const user = userEvent.setup();
    const { location } = setup();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(location()).toBe(LIST_ORIGIN);
  });

  it("falls back to the bare list when there is no returnTo", async () => {
    const user = userEvent.setup();
    const { location } = setup({ url: `/circles/${REF}/categories/new?type=expense` });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(location()).toBe(`/circles/${REF}/categories`);
  });

  it("falls back to the bare list for a tampered (protocol-relative) returnTo — no open redirect", async () => {
    const user = userEvent.setup();
    const { location } = setup({
      url: `/circles/${REF}/categories/new?type=expense&returnTo=${encodeURIComponent("//evil.com")}`,
    });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(location()).toBe(`/circles/${REF}/categories`);
  });
});

describe("CategoryNew — inline errors stay on the page", () => {
  it("surfaces the unique-name rejection inline", async () => {
    const user = userEvent.setup();
    setup();
    createCategory.mockRejectedValueOnce(
      new ConvexError(mutationErrorData(MUTATION_ERRORS.categoryNameDuplicate)),
    );
    await user.type(screen.getByLabelText(/New expense category/), "Groceries");
    await user.click(screen.getByRole("button", { name: "Add category" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      MUTATION_ERRORS.categoryNameDuplicate.message,
    );
  });

  it("shows a generic error for an unexpected failure", async () => {
    const user = userEvent.setup();
    setup();
    createCategory.mockRejectedValueOnce(new Error("Network down"));
    await user.type(screen.getByLabelText(/New expense category/), "Groceries");
    await user.click(screen.getByRole("button", { name: "Add category" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Couldn't create the category/i);
    expect(alert).not.toHaveTextContent(/Network down/);
  });
});

describe("CategoryNew — initial type default (issue #138)", () => {
  it("defaults the toggle to expense (and renders the form) when `type` is missing", async () => {
    const { location } = setup({ url: `/circles/${REF}/categories/new?returnTo=${LIST}` });
    // No eject any more — the in-form toggle starts on Expense and the user picks the type.
    expect(await screen.findByLabelText(/New expense category/)).toBeInTheDocument();
    expect(location()).toBe(`/circles/${REF}/categories/new?returnTo=${LIST}`);
  });

  it("defaults the toggle to expense for an unrecognized `type` (e.g. arriving with type=all)", async () => {
    setup({ url: `/circles/${REF}/categories/new?type=all&returnTo=${LIST}` });
    expect(await screen.findByLabelText(/New expense category/)).toBeInTheDocument();
  });
});

describe("CategoryNew — in-form type toggle (issue #138)", () => {
  it("offers an Expense/Income toggle seeded from the URL type", () => {
    setup({ url: `/circles/${REF}/categories/new?type=income&returnTo=${LIST}` });
    const types = screen.getByRole("group", { name: "Type" });
    expect(
      within(types).getByRole("button", { name: "Income", pressed: true }),
    ).toBeInTheDocument();
    expect(
      within(types).getByRole("button", { name: "Expense", pressed: false }),
    ).toBeInTheDocument();
  });

  it("creates with the toggled type, not the URL's, after flipping it — keeping the typed name", async () => {
    const user = userEvent.setup();
    setup(); // arrives type=expense
    const name = screen.getByLabelText(/New expense category/);
    await user.type(name, "Bonus");

    // Flip to Income: the name field is preserved and only its label re-renders.
    await user.click(
      within(screen.getByRole("group", { name: "Type" })).getByRole("button", { name: "Income" }),
    );
    expect(screen.getByLabelText<HTMLInputElement>(/New income category/).value).toBe("Bonus");

    await user.click(screen.getByRole("button", { name: "Add category" }));
    expect(createCategory).toHaveBeenCalledWith({
      circleId: "c1",
      name: "Bonus",
      type: "income",
      color: expect.any(String),
    });
  });

  it("clears a per-type duplicate-name error when the type toggles (the conflict may not hold)", async () => {
    const user = userEvent.setup();
    setup();
    createCategory.mockRejectedValueOnce(
      new ConvexError(mutationErrorData(MUTATION_ERRORS.categoryNameDuplicate)),
    );
    await user.type(screen.getByLabelText(/New expense category/), "Groceries");
    await user.click(screen.getByRole("button", { name: "Add category" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      MUTATION_ERRORS.categoryNameDuplicate.message,
    );

    await user.click(
      within(screen.getByRole("group", { name: "Type" })).getByRole("button", { name: "Income" }),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("CategoryNew — guards", () => {
  it("redirects an archived Circle to the returnTo origin without showing the form", async () => {
    const { location } = setup({ circle: { status: "archived" } });
    await waitFor(() => expect(location()).toBe(LIST_ORIGIN));
    expect(screen.queryByLabelText(/New expense category/)).not.toBeInTheDocument();
  });
});
