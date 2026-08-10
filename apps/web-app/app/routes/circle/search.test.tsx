import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as csv from "~/lib/csv.js";
import type { Category, Circle, Member, TransactionFilterOptions } from "~/lib/data.js";
import {
  assertFilterPanelDiscardsDraftOnClose,
  type ConvexState,
  configureConvex,
  FILTER_PANEL_CLOSE_MEDIUMS,
  makeCategoryView,
  makeCircleView,
  makeMemberView,
  makeTransactionView,
  pickCombobox,
  renderCircleRoutes,
  testId,
} from "~/test/convex-react.js";
import {
  posthogSdk,
  primeAnalyticsForTests,
  resetPostHogBoundary,
} from "~/test/posthog-boundary.js";

vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);
vi.mock(
  "convex-helpers/react",
  async () => (await import("~/test/convex-react.js")).convexHelpersReactMock,
);
vi.mock("posthog-js", async () => (await import("~/test/posthog-mock.js")).posthogModuleMock);
vi.mock("~/lib/env.js", async (importOriginal) =>
  (await import("~/test/posthog-mock.js")).createPosthogEnvMock(importOriginal),
);

import CircleSearch from "./search.js";

const REF = "trip-c1";

/** Walks the real history stack so tests can assert debounced search uses replace. */
function GoBack() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(-1)}>
      test-go-back
    </button>
  );
}

const ROUTES = (
  <>
    <Route path="circles/:circleRef/search" element={<CircleSearch />} />
    <Route
      path="circles/:circleRef/transactions/:transactionRef"
      element={<div>detail page</div>}
    />
  </>
);

function setup(
  opts: {
    circle?: Partial<Circle>;
    searchTransactions?: ConvexState["searchTransactions"];
    exportTransactions?: ConvexState["exportTransactions"];
    options?:
      | TransactionFilterOptions
      | null
      | ((args: Record<string, unknown>) => TransactionFilterOptions | null | undefined);
    initialEntries?: string[];
  } = {},
) {
  const circle = makeCircleView(opts.circle);
  configureConvex({
    searchTransactions: opts.searchTransactions,
    exportTransactions: opts.exportTransactions,
    transactionSearchOptions: opts.options ?? makeSearchOptions(),
  });
  const initialEntries = opts.initialEntries ?? [`/circles/${REF}/search`];
  return {
    circle,
    ...renderCircleRoutes(circle, ROUTES, { initialEntries, chrome: <GoBack /> }),
  };
}

function makeSearchOptions(): TransactionFilterOptions {
  return {
    categories: [
      makeCategoryView({ id: testId<Category["id"]>("cat-grocery"), name: "Groceries" }),
      makeCategoryView({
        id: testId<Category["id"]>("cat-salary"),
        name: "Salary",
        type: "income",
      }),
    ],
    members: [
      makeMemberView({ id: testId<Member["id"]>("mem-you"), displayName: "You" }),
      makeMemberView({
        id: testId<Member["id"]>("mem-alex"),
        displayName: "Alex",
        status: "removed",
      }),
    ],
  };
}

beforeEach(() => {
  primeAnalyticsForTests();
});

afterEach(() => {
  resetPostHogBoundary();
  vi.restoreAllMocks();
});

