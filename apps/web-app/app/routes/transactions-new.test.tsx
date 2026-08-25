import { MUTATION_ERRORS, mutationErrorData, toPlainDate } from "@pocketcircle/domain";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import type { ReactNode } from "react";
import { Route } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Circle } from "~/lib/data.js";
import { GLOBAL_ADD_PATH } from "~/lib/global-add-url.js";
import { RETURN_TO_PARAM } from "~/lib/return-to-url.js";
import {
  configureConvex,
  makeCategoryView,
  makeCircleView,
  makeMemberView,
  pickTransactionFormCategory,
  renderRoutes,
  testId,
} from "~/test/convex-react.js";
import { installReducedMotionPreference } from "~/test/match-media.js";
import {
  posthogSdk,
  primeAnalyticsForTests,
  resetPostHogBoundary,
} from "~/test/posthog-boundary.js";

vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);
vi.mock("posthog-js", async () => (await import("~/test/posthog-mock.js")).posthogModuleMock);

/**
 * The primary Global Add route suite (issue #298). Runs the REAL Router, the
 * REAL route adapter, the shared Transaction form controller + body, and the
 * real `~/lib/data` hooks under a real MemoryRouter; only the Convex reactive
 * client and PostHog are doubled at their vendor boundaries. Field-level rules
 * live in `transaction-form.test.tsx`; pure URL/reset rules in their own unit
 * suites — this file asserts the ROUTE: canonicalization, progressive reveal,
 * confirmations, browser navigation, reactive invalidation, resets, warnings,
 * and navigation outcomes.
 */

import TransactionsNew from "./transactions-new.js";

const HOME_ORIGIN = "/?currency=CAD&range=3";

const CIRCLE_A = makeCircleView({
  id: testId<Circle["id"]>("j57k2a"),
  ref: "trip-j57k2a",
  name: "Trip",
  currency: "USD",
});
const CIRCLE_B = makeCircleView({
  id: testId<Circle["id"]>("m93p4b"),
  ref: "cabin-m93p4b",
  name: "Cabin",
  currency: "CAD",
  kind: "regular",
});

import type { Mock } from "vitest";

let createTransaction: Mock;

function baseState(overrides?: { circles?: Circle[] | null }) {
  return {
    circles: overrides?.circles ?? [CIRCLE_A, CIRCLE_B],
    categories: [makeCategoryView()],
    members: [
      makeMemberView({ isSelf: true }),
      makeMemberView({ id: testId("m2"), displayName: "Jamie", isSelf: false }),
    ],
    createTransaction,
  };
}

const ROUTES: ReactNode = (
  <>
    <Route path="/" element={<div>home</div>} />
    <Route path={GLOBAL_ADD_PATH} element={<TransactionsNew />} />
    <Route path="circles/:circleRef/transactions/:transactionRef" element={<div>detail</div>} />
  </>
);

function setup(opts?: {
  url?: string;
  circles?: Circle[] | null;
  /** Extra history entries seeded BEFORE the test's URL (for Back/Forward). */
  precedingEntries?: string[];
}) {
  createTransaction.mockReset();
  createTransaction.mockResolvedValue("new-txn");
  configureConvex(baseState(opts));
  return renderRoutes(ROUTES, {
    initialEntries: [
      ...(opts?.precedingEntries ?? []),
      opts?.url ??
        `${GLOBAL_ADD_PATH}?type=expense&circle=${encodeURIComponent(CIRCLE_A.ref)}&returnTo=${encodeURIComponent(HOME_ORIGIN)}`,
    ],
  });
}

/** Fills and submits a valid expense draft against the currently applied Circle. */
async function fillAndSubmit(
  user: ReturnType<typeof userEvent.setup>,
  title = "Lunch",
  amount = "12.50",
) {
  const form = screen.getByRole("form", { name: /add expense/i });
  await user.type(within(form).getByLabelText("Title"), title);
  await user.type(within(form).getByLabelText(/Amount/), amount);
  await pickTransactionFormCategory(user, form, "Groceries");
  await user.click(within(form).getByRole("button", { name: "Add expense" }));
}

beforeEach(() => {
  primeAnalyticsForTests();
  createTransaction = vi.fn();
});

