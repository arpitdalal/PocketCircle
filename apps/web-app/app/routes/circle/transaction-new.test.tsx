import { currentMonth, MUTATION_ERRORS, mutationErrorData } from "@pocketcircle/domain";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import type { ReactNode } from "react";
import { Route, useNavigate } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Circle } from "~/lib/data.js";
import {
  circleLayoutHeadingChrome,
  configureConvex,
  makeCategoryView,
  makeCircleView,
  makeMemberView,
  pickTransactionFormCategory,
  renderCircleRoutes,
} from "~/test/convex-react.js";

/**
 * Behavior test for the new-Transaction OBJECT route (jsdom, issue #96). Doubles ONLY
 * Convex's reactive client and runs the REAL route + REAL shared Transaction form
 * (create mode) + REAL `~/lib/data.js` hooks under a REAL router, so the create page's
 * own concerns — the `type`/`month` params, the `returnTo` lifecycle, and the
 * archived/invalid-`type` guards — are exercised exactly as in the app. The field-level
 * rules are covered in `transaction-form.test.tsx`; here we assert the route, not the
 * fields.
 */
vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);

import TransactionNew from "./transaction-new.js";

const REF = "trip-c1";
const createTransaction = vi.fn();
/** Matches `assertWritable` in `packages/convex/convex/guard.ts` — realistic prod rejection. */
const ARCHIVED_CIRCLE_ERROR = new ConvexError(mutationErrorData(MUTATION_ERRORS.circleArchived));

// The validated `returnTo` origin a create page is opened with (issue #123): a filtered
// ledger. Close / save / invalid-`type` / archived redirect all land back here.
const LEDGER_ORIGIN = `/circles/${REF}/transactions?month=2026-05&type=all&status=all`;
const LEDGER = encodeURIComponent(LEDGER_ORIGIN);

const ROUTES = (
  <>
    {/* The return / fallback targets; placeholders are enough to assert the URL landed. */}
    <Route path="circles/:circleRef/transactions" element={<div>ledger</div>} />
    <Route path="circles/:circleRef/transactions/new" element={<TransactionNew />} />
  </>
);