describe("CircleSearch", () => {
  it("normalizes bare search to default filters and shows default results", async () => {
    const { location } = setup({
      searchTransactions: [makeTransactionView({ title: "Weekly shop" })],
    });

    await waitFor(() => expect(location()).toBe(`/circles/${REF}/search?type=all&status=all`));
    expect(screen.getByText("Weekly shop")).toBeInTheDocument();
  });

  it("updates the URL as the user types (debounced)", async () => {
    const user = userEvent.setup();
    const { location } = setup({
      initialEntries: [`/circles/${REF}/search?type=all&status=active`],
    });

    await user.type(screen.getByRole("searchbox", { name: "Search title or note" }), "rent");
    await waitFor(() => expect(location()).toMatch(/q=rent/));
    expect(location()).toBe(`/circles/${REF}/search?type=all&status=active&q=rent`);
    expect(location()).not.toMatch(/page=/);
  });

  it("the debounced search REPLACES — back skips the typed states", async () => {
    const user = userEvent.setup();
    const { location } = setup({
      initialEntries: [`/circles/${REF}/search?type=all&status=all`],
    });
    await waitFor(() => expect(location()).toBe(`/circles/${REF}/search?type=all&status=all`));

    await user.click(screen.getByRole("button", { name: /Filters/ }));
    await user.click(screen.getByRole("button", { name: "Active" }));
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(location()).toBe(`/circles/${REF}/search?type=all&status=active`);

    await user.type(screen.getByRole("searchbox", { name: "Search title or note" }), "rent");
    await waitFor(() => expect(location()).toMatch(/q=rent/));

    await user.click(screen.getByRole("button", { name: "test-go-back" }));
    expect(location()).toBe(`/circles/${REF}/search?type=all&status=all`);
  });

  it("applies advanced filters through the panel", async () => {
    const user = userEvent.setup();
    const { location } = setup({
      initialEntries: [`/circles/${REF}/search?type=all&status=all`],
      searchTransactions: [makeTransactionView({ title: "Archived rent", status: "archived" })],
    });

    // Start from the canonical default (status=all), so the Filters button carries no count.
    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.click(screen.getByRole("button", { name: "Archived" }));
    await user.click(screen.getByRole("button", { name: "Expense" }));
    await user.type(screen.getByLabelText("From"), "2026-05-01");
    await user.type(screen.getByLabelText("To"), "2026-05-31");
    await user.type(screen.getByLabelText("Amount min"), "10");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(location()).toBe(
      `/circles/${REF}/search?type=expense&status=archived&from=2026-05-01&to=2026-05-31&min=10`,
    );
    expect(posthogSdk.capture).toHaveBeenCalledWith(
      "transaction_search_submitted",
      expect.objectContaining({
        type: "expense",
        status: "archived",
        hasDateRange: true,
        hasAmountRange: true,
      }),
    );
  });

  it("applies a category filter from the combobox to the URL", async () => {
    const user = userEvent.setup();
    const { location } = setup({
      initialEntries: [`/circles/${REF}/search?type=all&status=all`],
    });

    await user.click(screen.getByRole("button", { name: /Filters/ }));
    const dialog = screen.getByRole("dialog", { name: "Filters" });
    await pickCombobox(user, dialog, "Categories", "Groceries");
    await user.click(within(dialog).getByRole("button", { name: "Apply" }));

    expect(location()).toMatch(/categories=cat-grocery/);
  });

  it("labels removed vs deleted account members in Paid by filters", async () => {
    const user = userEvent.setup();
    setup({
      initialEntries: [`/circles/${REF}/search?type=all&status=all`],
      options: {
        ...makeSearchOptions(),
        members: [
          makeMemberView({ id: testId<Member["id"]>("mem-you"), displayName: "You" }),
          makeMemberView({
            id: testId<Member["id"]>("mem-alex"),
            displayName: "Alex",
            status: "removed",
          }),
          makeMemberView({
            id: testId<Member["id"]>("mem-rex"),
            displayName: "Rex",
            status: "deleted",
          }),
        ],
      },
    });

    await user.click(screen.getByRole("button", { name: /Filters/ }));
    const dialog = screen.getByRole("dialog", { name: "Filters" });
    const combobox = within(dialog).getByRole("combobox", { name: "Paid by" });
    await user.click(combobox);

    expect(await screen.findByText("removed")).toBeInTheDocument();
    expect(screen.getByText("deleted account")).toBeInTheDocument();
    await user.keyboard("{Escape}");
  });

  it("resets immediately to canonical default search", async () => {
    const user = userEvent.setup();
    const { location } = setup({
      initialEntries: [`/circles/${REF}/search?type=expense&status=all&q=rent`],
    });

    await user.click(screen.getByRole("button", { name: /Filters/ }));
    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(location()).toBe(`/circles/${REF}/search?type=all&status=all`);
  });

  it("does not rewrite applied filters when the open panel's draft type changes the options", async () => {
    const user = userEvent.setup();
    const url = `/circles/${REF}/search?type=expense&status=active&categories=cat-grocery`;
    const { location } = setup({
      initialEntries: [url],
      // Options narrow by type: the applied expense category vanishes from the income set.
      options: (args) =>
        args.type === "income"
          ? {
              categories: [
                makeCategoryView({ id: testId<Category["id"]>("cat-salary"), name: "Salary" }),
              ],
              members: [
                makeMemberView({ id: testId<Member["id"]>("mem-you"), displayName: "You" }),
              ],
            }
          : {
              categories: [
                makeCategoryView({ id: testId<Category["id"]>("cat-grocery"), name: "Groceries" }),
              ],
              members: [
                makeMemberView({ id: testId<Member["id"]>("mem-you"), displayName: "You" }),
              ],
            },
    });

    await waitFor(() => expect(location()).toBe(url));

    await user.click(screen.getByRole("button", { name: /Filters/ }));
    await user.click(screen.getByRole("button", { name: "Income" }));

    // Draft edits never touch the applied URL — the still-applied expense category survives
    // even though the income draft's option set no longer contains it.
    expect(location()).toBe(url);
  });

  it("opens a result detail carrying the search URL as returnTo so Back returns to the results", async () => {
    const user = userEvent.setup();
    const origin = `/circles/${REF}/search?type=all&status=active&q=rent`;
    const { location } = setup({
      initialEntries: [origin],
      searchTransactions: [makeTransactionView({ ref: "rent-t1", title: "Rent" })],
    });

    await user.click(screen.getByRole("link", { name: "View Rent" }));
    const dest = new URL(location(), "http://t");
    expect(dest.pathname).toBe(`/circles/${REF}/transactions/rent-t1`);
    expect(dest.searchParams.get("returnTo")).toBe(origin);
  });

  it("shows numbered page 2 slice and updates the URL when Page 1 is chosen", async () => {
    const user = userEvent.setup();
    const searchTransactions = Array.from({ length: 30 }, (_, index) =>
      makeTransactionView({ ref: `t-${index}`, title: `Row ${index}` }),
    );
    setup({
      initialEntries: [`/circles/${REF}/search?type=all&status=all&page=2`],
      searchTransactions,
    });

    await waitFor(() => expect(screen.getByText("Row 25")).toBeInTheDocument());
    expect(screen.queryByText("Row 0")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Page 1" }));
    await waitFor(() => expect(screen.getByText("Row 0")).toBeInTheDocument());
    expect(screen.getByRole("status", { name: "Search results page" })).toHaveTextContent(
      "Page 1 of 2",
    );
  });

  it("keeps pagination mounted and focused while the next page loads", async () => {
    const user = userEvent.setup();
    const rows = Array.from({ length: 30 }, (_, index) =>
      makeTransactionView({ ref: `t-${index}`, title: `Row ${index}` }),
    );
    setup({
      initialEntries: [`/circles/${REF}/search?type=all&status=all`],
      // Page 2 never resolves — models the in-flight window after a page click.
      searchTransactions: (args) => (args.page === 2 ? undefined : rows),
    });
    await waitFor(() => expect(screen.getByText("Row 0")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Page 2" }));

    expect(screen.getByRole("button", { name: "Page 2" })).toHaveFocus();
    expect(screen.getByRole("status", { name: "Search results page" })).toHaveTextContent(
      "Loading page 2…",
    );
  });

  it("resets page to 1 when filters are applied from the panel", async () => {
    const user = userEvent.setup();
    const { location } = setup({
      initialEntries: [`/circles/${REF}/search?type=all&status=all&page=2`],
      searchTransactions: [makeTransactionView({ title: "Only" })],
    });

    await user.click(screen.getByRole("button", { name: /Filters/ }));
    await user.click(screen.getByRole("button", { name: "Expense" }));
    await user.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(location()).toBe(`/circles/${REF}/search?type=expense&status=all`));
    expect(location()).not.toMatch(/page=/);
  });

  it("resets page to 1 when submitting a new query from the search box", async () => {
    const user = userEvent.setup();
    const { location } = setup({
      initialEntries: [`/circles/${REF}/search?type=all&status=all&q=old&page=3`],
    });

    await user.clear(screen.getByRole("searchbox", { name: "Search title or note" }));
    await user.type(screen.getByRole("searchbox", { name: "Search title or note" }), "new");

    await waitFor(() => expect(location()).toMatch(/q=new/));
    expect(location()).not.toMatch(/page=/);
    expect(posthogSdk.capture).toHaveBeenCalledWith(
      "transaction_search_submitted",
      expect.objectContaining({ hasQuery: true }),
    );
  });

  it.each(
    FILTER_PANEL_CLOSE_MEDIUMS,
  )("discards unapplied panel edits when the panel is closed via %s", async (medium) => {
    const user = userEvent.setup();
    const { location } = setup({
      initialEntries: [`/circles/${REF}/search?type=all&status=all`],
    });

    await assertFilterPanelDiscardsDraftOnClose({ user, medium, location });
  });

  it("keeps in-flight top-bar query when a concurrent applied change does not touch q", async () => {
    const user = userEvent.setup();
    const searchTransactions = Array.from({ length: 30 }, (_, index) =>
      makeTransactionView({ ref: `t-${index}`, title: `Rent row ${index}` }),
    );
    const { location } = setup({
      initialEntries: [`/circles/${REF}/search?type=all&status=all&q=rent&page=2`],
      searchTransactions,
    });

    await waitFor(() => expect(screen.getByText("Rent row 25")).toBeInTheDocument());

    const searchbox = screen.getByRole("searchbox", { name: "Search title or note" });
    await user.type(searchbox, "al");
    expect(searchbox).toHaveValue("rental");

    await user.click(screen.getByRole("button", { name: "Page 1" }));
    await waitFor(() => expect(location()).not.toMatch(/page=2/));
    expect(posthogSdk.capture).toHaveBeenCalledWith("transaction_search_page_changed", {
      page: 1,
    });

    expect(searchbox).toHaveValue("rental");
    expect(location()).toMatch(/q=rent/);
  });

  it("keeps open-panel draft selections when the top-bar query applies while filters are open", async () => {
    const user = userEvent.setup();
    const { location } = setup({
      initialEntries: [`/circles/${REF}/search?type=all&status=all`],
    });
    expect(location()).toBe(`/circles/${REF}/search?type=all&status=all`);

    // Start a top-bar query, then edit the open filter panel while that query applies.
    await user.type(screen.getByRole("searchbox", { name: "Search title or note" }), "rent");
    await user.click(screen.getByRole("button", { name: /Filters/ }));
    const dialog = screen.getByRole("dialog", { name: "Filters" });
    await pickCombobox(user, dialog, "Categories", "Groceries");
    expect(within(dialog).getByRole("button", { name: "Remove Groceries" })).toBeInTheDocument();

    // The applied-only `q` change must not resync the open draft and discard the category.
    await waitFor(() => expect(location()).toMatch(/q=rent/));

    await user.click(within(dialog).getByRole("button", { name: "Apply" }));
    expect(location()).toMatch(/categories=cat-grocery/);
    expect(location()).toMatch(/q=rent/);
  });

  it("does not apply abandoned panel edits when searching from the top bar after closing", async () => {
    const user = userEvent.setup();
    const { location } = setup({
      initialEntries: [`/circles/${REF}/search?type=all&status=all`],
    });

    // Edit the panel, then abandon it (Esc) without Apply.
    await user.click(screen.getByRole("button", { name: /Filters/ }));
    const dialog = screen.getByRole("dialog", { name: "Filters" });
    await user.click(within(dialog).getByRole("button", { name: "Expense" }));
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Filters" })).not.toBeInTheDocument(),
    );

    // Searching from the top bar commits only the query — the abandoned type=expense edit
    // (which shared the same draft/submit) must not ride along.
    await user.type(screen.getByRole("searchbox", { name: "Search title or note" }), "rent");
    await waitFor(() =>
      expect(location()).toBe(`/circles/${REF}/search?type=all&status=all&q=rent`),
    );
  });

  it("exports the current applied search filters as CSV", async () => {
    const downloadSpy = vi.spyOn(csv, "downloadCsv").mockImplementation(() => {});
    const user = userEvent.setup();
    setup({
      initialEntries: [`/circles/${REF}/search?type=all&status=active&q=rent`],
      searchTransactions: [makeTransactionView({ title: "Rent", amountMinorUnits: 120_000 })],
    });

    await user.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => expect(downloadSpy).toHaveBeenCalledOnce());
    expect(posthogSdk.capture).toHaveBeenCalledWith(
      "export_performed",
      expect.objectContaining({ result: "downloaded" }),
    );
    const [filename, content] = downloadSpy.mock.calls[0] ?? [];
    expect(filename).toMatch(/^spend-circle-trip-c1-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(content).toContain("Rent");
    expect(content).toContain("1200.00");
    expect(content).not.toContain("mock-");
  });

  it("shows guidance when export refuses for too many rows", async () => {
    const user = userEvent.setup();
    setup({
      exportTransactions: { ok: false, reason: "tooMany", limit: 5000 },
    });

    await user.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() =>
      expect(
        screen.getByText(/Too many transactions to export \(limit 5000\)/),
      ).toBeInTheDocument(),
    );
    expect(posthogSdk.capture).toHaveBeenCalledWith(
      "export_performed",
      expect.objectContaining({ result: "too_many" }),
    );
  });

  it("shows an error when the export query rejects", async () => {
    const user = userEvent.setup();
    setup({
      exportTransactions: () => {
        throw new Error("network");
      },
    });

    await user.click(screen.getByRole("button", { name: "Export" }));

    expect(
      await screen.findByText("Couldn't export the search results. Please try again."),
    ).toBeInTheDocument();
    expect(posthogSdk.capture).toHaveBeenCalledWith(
      "export_performed",
      expect.objectContaining({ result: "failed" }),
    );
    expect(screen.getByRole("button", { name: "Export" })).toBeEnabled();
  });
});
