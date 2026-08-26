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
  deferredValue,
  makeCircleView,
  renderCircleRoutes,
} from "~/test/convex-react.js";
import {
  posthogSdk,
  primeAnalyticsForTests,
  resetPostHogBoundary,
} from "~/test/posthog-boundary.js";

/**
 * Behavior test for the new-Category OBJECT route (jsdom, issue #96; revised #138;
 * TanStack Form #305). Doubles ONLY Convex's reactive client and PostHog, and runs
 * the REAL route + REAL `NewCategoryForm` + REAL domain schema + REAL TanStack
 * wiring + REAL `~/lib/data.js` hooks under a REAL router, so the create page's
 * optional `type` seed, the in-form Expense/Income toggle, validation timing,
 * `returnTo` lifecycle, and the archived-Circle guard are exercised exactly as in
 * the app (ADR 0006/0020).
 */
vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);
vi.mock("posthog-js", async () => (await import("~/test/posthog-mock.js")).posthogModuleMock);

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

function pressedPaletteColors() {
  return COLOR_PALETTE.filter(
    (paletteColor) =>
      screen.queryByRole("button", { name: paletteColor.name, pressed: true }) != null,
  );
}

function requirePressedPaletteColor() {
  const pressed = pressedPaletteColors();
  expect(pressed).toHaveLength(1);
  const color = pressed[0];
  if (!color) {
    throw new Error("expected one pressed palette color");
  }
  return color;
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

  it("names the form landmark and accessible field controls", () => {
    setup();
    expect(screen.getByRole("form", { name: "New category" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Type" })).toBeInTheDocument();
    expect(screen.getByLabelText(/New expense category/)).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Color" })).toBeInTheDocument();
  });
});

describe("CategoryNew — initial type seed", () => {
  it("renders the expense create form for ?type=expense", () => {
    setup();
    expect(screen.getByLabelText(/New expense category/)).toBeInTheDocument();
    expect(
      within(screen.getByRole("group", { name: "Type" })).getByRole("button", {
        name: "Expense",
        pressed: true,
      }),
    ).toBeInTheDocument();
  });

  it("renders the income create form for ?type=income", () => {
    setup({ url: `/circles/${REF}/categories/new?type=income&returnTo=${LIST}` });
    expect(screen.getByLabelText(/New income category/)).toBeInTheDocument();
    expect(
      within(screen.getByRole("group", { name: "Type" })).getByRole("button", {
        name: "Income",
        pressed: true,
      }),
    ).toBeInTheDocument();
  });

  it("defaults the toggle to expense when `type` is missing", async () => {
    const { location } = setup({ url: `/circles/${REF}/categories/new?returnTo=${LIST}` });
    expect(await screen.findByLabelText(/New expense category/)).toBeInTheDocument();
    expect(location()).toBe(`/circles/${REF}/categories/new?returnTo=${LIST}`);
  });

  it("defaults the toggle to expense for an unrecognized `type` (e.g. type=all)", async () => {
    setup({ url: `/circles/${REF}/categories/new?type=all&returnTo=${LIST}` });
    expect(await screen.findByLabelText(/New expense category/)).toBeInTheDocument();
  });
});

describe("CategoryNew — color initialization", () => {
  it("pre-selects exactly one palette swatch on open", () => {
    setup();
    requirePressedPaletteColor();
  });

  it("keeps the initial color stable across field-driven rerenders", async () => {
    const user = userEvent.setup();
    setup();
    const initial = requirePressedPaletteColor();
    await user.type(screen.getByLabelText(/New expense category/), "Dining");
    expect(screen.getByRole("button", { name: initial.name, pressed: true })).toBeInTheDocument();
  });
});

describe("CategoryNew — type toggle", () => {
  it("creates with the toggled type, keeping Name and Color", async () => {
    const user = userEvent.setup();
    setup();
    const initialColor = requirePressedPaletteColor();
    await user.type(screen.getByLabelText(/New expense category/), "Bonus");

    await user.click(
      within(screen.getByRole("group", { name: "Type" })).getByRole("button", { name: "Income" }),
    );
    expect(screen.getByLabelText<HTMLInputElement>(/New income category/).value).toBe("Bonus");
    expect(
      screen.getByRole("button", { name: initialColor.name, pressed: true }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add category" }));
    expect(createCategory).toHaveBeenCalledWith({
      circleId: "c1",
      name: "Bonus",
      type: "income",
      color: initialColor.id,
    });
  });

  it("clears a per-type duplicate-name error when the type toggles", async () => {
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

describe("CategoryNew — validation timing (ADR 0020)", () => {
  it("reveals Name is required on an invalid submit attempt and does not mutate", async () => {
    const user = userEvent.setup();
    setup();
    const submit = screen.getByRole("button", { name: "Add category" });
    expect(submit).toBeEnabled();
    await user.click(submit);

    expect(await screen.findByText("Name is required")).toBeInTheDocument();
    expect(createCategory).not.toHaveBeenCalled();
    expect(posthogSdk.capture).not.toHaveBeenCalled();
  });

  it("stays quiet when Name is focused and blurred without typing", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByLabelText(/New expense category/));
    await user.tab();
    expect(screen.queryByText("Name is required")).not.toBeInTheDocument();
  });

  it("shows a Name field error on blur once edited and left invalid", async () => {
    const user = userEvent.setup();
    setup();
    const name = screen.getByLabelText(/New expense category/);
    await user.type(name, "a");
    await user.clear(name);
    await user.tab();
    expect(await screen.findByText("Name is required")).toBeInTheDocument();
  });

  it("clears a revealed Name error live once the value becomes valid, then submits on Enter", async () => {
    const user = userEvent.setup();
    setup();
    const name = screen.getByLabelText(/New expense category/);
    await user.type(name, "a");
    await user.clear(name);
    await user.tab();
    expect(await screen.findByText("Name is required")).toBeInTheDocument();

    await user.type(name, "Dining");
    expect(screen.queryByText("Name is required")).not.toBeInTheDocument();
    await user.keyboard("{Enter}");

    await waitFor(() => expect(createCategory).toHaveBeenCalledTimes(1));
    expect(createCategory).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Dining", type: "expense" }),
    );
  });
});

describe("CategoryNew — submit", () => {
  it("submits parsed Type, trimmed Name, and selected Color", async () => {
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText(/New expense category/), "  Dining  ");
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
    expect(posthogSdk.capture).toHaveBeenCalledTimes(1);
  });

  it("deep-links the income type from the URL into the mutation", async () => {
    const user = userEvent.setup();
    setup({ url: `/circles/${REF}/categories/new?type=income&returnTo=${LIST}` });
    await user.type(screen.getByLabelText(/New income category/), "Bonus");
    await user.click(screen.getByRole("button", { name: "Add category" }));

    expect(createCategory).toHaveBeenCalledWith(expect.objectContaining({ type: "income" }));
  });

  it("submits on Enter from the Name field", async () => {
    const user = userEvent.setup();
    setup();
    const name = screen.getByLabelText(/New expense category/);
    await user.type(name, "Dining{Enter}");

    await waitFor(() => expect(createCategory).toHaveBeenCalledTimes(1));
    expect(createCategory).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Dining", type: "expense" }),
    );
  });

  it("disables actions while the create is in flight (guards double-submit)", async () => {
    const user = userEvent.setup();
    const pending = deferredValue<string>();
    setup();
    createCategory.mockImplementation(() => pending.promise);

    await user.type(screen.getByLabelText(/New expense category/), "Dining");
    await user.click(screen.getByRole("button", { name: "Add category" }));

    const busy = await screen.findByRole("button", { name: "Adding…" });
    expect(busy).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(createCategory).toHaveBeenCalledTimes(1);

    await user.click(busy);
    expect(createCategory).toHaveBeenCalledTimes(1);

    pending.resolve("new-id");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Adding…" })).not.toBeInTheDocument(),
    );
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

describe("CategoryNew — mutation errors", () => {
  it("surfaces the unique-name rejection inline, preserves the draft, and unlocks retry", async () => {
    const user = userEvent.setup();
    setup();
    createCategory.mockRejectedValueOnce(
      new ConvexError(mutationErrorData(MUTATION_ERRORS.categoryNameDuplicate)),
    );
    await user.type(screen.getByLabelText(/New expense category/), "Groceries");
    await user.click(screen.getByRole("button", { name: "Teal" }));
    await user.click(screen.getByRole("button", { name: "Add category" }));

    const name = screen.getByLabelText(/New expense category/);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      MUTATION_ERRORS.categoryNameDuplicate.message,
    );
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAttribute("aria-describedby", "category-error");
    expect(name).toHaveValue("Groceries");
    expect(screen.getByRole("button", { name: "Teal", pressed: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add category" })).toBeEnabled();
    expect(posthogSdk.capture).not.toHaveBeenCalled();
  });

  it("shows a generic error for an unexpected failure without leaking internals", async () => {
    const user = userEvent.setup();
    setup();
    createCategory.mockRejectedValueOnce(new Error("Network down"));
    await user.type(screen.getByLabelText(/New expense category/), "Groceries");
    await user.click(screen.getByRole("button", { name: "Teal" }));
    await user.click(screen.getByRole("button", { name: "Add category" }));

    const name = screen.getByLabelText(/New expense category/);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Couldn't create the category/i);
    expect(alert).not.toHaveTextContent(/Network down/);
    expect(alert).toHaveAttribute("id", "category-error");
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAttribute("aria-describedby", "category-error");
    expect(name).toHaveValue("Groceries");
    expect(screen.getByRole("button", { name: "Teal", pressed: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add category" })).toBeEnabled();
    expect(posthogSdk.capture).not.toHaveBeenCalled();
  });

  it("clears a stale mutation error when Name changes and allows a successful retry", async () => {
    const user = userEvent.setup();
    setup();
    createCategory
      .mockRejectedValueOnce(
        new ConvexError(mutationErrorData(MUTATION_ERRORS.categoryNameDuplicate)),
      )
      .mockResolvedValueOnce("new-id");

    await user.type(screen.getByLabelText(/New expense category/), "Groceries");
    await user.click(screen.getByRole("button", { name: "Add category" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      MUTATION_ERRORS.categoryNameDuplicate.message,
    );

    await user.type(screen.getByLabelText(/New expense category/), " weekly");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add category" }));
    await waitFor(() =>
      expect(createCategory).toHaveBeenLastCalledWith(
        expect.objectContaining({ name: "Groceries weekly" }),
      ),
    );
    expect(posthogSdk.capture).toHaveBeenCalledWith("category_created", {
      type: "expense",
      source: "standalone",
    });
  });
});

describe("CategoryNew — guards", () => {
  it("redirects an archived Circle to the returnTo origin without showing the form", async () => {
    const { location } = setup({ circle: { status: "archived" } });
    await waitFor(() => expect(location()).toBe(LIST_ORIGIN));
    expect(screen.queryByLabelText(/New expense category/)).not.toBeInTheDocument();
  });
});