function setup(opts: { circle?: Partial<Circle>; url?: string; chrome?: ReactNode } = {}) {
  const circle = makeCircleView(opts.circle);
  createTransaction.mockReset();
  createTransaction.mockResolvedValue("new-id");
  configureConvex({
    categories: [makeCategoryView()],
    members: [makeMemberView()],
    createTransaction,
  });
  const url =
    opts.url ?? `/circles/${REF}/transactions/new?type=expense&month=2026-05&returnTo=${LEDGER}`;
  return renderCircleRoutes(circle, ROUTES, {
    initialEntries: [url],
    chrome: (
      <>
        {circleLayoutHeadingChrome(circle)}
        {/* Always-mounted extra chrome (e.g. a nav control) survives route changes so a
            test can drive an in-route URL change without unmounting the route. */}
        {opts.chrome}
      </>
    ),
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("TransactionNew — heading hierarchy", () => {
  it("renders the form title as h2 under the Circle layout h1", () => {
    setup();
    expect(screen.getByRole("heading", { level: 1, name: "Trip" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Add expense" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });
});

describe("TransactionNew — render", () => {
  it("renders the create form for the URL type", () => {
    setup();
    expect(screen.getByRole("form", { name: /add expense/i })).toBeInTheDocument();
  });

  it("renders the income create form for ?type=income", () => {
    setup({ url: `/circles/${REF}/transactions/new?type=income&returnTo=${LEDGER}` });
    expect(screen.getByRole("form", { name: /add income/i })).toBeInTheDocument();
  });

  it("defaults the new transaction's date into the URL month", async () => {
    const user = userEvent.setup();
    setup();
    const form = screen.getByRole("form", { name: /add expense/i });
    await user.type(within(form).getByLabelText("Title"), "Lunch");
    await user.type(within(form).getByLabelText(/Amount/), "12.50");
    await pickTransactionFormCategory(user, form, "Groceries");
    await user.click(within(form).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(createTransaction).toHaveBeenCalled());
    expect(createTransaction.mock.calls[0]?.[0]).toMatchObject({ type: "expense" });
    // The create form seeds its date from `selectedMonth`, so the saved date is in May.
    expect(createTransaction.mock.calls[0]?.[0]?.date).toMatch(/^2026-05-/);
  });

  it("falls back to the current month when `month` is missing", async () => {
    const user = userEvent.setup();
    setup({ url: `/circles/${REF}/transactions/new?type=expense&returnTo=${LEDGER}` });
    const form = screen.getByRole("form", { name: /add expense/i });
    await user.type(within(form).getByLabelText("Title"), "Lunch");
    await user.type(within(form).getByLabelText(/Amount/), "1.00");
    await pickTransactionFormCategory(user, form, "Groceries");
    await user.click(within(form).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(createTransaction).toHaveBeenCalled());
    expect(createTransaction.mock.calls[0]?.[0]?.date).toMatch(
      new RegExp(`^${currentMonth(new Date())}-`),
    );
  });
});

describe("TransactionNew — month change without a loading gap", () => {
  /** A nav control rendered as always-mounted chrome so clicking it changes the create
   * URL WITHOUT unmounting the route — the Back/Forward-between-CTAs case. */
  function GoTo({ to }: { to: string }) {
    const navigate = useNavigate();
    return (
      <button type="button" onClick={() => navigate(to)}>
        go
      </button>
    );
  }

  it("remounts the form so a navigated-to month never keeps the previous month's date", async () => {
    const user = userEvent.setup();
    // Same `type`, different `month`: only a key covering BOTH URL-owned inputs
    // remounts the form, re-seeding its Date default from the new month.
    setup({
      url: `/circles/${REF}/transactions/new?type=expense&month=2026-05&returnTo=${LEDGER}`,
      chrome: <GoTo to={`/circles/${REF}/transactions/new?type=expense&month=2026-06`} />,
    });
    const form = () => screen.getByRole("form", { name: /add expense/i });
    // Touch the form first (typed-and-blurred Title): a kept-mounted form stops
    // re-seeding from changed defaults once touched, so without the full-input key the
    // May date would silently survive under the June URL.
    await user.type(within(form()).getByLabelText("Title"), "Draft");
    await user.tab();
    expect(within(form()).getByLabelText("Date")).toHaveValue("2026-05-01");

    await user.click(screen.getByRole("button", { name: "go" }));
    await waitFor(() => expect(within(form()).getByLabelText("Date")).toHaveValue("2026-06-01"));
  });
});

describe("TransactionNew — return navigation", () => {
  it("returns to the returnTo origin on cancel", async () => {
    const user = userEvent.setup();
    const { location } = setup();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(location()).toBe(LEDGER_ORIGIN);
  });

  it("returns to the returnTo origin after a successful create", async () => {
    const user = userEvent.setup();
    const { location } = setup();
    const form = screen.getByRole("form", { name: /add expense/i });
    await user.type(within(form).getByLabelText("Title"), "Lunch");
    await user.type(within(form).getByLabelText(/Amount/), "12.50");
    await pickTransactionFormCategory(user, form, "Groceries");
    await user.click(within(form).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(createTransaction).toHaveBeenCalled());
    await waitFor(() => expect(location()).toBe(LEDGER_ORIGIN));
  });

  it("Save & new stays on the create URL, shows snackbar, focuses Title, and Cancel still returns", async () => {
    const user = userEvent.setup();
    const { location } = setup();
    const form = screen.getByRole("form", { name: /add expense/i });
    await user.type(within(form).getByLabelText("Title"), "First stay");
    await user.type(within(form).getByLabelText(/Amount/), "4");
    await pickTransactionFormCategory(user, form, "Groceries");
    await user.click(within(form).getByRole("button", { name: "Save & new" }));

    await waitFor(() => expect(createTransaction).toHaveBeenCalledTimes(1));
    expect(location()).toContain("/transactions/new");
    expect(await screen.findByText("Transaction added. Ready for another.")).toBeInTheDocument();
    await waitFor(() => {
      expect(within(form).getByLabelText("Title")).toHaveValue("");
    });
    expect(within(form).getByLabelText("Title")).toHaveFocus();
    expect(within(form).getByLabelText("Date")).toHaveValue("2026-05-01");

    await user.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(location()).toBe(LEDGER_ORIGIN);
  });

  it("falls back to the bare ledger when there is no returnTo", async () => {
    const user = userEvent.setup();
    const { location } = setup({ url: `/circles/${REF}/transactions/new?type=expense` });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(location()).toBe(`/circles/${REF}/transactions`);
  });

  it("falls back to the bare ledger for a tampered (protocol-relative) returnTo — no open redirect", async () => {
    const user = userEvent.setup();
    const { location } = setup({
      url: `/circles/${REF}/transactions/new?type=expense&returnTo=${encodeURIComponent("//evil.com")}`,
    });
    // A tampered returnTo is just a hint; the form still renders, and closing lands on the
    // safe fallback (the bare ledger), never the off-origin destination.
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(location()).toBe(`/circles/${REF}/transactions`);
  });
});

describe("TransactionNew — guards", () => {
  it("redirects to the returnTo origin when `type` is missing", async () => {
    const { location } = setup({ url: `/circles/${REF}/transactions/new?returnTo=${LEDGER}` });
    await waitFor(() => expect(location()).toBe(LEDGER_ORIGIN));
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
  });

  it("redirects to the returnTo origin for an invalid `type`", async () => {
    const { location } = setup({
      url: `/circles/${REF}/transactions/new?type=nonsense&returnTo=${LEDGER}`,
    });
    await waitFor(() => expect(location()).toBe(LEDGER_ORIGIN));
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
  });

  it("redirects to the bare ledger when `type` is invalid and returnTo is absent", async () => {
    const { location } = setup({ url: `/circles/${REF}/transactions/new` });
    await waitFor(() => expect(location()).toBe(`/circles/${REF}/transactions`));
  });

  it("redirects an archived Circle to the returnTo origin without showing the form", async () => {
    const { location } = setup({ circle: { status: "archived" } });
    await waitFor(() => expect(location()).toBe(LEDGER_ORIGIN));
    expect(screen.queryByRole("form", { name: /add expense/i })).not.toBeInTheDocument();
  });
});

describe("TransactionNew — submit errors (stay on the page)", () => {
  it("surfaces an archived-circle rejection inline and re-enables the form", async () => {
    const user = userEvent.setup();
    setup();
    createTransaction.mockRejectedValue(ARCHIVED_CIRCLE_ERROR);
    const form = screen.getByRole("form", { name: /add expense/i });
    await user.type(within(form).getByLabelText("Title"), "Late entry");
    await user.type(within(form).getByLabelText(/Amount/), "10");
    await pickTransactionFormCategory(user, form, "Groceries");
    await user.click(within(form).getByRole("button", { name: "Save" }));

    expect(
      await within(form).findByText(MUTATION_ERRORS.circleArchived.message),
    ).toBeInTheDocument();
    await waitFor(() => expect(within(form).getByRole("button", { name: "Save" })).toBeEnabled());
  });

  it("treats a plain Error with archived message as a generic fallback", async () => {
    const user = userEvent.setup();
    setup();
    createTransaction.mockRejectedValue(new Error("Circle is archived"));
    const form = screen.getByRole("form", { name: /add expense/i });
    await user.type(within(form).getByLabelText("Title"), "Late entry");
    await user.type(within(form).getByLabelText(/Amount/), "10");
    await pickTransactionFormCategory(user, form, "Groceries");
    await user.click(within(form).getByRole("button", { name: "Save" }));

    expect(
      await within(form).findByText("Couldn't save the transaction. Please try again."),
    ).toBeInTheDocument();
    expect(within(form).queryByText("Circle is archived", { exact: true })).not.toBeInTheDocument();
  });
});