afterEach(() => {
  resetPostHogBoundary();
  vi.clearAllMocks();
});

describe("TransactionsNew — canonicalization", () => {
  it("normalizes a missing type to expense with replace navigation and no toast", async () => {
    const view = setup({ url: `${GLOBAL_ADD_PATH}?returnTo=${encodeURIComponent(HOME_ORIGIN)}` });
    await waitFor(() =>
      expect(view.location()).toBe(
        `${GLOBAL_ADD_PATH}?type=expense&returnTo=${encodeURIComponent(HOME_ORIGIN)}`,
      ),
    );
    expect(screen.getByRole("button", { name: "Expense", pressed: true })).toBeInTheDocument();
  });

  it("normalizes a malformed type to expense, dropping the bad value", async () => {
    const view = setup({ url: `${GLOBAL_ADD_PATH}?type=nonsense` });
    await waitFor(() => expect(view.location()).toBe(`${GLOBAL_ADD_PATH}?type=expense`));
    expect(screen.getByRole("button", { name: "Expense", pressed: true })).toBeInTheDocument();
  });

  it("removes unknown and duplicate parameters during canonicalization", async () => {
    const view = setup({
      url: `${GLOBAL_ADD_PATH}?type=income&type=expense&month=2026-05&utm=x&circle=${CIRCLE_A.ref}`,
    });
    await waitFor(() =>
      expect(view.location()).toBe(
        `${GLOBAL_ADD_PATH}?type=income&circle=${encodeURIComponent(CIRCLE_A.ref)}`,
      ),
    );
  });
});

describe("TransactionsNew — initial states", () => {
  it("renders Step 1 with Circle and Type together and the destination placeholder", () => {
    setup({ url: GLOBAL_ADD_PATH });
    expect(screen.getByRole("heading", { level: 1, name: "Add transaction" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Circle" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByText("Choose a Circle to continue")).toBeInTheDocument();
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
  });

  it("shows Loading Circles while destinations resolve", () => {
    configureConvex({ ...baseState(), circles: undefined, createTransaction });
    renderRoutes(ROUTES, { initialEntries: [GLOBAL_ADD_PATH] });
    expect(screen.getByText("Loading Circles…")).toBeInTheDocument();
  });

  it("keeps portable fields usable while a deep-linked Circle resolves", () => {
    configureConvex({ ...baseState(), circles: undefined, createTransaction });
    renderRoutes(ROUTES, {
      initialEntries: [`${GLOBAL_ADD_PATH}?type=expense&circle=${CIRCLE_A.ref}`],
    });
    expect(screen.getByRole("form", { name: /add expense/i })).toBeInTheDocument();
    expect(within(screen.getByRole("form")).getByLabelText("Title")).toBeEnabled();
    expect(within(screen.getByRole("form")).getByLabelText(/Amount/)).toBeDisabled();
  });

  it("opens the form when a deep-linked Circle is eligible", async () => {
    setup({ url: `${GLOBAL_ADD_PATH}?type=expense&circle=${CIRCLE_B.ref}` });
    const form = await screen.findByRole("form", { name: /add expense/i });
    await waitFor(() => expect(within(form).getByLabelText(/Amount/)).toBeEnabled());
    expect(within(form).getByLabelText(/Amount/)).toHaveAccessibleName(/CAD/);
  });

  it("clears an invalid initial Circle with generic feedback and keeps ordinary Global Add", async () => {
    const view = setup({
      url: `${GLOBAL_ADD_PATH}?type=expense&circle=ghost-zz`,
      circles: [CIRCLE_A],
    });
    await waitFor(() => expect(view.location()).toBe(`${GLOBAL_ADD_PATH}?type=expense`));
    expect(await screen.findByText("This circle isn't available.")).toBeInTheDocument();
    // Back to the ordinary unselected page.
    expect(screen.getByText("Choose a Circle to continue")).toBeInTheDocument();
  });

  it("canonicalizes a stale Circle slug to the resolved ref with replace navigation", async () => {
    const view = setup({
      url: `${GLOBAL_ADD_PATH}?type=expense&circle=old-slug-${CIRCLE_A.id}&returnTo=${encodeURIComponent(HOME_ORIGIN)}`,
    });
    await waitFor(() =>
      expect(view.location()).toBe(
        `${GLOBAL_ADD_PATH}?type=expense&circle=${encodeURIComponent(CIRCLE_A.ref)}&returnTo=${encodeURIComponent(HOME_ORIGIN)}`,
      ),
    );
    expect(await screen.findByRole("form", { name: /add expense/i })).toBeInTheDocument();
  });

  it("offers only active, Setup-complete Circles in the picker", () => {
    setup({
      circles: [
        CIRCLE_A,
        CIRCLE_B,
        makeCircleView({ id: testId("cz"), ref: "draft-cz", setupComplete: false }),
        makeCircleView({ id: testId("cy"), ref: "old-cy", status: "archived" }),
      ],
    });
    const options = within(screen.getByRole("combobox", { name: "Circle" }))
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(options).toEqual(["Choose a Circle", "Trip · USD", "Cabin · CAD"]);
  });

  it("guides toward creating a Circle when no eligible destinations exist", () => {
    setup({ circles: [] });
    expect(screen.getByText(/Create a Circle or finish setup first/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create circle" }).getAttribute("href")).toContain(
      "/circles/new",
    );
  });
});

describe("TransactionsNew — progressive reveal, focus, and scroll", () => {
  it("reveals the shared form on first Circle selection without scroll-jacking on mount", async () => {
    const user = userEvent.setup();
    const view = setup({ url: GLOBAL_ADD_PATH });
    expect(screen.queryByRole("form")).not.toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "Circle" }), CIRCLE_A.id);

    expect(await screen.findByRole("form", { name: /add expense/i })).toBeInTheDocument();
    await waitFor(() =>
      expect(view.location()).toBe(
        `${GLOBAL_ADD_PATH}?type=expense&circle=${encodeURIComponent(CIRCLE_A.ref)}`,
      ),
    );
  });

  it("scrolls Step 2 to the top, focuses Title with preventScroll, and selects preserved text", async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    const focusSpy = vi.spyOn(HTMLElement.prototype, "focus");
    Element.prototype.scrollIntoView = scrollIntoView;
    setup({ url: `${GLOBAL_ADD_PATH}?type=expense&circle=${CIRCLE_A.ref}` });
    const form = await screen.findByRole("form", { name: /add expense/i });
    await waitFor(() => expect(within(form).getByLabelText(/Amount/)).toBeEnabled());
    await user.type(within(form).getByLabelText("Title"), "Hotel deposit");
    await user.type(within(form).getByLabelText(/Amount/), "99");
    focusSpy.mockClear();

    await user.selectOptions(screen.getByRole("combobox", { name: "Circle" }), CIRCLE_B.id);
    await user.click(await screen.findByRole("button", { name: "Change Circle" }));

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(scrollIntoView.mock.calls[0]?.[0]).toMatchObject({ block: "start" });
    const nextForm = screen.getByRole("form", { name: /add expense/i });
    const title = within(nextForm).getByLabelText("Title");
    await waitFor(() => expect(title).toHaveFocus());
    expect(focusSpy).toHaveBeenCalledWith(expect.objectContaining({ preventScroll: true }));
    // Preserved portable text stays selected for immediate retyping.
    expect(title).toHaveValue("Hotel deposit");
    expect(title).toBeInstanceOf(HTMLInputElement);
    if (!(title instanceof HTMLInputElement)) {
      throw new Error("expected Title to be an input");
    }
    await waitFor(() => expect(title.selectionStart).toBe(0));
    expect(title.selectionEnd).toBe("Hotel deposit".length);
    Element.prototype.scrollIntoView = vi.fn();
    focusSpy.mockRestore();
  });

  it("falls back to instant scrolling under prefers-reduced-motion", async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const media = installReducedMotionPreference(true);

    setup({ url: `${GLOBAL_ADD_PATH}?circle=${CIRCLE_A.ref}` });
    await screen.findByRole("form");
    await user.selectOptions(screen.getByRole("combobox", { name: "Circle" }), CIRCLE_B.id);

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(scrollIntoView.mock.calls.at(-1)?.[0]).toMatchObject({ behavior: "auto" });
    media.restore();
    Element.prototype.scrollIntoView = vi.fn();
  });
});

describe("TransactionsNew — Circle switch confirmations", () => {
  it("switches immediately when the scoped draft is empty", async () => {
    const user = userEvent.setup();
    const view = setup({ url: `${GLOBAL_ADD_PATH}?type=expense&circle=${CIRCLE_A.ref}` });
    await screen.findByRole("form");
    await user.type(within(screen.getByRole("form")).getByLabelText("Title"), "Notebook");

    await user.selectOptions(screen.getByRole("combobox", { name: "Circle" }), CIRCLE_B.id);

    await waitFor(() =>
      expect(view.location()).toBe(
        `${GLOBAL_ADD_PATH}?type=expense&circle=${encodeURIComponent(CIRCLE_B.ref)}`,
      ),
    );
    // Portable value survived the immediate switch.
    expect(within(screen.getByRole("form")).getByLabelText("Title")).toHaveValue("Notebook");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("confirms only when scoped work exists; Cancel preserves the previous Circle, URL, and draft", async () => {
    const user = userEvent.setup();
    const view = setup({ url: `${GLOBAL_ADD_PATH}?type=expense&circle=${CIRCLE_A.ref}` });
    const form = await screen.findByRole("form");
    await waitFor(() => expect(within(form).getByLabelText(/Amount/)).toBeEnabled());
    await user.type(within(form).getByLabelText("Title"), "Keep me");
    await user.type(within(form).getByLabelText(/Amount/), "42.00");

    await user.selectOptions(screen.getByRole("combobox", { name: "Circle" }), CIRCLE_B.id);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Keep current" }));

    // Lossless cancel: URL, Circle selection, and the complete draft remain.
    await waitFor(() =>
      expect(view.location()).toBe(
        `${GLOBAL_ADD_PATH}?type=expense&circle=${encodeURIComponent(CIRCLE_A.ref)}`,
      ),
    );
    const restored = screen.getByRole("form");
    expect(within(restored).getByLabelText("Title")).toHaveValue("Keep me");
    expect(within(restored).getByLabelText(/Amount/)).toHaveValue("42.00");
    expect(view.location()).toContain(encodeURIComponent(CIRCLE_A.ref));
  });

  it("applies a confirmed switch: clears Amount/Categories/Paid By, preserves portable fields, defaults Paid By to self", async () => {
    const user = userEvent.setup();
    setup({ url: `${GLOBAL_ADD_PATH}?type=expense&circle=${CIRCLE_A.ref}` });
    const form = await screen.findByRole("form");
    await waitFor(() => expect(within(form).getByLabelText(/Amount/)).toBeEnabled());
    await user.type(within(form).getByLabelText("Title"), "Dinner");
    await user.type(within(form).getByLabelText(/Amount/), "55");
    await pickTransactionFormCategory(user, form, "Groceries");
    await user.selectOptions(within(form).getByLabelText("Paid by"), testId("m2"));

    await user.selectOptions(screen.getByRole("combobox", { name: "Circle" }), CIRCLE_B.id);
    await user.click(await screen.findByRole("button", { name: "Change Circle" }));

    const nextForm = screen.getByRole("form");
    expect(within(nextForm).getByLabelText("Title")).toHaveValue("Dinner");
    await waitFor(() => {
      expect(within(nextForm).getByLabelText(/Amount/)).toHaveValue("");
      expect(within(nextForm).queryByText("Groceries")).not.toBeInTheDocument();
    });
    // Paid By displays the current User in the destination Circle.
    const paidBy = within(nextForm).getByLabelText("Paid by");
    expect(paidBy).toBeInstanceOf(HTMLSelectElement);
    if (!(paidBy instanceof HTMLSelectElement)) {
      throw new Error("expected Paid by to be a select");
    }
    await waitFor(() => expect(paidBy.selectedOptions[0]?.textContent).toMatch(/\(You\)/));
    // No automatic-reset warnings for a voluntary confirmed switch.
    expect(within(nextForm).queryByText(/was cleared because/i)).not.toBeInTheDocument();
  });

  it("keeps Type, Note, and Transaction Date across a confirmed switch and updates the currency label", async () => {
    const user = userEvent.setup();
    setup({ url: `${GLOBAL_ADD_PATH}?type=income&circle=${CIRCLE_A.ref}` });
    const form = await screen.findByRole("form", { name: /add income/i });
    await waitFor(() => expect(within(form).getByLabelText(/Amount/)).toBeEnabled());
    await user.type(within(form).getByLabelText("Title"), "Refund");
    await user.type(within(form).getByLabelText(/Note/), "from vendor");
    await user.type(within(form).getByLabelText(/Amount/), "10");

    await user.selectOptions(screen.getByRole("combobox", { name: "Circle" }), CIRCLE_B.id);
    await user.click(await screen.findByRole("button", { name: "Change Circle" }));

    const nextForm = screen.getByRole("form", { name: /add income/i });
    expect(within(nextForm).getByLabelText(/Note/)).toHaveValue("from vendor");
    expect(within(nextForm).getByLabelText(/Amount/)).toHaveAccessibleName(/CAD/);
  });
});

describe("TransactionsNew — Type transitions", () => {
  it("applies an empty Type change immediately and preserves portable values", async () => {
    const user = userEvent.setup();
    const view = setup({ url: `${GLOBAL_ADD_PATH}?type=expense&circle=${CIRCLE_A.ref}` });
    const form = await screen.findByRole("form", { name: /add expense/i });
    await user.type(within(form).getByLabelText("Title"), "Same work");

    await user.click(screen.getByRole("button", { name: "Income" }));

    expect(await screen.findByRole("form", { name: /add income/i })).toBeInTheDocument();
    await waitFor(() =>
      expect(view.location()).toBe(
        `${GLOBAL_ADD_PATH}?type=income&circle=${encodeURIComponent(CIRCLE_A.ref)}`,
      ),
    );
    expect(within(screen.getByRole("form")).getByLabelText("Title")).toHaveValue("Same work");
  });

  it("confirms a Type change with selected Categories; Cancel keeps them", async () => {
    const user = userEvent.setup();
    setup({ url: `${GLOBAL_ADD_PATH}?type=expense&circle=${CIRCLE_A.ref}` });
    const form = await screen.findByRole("form");
    await pickTransactionFormCategory(user, form, "Groceries");

    await user.click(screen.getByRole("button", { name: "Income" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/Changing Type clears selected Categories/);
    await user.click(within(dialog).getByRole("button", { name: "Keep current" }));

    expect(await screen.findByRole("form", { name: /add expense/i })).toBeInTheDocument();
    expect(screen.getByRole("form")).toHaveTextContent("Groceries");
  });

  it("clears Categories after an accepted Type change while keeping other values", async () => {
    const user = userEvent.setup();
    setup({ url: `${GLOBAL_ADD_PATH}?type=expense&circle=${CIRCLE_A.ref}` });
    const form = await screen.findByRole("form");
    await user.type(within(form).getByLabelText("Title"), "Mixed bag");
    await user.type(within(form).getByLabelText(/Amount/), "7");
    await pickTransactionFormCategory(user, form, "Groceries");

    await user.click(screen.getByRole("button", { name: "Income" }));
    await user.click(await screen.findByRole("button", { name: "Change type" }));

    const nextForm = await screen.findByRole("form", { name: /add income/i });
    expect(within(nextForm).getByLabelText("Title")).toHaveValue("Mixed bag");
    expect(within(nextForm).getByLabelText(/Amount/)).toHaveValue("7.00");
    expect(within(nextForm).queryByText("Groceries")).not.toBeInTheDocument();
  });
});

describe("TransactionsNew — browser navigation", () => {
  it("applies Back/Forward Circle changes with the same confirmation rules", async () => {
    const user = userEvent.setup();
    const view = setup({
      url: `${GLOBAL_ADD_PATH}?type=expense&circle=${CIRCLE_A.ref}`,
      precedingEntries: [`${GLOBAL_ADD_PATH}?type=expense`],
    });
    const form = await screen.findByRole("form");
    await waitFor(() => expect(within(form).getByLabelText(/Amount/)).toBeEnabled());
    await user.type(within(form).getByLabelText(/Amount/), "31");

    // Simulate browser Back to the bare (unselected) URL.
    await view.navigate(-1);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/Change Circle\?/);

    // Cancel restores the applied URL and full draft.
    await user.click(within(dialog).getByRole("button", { name: "Keep current" }));
    await waitFor(() =>
      expect(view.location()).toBe(
        `${GLOBAL_ADD_PATH}?type=expense&circle=${encodeURIComponent(CIRCLE_A.ref)}`,
      ),
    );
    expect(within(screen.getByRole("form")).getByLabelText(/Amount/)).toHaveValue("31.00");
  });

  it("removes the Circle without confirmation when the draft is empty on Back", async () => {
    const view = setup({
      url: `${GLOBAL_ADD_PATH}?type=expense&circle=${CIRCLE_A.ref}`,
      precedingEntries: [`${GLOBAL_ADD_PATH}?type=expense`],
    });
    await screen.findByRole("form");
    await view.navigate(-1);
    await waitFor(() => expect(view.location()).toBe(`${GLOBAL_ADD_PATH}?type=expense`));
  });

  it("applies an accepted Back-removal and a Forward re-selection by the transition rules", async () => {
    const user = userEvent.setup();
    const view = setup({
      url: `${GLOBAL_ADD_PATH}?type=expense&circle=${CIRCLE_A.ref}`,
      precedingEntries: [`${GLOBAL_ADD_PATH}?type=expense`],
    });
    const form = await screen.findByRole("form");
    await waitFor(() => expect(within(form).getByLabelText(/Amount/)).toBeEnabled());
    await user.type(within(form).getByLabelText("Title"), "Survives");
    await user.type(within(form).getByLabelText(/Amount/), "5");

    await view.navigate(-1);
    await user.click(await screen.findByRole("button", { name: "Change Circle" }));

    // Removal applied: scoped values cleared and controls disabled while the
    // portable Title survives invisibly in the still-mounted form.
    await waitFor(() => expect(view.location()).toBe(`${GLOBAL_ADD_PATH}?type=expense`));
    const bareForm = screen.getByRole("form");
    expect(within(bareForm).getByLabelText(/Amount/)).toBeDisabled();
    expect(within(bareForm).getByLabelText(/Amount/)).toHaveValue("");

    // Forward returns to Circle A; the empty draft re-selects immediately.
    await view.navigate(1);
    await waitFor(() => {
      expect(view.location()).toContain(encodeURIComponent(CIRCLE_A.ref));
      expect(within(screen.getByRole("form")).getByLabelText(/Amount/)).toBeEnabled();
    });
    expect(within(screen.getByRole("form")).getByLabelText("Title")).toHaveValue("Survives");
  });

  it("lands an unresolvable switch on the settled URL with the restore toast", async () => {
    const view = setup({ url: `${GLOBAL_ADD_PATH}?type=expense&circle=${CIRCLE_A.ref}` });
    await screen.findByRole("form");

    // Jump straight to a circle id that is not in the eligible list.
    view.navigate(
      `${GLOBAL_ADD_PATH}?type=expense&circle=ghost-zz&returnTo=${encodeURIComponent(HOME_ORIGIN)}`,
    );
    expect(await screen.findByText(SWITCH_RESTORED_TOAST_TEXT)).toBeInTheDocument();
    await waitFor(() =>
      expect(view.location()).toBe(
        `${GLOBAL_ADD_PATH}?type=expense&circle=${encodeURIComponent(CIRCLE_A.ref)}&returnTo=${encodeURIComponent(HOME_ORIGIN)}`,
      ),
    );
  });
});

const SWITCH_RESTORED_TOAST_TEXT = "Couldn't switch Circles. Your previous values were restored.";

describe("TransactionsNew — reactive invalidation and resets", () => {
  function rerenderWith(
    view: ReturnType<typeof renderRoutes>,
    overrides?: { circles?: Circle[] | null },
  ) {
    configureConvex({ ...baseState(overrides), createTransaction });
    view.rerenderRoutes(ROUTES);
  }

  it("removes a Circle that loses eligibility without confirmation, clearing scoped values with warnings", async () => {
    const user = userEvent.setup();
    const view = setup({
      url: `${GLOBAL_ADD_PATH}?type=expense&circle=${encodeURIComponent(CIRCLE_A.ref)}&returnTo=${encodeURIComponent(HOME_ORIGIN)}`,
    });
    const form = await screen.findByRole("form");
    await waitFor(() => expect(within(form).getByLabelText(/Amount/)).toBeEnabled());
    await user.type(within(form).getByLabelText("Title"), "Still mine");
    await user.type(within(form).getByLabelText(/Note/), "portable");
    await user.type(within(form).getByLabelText(/Amount/), "18");
    await pickTransactionFormCategory(user, form, "Groceries");

    // The applied Circle is archived mid-session.
    rerenderWith(view, {
      circles: [{ ...CIRCLE_A, status: "archived" }, CIRCLE_B],
    });

    expect(
      await screen.findByText(
        /That Circle is no longer available\. Circle-specific fields were cleared\./,
      ),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(view.location()).toBe(
        `${GLOBAL_ADD_PATH}?type=expense&returnTo=${encodeURIComponent(HOME_ORIGIN)}`,
      ),
    );
    const invalidated = screen.getByRole("form");
    expect(within(invalidated).getByLabelText("Title")).toHaveValue("Still mine");
    expect(within(invalidated).getByLabelText(/Note/)).toHaveValue("portable");
    expect(within(invalidated).getByLabelText(/Amount/)).toHaveValue("");
    // Persistent field-specific warnings mark every affected field.
    expect(
      within(invalidated).getByText(
        "Amount was cleared because the Circle is no longer available.",
      ),
    ).toBeInTheDocument();
    expect(
      within(invalidated).getByText(
        "Categories were cleared because the Circle is no longer available.",
      ),
    ).toBeInTheDocument();
    expect(
      within(invalidated).getByText(
        "Paid By was cleared because the Circle is no longer available.",
      ),
    ).toBeInTheDocument();
  });

  it("clears only Amount when the destination Currency changes, with its toast and warning", async () => {
    const user = userEvent.setup();
    const view = setup({ url: `${GLOBAL_ADD_PATH}?circle=${CIRCLE_A.ref}` });
    const form = await screen.findByRole("form");
    await waitFor(() => expect(within(form).getByLabelText(/Amount/)).toBeEnabled());
    await user.type(within(form).getByLabelText(/Amount/), "20");

    rerenderWith(view, { circles: [{ ...CIRCLE_A, currency: "EUR" }, CIRCLE_B] });

    expect(
      await screen.findByText("The Circle's currency changed. Amount was cleared."),
    ).toBeInTheDocument();
    expect(within(screen.getByRole("form")).getByLabelText(/Amount/)).toHaveValue("");
    expect(
      within(screen.getByRole("form")).getByText(
        "Amount was cleared because the Circle's currency changed.",
      ),
    ).toBeInTheDocument();
    // The Circle itself is kept — no unavailable messaging.
    expect(screen.queryByText(/no longer available/)).not.toBeInTheDocument();
    expect(view.location()).toContain(encodeURIComponent(CIRCLE_A.ref));
  });

  it("clears each warning when the User changes its field", async () => {
    const user = userEvent.setup();
    const view = setup({ url: `${GLOBAL_ADD_PATH}?circle=${CIRCLE_A.ref}` });
    const form = await screen.findByRole("form");
    await waitFor(() => expect(within(form).getByLabelText(/Amount/)).toBeEnabled());
    await user.type(within(form).getByLabelText(/Amount/), "20");

    rerenderWith(view, { circles: [{ ...CIRCLE_A, currency: "EUR" }, CIRCLE_B] });
    expect(
      await screen.findByText("Amount was cleared because the Circle's currency changed."),
    ).toBeInTheDocument();

    await user.type(within(screen.getByRole("form")).getByLabelText(/Amount/), "3");
    expect(
      screen.queryByText("Amount was cleared because the Circle's currency changed."),
    ).not.toBeInTheDocument();
  });
});

describe("TransactionsNew — submission", () => {
  it("keeps an ordinary failure inline with the draft preserved", async () => {
    const user = userEvent.setup();
    setup();
    createTransaction.mockRejectedValue(new Error("network down"));
    await fillAndSubmit(user);
    expect(
      await screen.findByText("Couldn't save the transaction. Please try again."),
    ).toBeInTheDocument();
  });

  it("applies the reset contract when the destination is rejected at submit time", async () => {
    const user = userEvent.setup();
    const view = setup();
    createTransaction.mockRejectedValue(
      new ConvexError(mutationErrorData(MUTATION_ERRORS.circleArchived)),
    );
    await fillAndSubmit(user);

    expect(
      await screen.findByText(
        /That Circle is no longer available\. Circle-specific fields were cleared\./,
      ),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("Amount was cleared because the Circle is no longer available."),
    ).toBeInTheDocument();
    expect(view.location()).toBe(
      `${GLOBAL_ADD_PATH}?type=expense&returnTo=${encodeURIComponent(HOME_ORIGIN)}`,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("emits transaction_added with surface global and method manual and no financial content", async () => {
    const user = userEvent.setup();
    setup();
    await fillAndSubmit(user, "Lunch", "12.50");

    await waitFor(() => expect(createTransaction).toHaveBeenCalled());
    expect(posthogSdk.capture).toHaveBeenCalledWith(
      "transaction_added",
      expect.objectContaining({ surface: "global", method: "manual" }),
    );
    const call = posthogSdk.capture.mock.calls.find(([event]) => event === "transaction_added");
    const payload = JSON.stringify(call?.[1] ?? {});
    expect(payload).not.toContain("Lunch");
    expect(payload).not.toContain("12.50");
    expect(payload).not.toContain(CIRCLE_A.id);
  });

  it("defaults the Transaction Date to today (no month parameter)", async () => {
    const user = userEvent.setup();
    setup();
    await fillAndSubmit(user, "Lunch", "1.00");
    await waitFor(() => expect(createTransaction).toHaveBeenCalled());
    expect(createTransaction.mock.calls[0]?.[0]?.date).toBe(toPlainDate(new Date()));
  });
});

describe("TransactionsNew — returns and success navigation", () => {
  it("cancels directly to the validated origin", async () => {
    const user = userEvent.setup();
    const view = setup();
    await screen.findByRole("form");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(view.location()).toBe(HOME_ORIGIN));
  });

  it("falls back to Home for a missing or unsafe return origin", async () => {
    const user = userEvent.setup();
    const view = setup({
      url: `${GLOBAL_ADD_PATH}?type=expense&circle=${encodeURIComponent(CIRCLE_A.ref)}&returnTo=${encodeURIComponent("//evil.com")}`,
    });
    await screen.findByRole("form");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(view.location()).toBe("/"));
  });

  it("opens the new canonical Transaction Detail with the original origin as its return state", async () => {
    const user = userEvent.setup();
    // Seed the origin beneath Global Add so replace-on-success leaves browser
    // Back pointing at Home — the same history shape a Home → Add trip produces.
    const view = setup({ precedingEntries: [HOME_ORIGIN] });
    await fillAndSubmit(user, "Rent share", "500");

    await waitFor(() =>
      expect(view.location()).toContain(`/circles/${CIRCLE_A.ref}/transactions/rent`),
    );
    const detail = new URL(view.location(), "http://t");
    expect(detail.pathname).toBe(`/circles/${CIRCLE_A.ref}/transactions/rent-share-new-txn`);
    expect(detail.searchParams.get(RETURN_TO_PARAM)).toBe(HOME_ORIGIN);

    // Back restores the exact original Home state (create URL was replaced).
    await view.navigate(-1);
    await waitFor(() => expect(view.location()).toBe(HOME_ORIGIN));
  });

  it("retains an invalid Category selection visibly and blocks submission instead of resetting", async () => {
    const user = userEvent.setup();
    const view = setup();
    // Draft a valid-looking expense first.
    const form = screen.getByRole("form", { name: /add expense/i });
    await user.type(within(form).getByLabelText("Title"), "Odd one");
    await user.type(within(form).getByLabelText(/Amount/), "9");
    await pickTransactionFormCategory(user, form, "Groceries");

    // The Category disappears from the reactive read entirely.
    configureConvex({ ...baseState(), categories: [], createTransaction });
    view.rerenderRoutes(ROUTES);

    const retained = screen.getByRole("form");
    await user.click(within(retained).getByRole("button", { name: "Add expense" }));
    await waitFor(() => expect(createTransaction).not.toHaveBeenCalled());
    // The invalid selection stays visible as a retained chip rather than silently resetting.
    expect(retained).toHaveTextContent(/categories/i);
  });
});
