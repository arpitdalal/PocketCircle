import { MUTATION_ERRORS, mutationErrorData } from "@spend-circle/domain";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { Route, useNavigate } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Category, CategoryHistoryEvent, Circle, PaginationStatus } from "~/lib/data.js";
import {
  configureConvex,
  flushIntersectionObserverStub,
  installIntersectionObserverStub,
  makeCategoryView,
  makeCircleView,
  makeHistoryEventView,
  renderCircleRoutes,
  testId,
} from "~/test/convex-react.js";
import { archiveWithDoubleCheck, armArchive, confirmArchive } from "~/test/double-check.js";

/**
 * Behavior test for the Categories surface (jsdom). The ONLY thing doubled is
 * Convex's reactive client (`convex/react`, via the shared helper). The real
 * `~/lib/data.js` hooks, the real `useCircle` Outlet-context seam, the real
 * URL codec (`categories-filter-url.ts`), and the real route + form logic run,
 * so a drift between the route, the data layer, and the backend query contract
 * is caught here rather than mocked away (ADR 0006).
 */
vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);
// useCategoriesPage reads the stream-paginated filterCategories through the
// convex-helpers hook (endCursor pinning) — same vendor edge, same double.
vi.mock(
  "convex-helpers/react",
  async () => (await import("~/test/convex-react.js")).convexHelpersReactMock,
);

import CircleCategories from "./categories.js";

const createCategory = vi.fn();
const updateCategory = vi.fn();
const archiveCategory = vi.fn();
const restoreCategory = vi.fn();

/** A chrome control that walks the real history stack, so tests can assert the
 * push (type/status) vs replace (debounced search) split behaviorally. */
function GoBack() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(-1)}>
      test-go-back
    </button>
  );
}

function setup(
  opts: {
    circle?: Partial<Circle>;
    categories?: Category[] | null;
    categoryHistory?: CategoryHistoryEvent[];
    historyStatus?: PaginationStatus;
    historyLoadMore?: () => void;
    categoriesPageStatus?: PaginationStatus;
    categoriesLoadMore?: () => void;
    initialEntries?: string[];
  } = {},
) {
  const circle = makeCircleView(opts.circle);
  createCategory.mockReset().mockResolvedValue("new-id");
  updateCategory.mockReset().mockResolvedValue("cat-groceries");
  archiveCategory.mockReset().mockResolvedValue("cat-groceries");
  restoreCategory.mockReset().mockResolvedValue("cat-groceries");
  configureConvex({
    categories: opts.categories,
    categoryHistory: opts.categoryHistory,
    historyStatus: opts.historyStatus,
    historyLoadMore: opts.historyLoadMore,
    categoriesPageStatus: opts.categoriesPageStatus,
    categoriesLoadMore: opts.categoriesLoadMore,
    createCategory,
    updateCategory,
    archiveCategory,
    restoreCategory,
  });
  return renderCircleRoutes(circle, <Route path="/" element={<CircleCategories />} />, {
    initialEntries: opts.initialEntries,
    chrome: <GoBack />,
  });
}

/** The Status filter's fieldset — scope "All" / "Active" / "Archived" queries here,
 * since the Type segment (#138) now also has an "All" button. */
function statusGroup() {
  return screen.getByRole("group", { name: "Status" });
}

/** The list row (the `<li>`) containing `name`, asserted present so a missing row
 * fails HERE at the lookup rather than later as an opaque `within(null)`. The "li"
 * selector narrows the result to `HTMLLIElement` and the null check removes the
 * `| null`, so no `as` cast is needed to scope `within` to the row. */
function rowFor(name: string) {
  const row = screen.getByText(name).closest("li");
  if (row === null) {
    throw new Error(`Expected a category row containing "${name}"`);
  }
  return row;
}

/** Both rows used by the lifecycle-mix tests: one active, one archived. */
function mixedRows() {
  return [
    makeCategoryView(),
    makeCategoryView({
      id: testId<Category["id"]>("cat-old"),
      name: "Old Subscriptions",
      status: "archived",
    }),
  ];
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("CircleCategories — list and create (CAT-1; issue #138 all types)", () => {
  it("lists all types together by default (income + expense interleaved)", () => {
    setup({
      categories: [
        makeCategoryView({ name: "Groceries", type: "expense" }),
        makeCategoryView({ id: testId<Category["id"]>("i1"), name: "Salary", type: "income" }),
      ],
    });
    const list = screen.getByRole("list");
    expect(within(list).getByText("Groceries")).toBeInTheDocument();
    expect(within(list).getByText("Salary")).toBeInTheDocument();
  });

  it("tags each row with its type via a per-row pill", () => {
    setup({
      categories: [
        makeCategoryView({ name: "Groceries", type: "expense" }),
        makeCategoryView({ id: testId<Category["id"]>("i1"), name: "Salary", type: "income" }),
      ],
    });
    expect(within(rowFor("Groceries")).getByText("expense")).toBeInTheDocument();
    expect(within(rowFor("Salary")).getByText("income")).toBeInTheDocument();
  });

  it("shows the no-categories-yet empty state on the default (unnarrowed) all view", () => {
    setup({ categories: [] });
    expect(screen.getByText("No categories yet.")).toBeInTheDocument();
  });

  it("narrows the list and re-targets the create CTA's type via the All/Expense/Income filter", async () => {
    const user = userEvent.setup();
    setup({
      categories: [
        makeCategoryView({ name: "Groceries", type: "expense" }),
        makeCategoryView({ id: testId<Category["id"]>("i1"), name: "Salary", type: "income" }),
      ],
    });
    // Default All view: both visible, and the CTA carries no concrete type (the form defaults).
    expect(screen.getByText("Groceries")).toBeInTheDocument();
    expect(screen.getByText("Salary")).toBeInTheDocument();
    expect(
      new URL(
        screen.getByRole("link", { name: "New category" }).getAttribute("href") ?? "",
        "http://t",
      ).searchParams.get("type"),
    ).toBeNull();

    await user.click(screen.getByRole("button", { name: "Income" }));

    expect(screen.getByText("Salary")).toBeInTheDocument();
    expect(screen.queryByText("Groceries")).not.toBeInTheDocument();
    // A concrete type now deep-links the create CTA so the form opens on the right type.
    expect(screen.getByRole("link", { name: "New category" })).toHaveAttribute(
      "href",
      expect.stringContaining("type=income"),
    );
  });

  it("points the create CTA at the new-Category route, carrying the list URL as returnTo", () => {
    // This harness mounts the route at "/", so the origin (and thus returnTo) is that path;
    // the realistic circle-scoped round-trip is covered in `category-new.test.tsx` + E2E.
    setup({ categories: [], initialEntries: ["/?type=expense&status=all&q=food"] });
    const href = screen.getByRole("link", { name: "New category" }).getAttribute("href") ?? "";
    const dest = new URL(href, "http://t");
    expect(dest.pathname).toBe("/circles/trip-c1/categories/new");
    expect(dest.searchParams.get("type")).toBe("expense");
    expect(dest.searchParams.get("returnTo")).toBe("/?type=expense&status=all&q=food");
  });

  it("renders a read-only notice and no create CTA for an archived Circle", () => {
    setup({ circle: { status: "archived" }, categories: [] });
    expect(screen.getByText(/circle is archived/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "New category" })).not.toBeInTheDocument();
  });

  it("shows a skeleton while the first page resolves", () => {
    setup({ categories: [], categoriesPageStatus: "LoadingFirstPage" });
    const skeleton = screen.getByTestId("categories-skeleton");
    expect(skeleton).toHaveAttribute("aria-busy", "true");
    expect(within(skeleton).getByText(/Loading categories/)).toBeInTheDocument();
  });
});

describe("CircleCategories — Category Filter status (CAT-4)", () => {
  it("defaults to status=all: archived rows show with the badge, not hidden", () => {
    setup({ categories: mixedRows() });
    const list = screen.getByRole("list");
    expect(within(list).getByText("Groceries")).toBeInTheDocument();
    expect(within(rowFor("Old Subscriptions")).getByText("Archived")).toBeInTheDocument();
  });

  it("narrows to active-only and archived-only through the Status control", async () => {
    const user = userEvent.setup();
    setup({ categories: mixedRows() });

    await user.click(screen.getByRole("button", { name: "Active" }));
    expect(screen.getByText("Groceries")).toBeInTheDocument();
    expect(screen.queryByText("Old Subscriptions")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Archived" }));
    expect(screen.queryByText("Groceries")).not.toBeInTheDocument();
    expect(screen.getByText("Old Subscriptions")).toBeInTheDocument();

    // "All" is ambiguous (Type segment also has one) — scope to the Status group.
    await user.click(within(statusGroup()).getByRole("button", { name: "All" }));
    expect(screen.getByText("Groceries")).toBeInTheDocument();
    expect(screen.getByText("Old Subscriptions")).toBeInTheDocument();
  });

  it("shows the no-match empty state when the status narrows everything out", async () => {
    const user = userEvent.setup();
    setup({ categories: [makeCategoryView()] }); // active only — nothing archived

    await user.click(screen.getByRole("button", { name: "Archived" }));

    expect(screen.getByText("No categories match this filter.")).toBeInTheDocument();
    expect(screen.queryByText("No categories yet.")).not.toBeInTheDocument();
  });
});

describe("CircleCategories — Category Filter search (CAT-4)", () => {
  it("debounces the search and narrows the list (substring, case-insensitive)", async () => {
    const user = userEvent.setup();
    const view = setup({
      categories: [
        makeCategoryView(),
        makeCategoryView({ id: testId<Category["id"]>("c2"), name: "Rent" }),
      ],
    });

    await user.type(screen.getByLabelText("Search categories by name"), "OCER");

    await waitFor(() => expect(view.location()).toContain("q=OCER"));
    expect(screen.getByText("Groceries")).toBeInTheDocument();
    expect(screen.queryByText("Rent")).not.toBeInTheDocument();
  });

  it("shows the no-match empty state for a term matching nothing", async () => {
    const user = userEvent.setup();
    setup({ categories: [makeCategoryView()] });

    await user.type(screen.getByLabelText("Search categories by name"), "zzz");

    expect(await screen.findByText("No categories match this filter.")).toBeInTheDocument();
  });

  it("clearing the search restores the unfiltered list and drops q from the URL", async () => {
    const user = userEvent.setup();
    const view = setup({
      categories: [
        makeCategoryView(),
        makeCategoryView({ id: testId<Category["id"]>("c2"), name: "Rent" }),
      ],
    });
    const input = screen.getByLabelText("Search categories by name");

    await user.type(input, "rent");
    await waitFor(() => expect(view.location()).toContain("q=rent"));
    expect(screen.queryByText("Groceries")).not.toBeInTheDocument();

    await user.clear(input);
    await waitFor(() => expect(view.location()).not.toContain("q="));
    expect(screen.getByText("Groceries")).toBeInTheDocument();
    expect(screen.getByText("Rent")).toBeInTheDocument();
  });
});

describe("CircleCategories — URL-owned filter state (CAT-4, ADR 0016)", () => {
  it("canonicalizes a bare URL to always carry type and status (defaults all/all)", async () => {
    const view = setup({ categories: [] });
    await waitFor(() => expect(view.location()).toBe("/?type=all&status=all"));
  });

  it("reproduces a filtered view from a deep link", () => {
    setup({
      categories: mixedRows(),
      initialEntries: ["/?type=expense&status=archived&q=subscriptions"],
    });

    expect(screen.getByText("Old Subscriptions")).toBeInTheDocument();
    expect(screen.queryByText("Groceries")).not.toBeInTheDocument();
    expect(screen.getByLabelText<HTMLInputElement>("Search categories by name").value).toBe(
      "subscriptions",
    );
  });

  it("clamps unknown type and status values to the defaults", async () => {
    const view = setup({
      categories: mixedRows(),
      initialEntries: ["/?type=bogus&status=nope"],
    });

    await waitFor(() => expect(view.location()).toBe("/?type=all&status=all"));
    // Default all: both rows visible; the All type segment is pressed.
    expect(
      within(screen.getByRole("group", { name: "Type" })).getByRole("button", {
        name: "All",
        pressed: true,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Old Subscriptions")).toBeInTheDocument();
  });

  it("type and status changes PUSH history — back returns to the previous filter", async () => {
    const user = userEvent.setup();
    const view = setup({ categories: mixedRows() });
    await waitFor(() => expect(view.location()).toBe("/?type=all&status=all"));

    await user.click(screen.getByRole("button", { name: "Expense" }));
    expect(view.location()).toBe("/?type=expense&status=all");

    await user.click(screen.getByRole("button", { name: "test-go-back" }));
    expect(view.location()).toBe("/?type=all&status=all");
    expect(screen.getByText("Old Subscriptions")).toBeInTheDocument();
  });

  it("the debounced search REPLACES — back skips the typed states", async () => {
    const user = userEvent.setup();
    const view = setup({ categories: mixedRows() });
    await waitFor(() => expect(view.location()).toBe("/?type=all&status=all"));

    // A discrete change first, so there IS a previous entry to land on.
    await user.click(screen.getByRole("button", { name: "Active" }));
    expect(view.location()).toBe("/?type=all&status=active");

    await user.type(screen.getByLabelText("Search categories by name"), "groc");
    await waitFor(() => expect(view.location()).toContain("q=groc"));

    // Back jumps OVER the search write (it replaced), to the pre-status entry.
    await user.click(screen.getByRole("button", { name: "test-go-back" }));
    expect(view.location()).toBe("/?type=all&status=all");
  });
});

describe("CircleCategories — pagination (CAT-4)", () => {
  installIntersectionObserverStub();

  it("loads the next page when the infinite-scroll sentinel intersects (wires loadMore)", () => {
    const categoriesLoadMore = vi.fn();
    setup({
      categories: [makeCategoryView()],
      categoriesPageStatus: "CanLoadMore",
      categoriesLoadMore,
    });

    expect(screen.getByTestId("categories-infinite-scroll-sentinel")).toBeInTheDocument();
    flushIntersectionObserverStub(true);
    expect(categoriesLoadMore).toHaveBeenCalledTimes(1);
  });

  it("does not call loadMore when the observer reports no intersection", () => {
    const categoriesLoadMore = vi.fn();
    setup({
      categories: [makeCategoryView()],
      categoriesPageStatus: "CanLoadMore",
      categoriesLoadMore,
    });

    flushIntersectionObserverStub(false);
    expect(categoriesLoadMore).not.toHaveBeenCalled();
  });

  it("shows a loading status line while LoadingMore and omits the manual Load-more control", () => {
    setup({ categories: [makeCategoryView()], categoriesPageStatus: "LoadingMore" });
    expect(screen.getByRole("status", { name: "Category list" })).toHaveTextContent(
      /loading more categories/i,
    );
    expect(screen.queryByTestId("categories-infinite-scroll-sentinel")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("hides sentinel when exhausted; live region stays without loading copy", () => {
    setup({ categories: [makeCategoryView()], categoriesPageStatus: "Exhausted" });
    expect(screen.queryByTestId("categories-infinite-scroll-sentinel")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Category list" })).not.toHaveTextContent(
      /loading more/i,
    );
  });
});

describe("CircleCategories — capability-gated affordances (CAT-2)", () => {
  it("offers Edit and Archive on a row the server says the viewer may manage", () => {
    setup({ categories: [makeCategoryView()] });
    expect(screen.getByRole("button", { name: "Edit Groceries" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive Groceries" })).toBeInTheDocument();
  });

  it("hides Edit when the server returned canEditFields: false (Owner moderating)", () => {
    setup({ categories: [makeCategoryView({ canEditFields: false, canArchive: true })] });
    expect(screen.queryByRole("button", { name: "Edit Groceries" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive Groceries" })).toBeInTheDocument();
  });

  it("hides both lifecycle affordances for a bystander, but keeps History", () => {
    setup({ categories: [makeCategoryView({ canEditFields: false, canArchive: false })] });
    expect(screen.queryByRole("button", { name: "Edit Groceries" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive Groceries" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "History of Groceries" })).toBeInTheDocument();
  });

  it("hides Edit/Archive on an archived Circle (read-only) but keeps History", () => {
    setup({ circle: { status: "archived" }, categories: [makeCategoryView()] });
    expect(screen.queryByRole("button", { name: "Edit Groceries" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive Groceries" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "History of Groceries" })).toBeInTheDocument();
  });
});

describe("CircleCategories — edit flow (CAT-2)", () => {
  it("opens the inline form prefilled and sends only the changed fields", async () => {
    const user = userEvent.setup();
    setup({ categories: [makeCategoryView()] });

    await user.click(screen.getByRole("button", { name: "Edit Groceries" }));
    const form = screen.getByRole("form", { name: "Edit Groceries" });
    const input = within(form).getByLabelText<HTMLInputElement>("Name");
    expect(input.value).toBe("Groceries");

    await user.clear(input);
    await user.type(input, "Food");
    await user.click(within(form).getByRole("button", { name: "Save" }));

    // Color untouched ⇒ omitted, so the server diff stays a name-only edit.
    expect(updateCategory).toHaveBeenCalledWith({
      categoryId: "cat-groceries",
      name: "Food",
    });
  });

  it("sends only the color when just the swatch changes", async () => {
    const user = userEvent.setup();
    setup({ categories: [makeCategoryView()] });

    await user.click(screen.getByRole("button", { name: "Edit Groceries" }));
    const form = screen.getByRole("form", { name: "Edit Groceries" });
    await user.click(within(form).getByRole("button", { name: "Teal" }));
    await user.click(within(form).getByRole("button", { name: "Save" }));

    expect(updateCategory).toHaveBeenCalledWith({
      categoryId: "cat-groceries",
      color: "teal",
    });
  });

  it("closes without writing when nothing changed", async () => {
    const user = userEvent.setup();
    setup({ categories: [makeCategoryView()] });

    await user.click(screen.getByRole("button", { name: "Edit Groceries" }));
    await user.click(
      within(screen.getByRole("form", { name: "Edit Groceries" })).getByRole("button", {
        name: "Save",
      }),
    );

    expect(updateCategory).not.toHaveBeenCalled();
    expect(screen.queryByRole("form", { name: "Edit Groceries" })).not.toBeInTheDocument();
  });

  it("Cancel closes the form without writing", async () => {
    const user = userEvent.setup();
    setup({ categories: [makeCategoryView()] });

    await user.click(screen.getByRole("button", { name: "Edit Groceries" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(updateCategory).not.toHaveBeenCalled();
    expect(screen.queryByRole("form", { name: "Edit Groceries" })).not.toBeInTheDocument();
  });

  it("surfaces the rename-collision rejection inline and stays open", async () => {
    const user = userEvent.setup();
    setup({ categories: [makeCategoryView()] });
    updateCategory.mockRejectedValueOnce(
      new ConvexError(mutationErrorData(MUTATION_ERRORS.categoryNameDuplicate)),
    );

    await user.click(screen.getByRole("button", { name: "Edit Groceries" }));
    const form = screen.getByRole("form", { name: "Edit Groceries" });
    const input = within(form).getByLabelText("Name");
    await user.clear(input);
    await user.type(input, "Gas");
    await user.click(within(form).getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      MUTATION_ERRORS.categoryNameDuplicate.message,
    );
    expect(screen.getByRole("form", { name: "Edit Groceries" })).toBeInTheDocument();
  });

  it('shows generic save copy when mutation rejects with plain Error("Circle is archived")', async () => {
    const user = userEvent.setup();
    setup({ categories: [makeCategoryView()] });
    updateCategory.mockRejectedValueOnce(new Error("Circle is archived"));

    await user.click(screen.getByRole("button", { name: "Edit Groceries" }));
    const form = screen.getByRole("form", { name: "Edit Groceries" });
    const input = within(form).getByLabelText("Name");
    await user.clear(input);
    await user.type(input, "Food");
    await user.click(within(form).getByRole("button", { name: "Save" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Couldn't save the category/i);
    expect(alert).not.toHaveTextContent(/Circle is archived/);
  });

  it("surfaces ConvexError archived guard on category save inline", async () => {
    const user = userEvent.setup();
    setup({ categories: [makeCategoryView()] });
    updateCategory.mockRejectedValueOnce(
      new ConvexError(mutationErrorData(MUTATION_ERRORS.circleArchived)),
    );

    await user.click(screen.getByRole("button", { name: "Edit Groceries" }));
    const form = screen.getByRole("form", { name: "Edit Groceries" });
    const input = within(form).getByLabelText("Name");
    await user.clear(input);
    await user.type(input, "Food");
    await user.click(within(form).getByRole("button", { name: "Save" }));

    expect(
      await within(form).findByText(MUTATION_ERRORS.circleArchived.message),
    ).toBeInTheDocument();
  });
});

describe("CircleCategories — open row state answers to page membership (regression, PR #93 review)", () => {
  it("does not reopen the editor when a searched-out row returns to the page", async () => {
    const user = userEvent.setup();
    const view = setup({
      categories: [
        makeCategoryView(),
        makeCategoryView({ id: testId<Category["id"]>("c2"), name: "Rent" }),
      ],
    });
    const search = screen.getByLabelText("Search categories by name");

    await user.click(screen.getByRole("button", { name: "Edit Groceries" }));
    expect(screen.getByRole("form", { name: "Edit Groceries" })).toBeInTheDocument();

    // The search narrows the editing row out of the page (the editor unmounts
    // with it — but the stale open-editor id upstream must not survive).
    await user.type(search, "rent");
    await waitFor(() => expect(view.location()).toContain("q=rent"));
    expect(screen.queryByRole("form", { name: "Edit Groceries" })).not.toBeInTheDocument();

    // Widening the filter remounts the row — it must come back CLOSED, not
    // resurrect a fresh editor (which would silently discard the lost draft).
    await user.clear(search);
    await waitFor(() => expect(view.location()).not.toContain("q="));
    expect(screen.getByText("Groceries")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Edit Groceries" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit Groceries" })).toBeInTheDocument();
  });

  it("does not reopen the history panel when a status-filtered row returns", async () => {
    const user = userEvent.setup();
    setup({ categories: mixedRows() });

    await user.click(screen.getByRole("button", { name: "History of Groceries" }));
    expect(screen.getByRole("region", { name: "Groceries history" })).toBeInTheDocument();

    // Scope to archived-only: the active row (and its open panel) leaves the page.
    await user.click(screen.getByRole("button", { name: "Archived" }));
    expect(screen.queryByRole("region", { name: "Groceries history" })).not.toBeInTheDocument();

    // Back under all, the remounted row's panel stays closed.
    await user.click(within(statusGroup()).getByRole("button", { name: "All" }));
    expect(screen.getByText("Groceries")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Groceries history" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "History of Groceries" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("does not carry an open editor across a type-filter switch and back", async () => {
    const user = userEvent.setup();
    setup({
      categories: [
        makeCategoryView(),
        makeCategoryView({ id: testId<Category["id"]>("i1"), name: "Salary", type: "income" }),
      ],
    });

    await user.click(screen.getByRole("button", { name: "Edit Groceries" }));
    expect(screen.getByRole("form", { name: "Edit Groceries" })).toBeInTheDocument();

    // Switch the type segment to Income (drops the Groceries row), then back.
    await user.click(screen.getByRole("button", { name: "Income" }));
    await user.click(screen.getByRole("button", { name: "Expense" }));

    expect(screen.getByText("Groceries")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Edit Groceries" })).not.toBeInTheDocument();
  });
});

describe("CircleCategories — edit mode answers to server capability (regression, PR #88 review)", () => {
  /** Reconfigures the doubled backend mid-test (the reactive query flipping) while
   * keeping this file's mutation spies installed. */
  function reconfigure(categories: Category[]) {
    configureConvex({
      categories,
      createCategory,
      updateCategory,
      archiveCategory,
      restoreCategory,
    });
  }

  it("closes the open editor when the category is archived reactively (default all view)", async () => {
    const user = userEvent.setup();
    const view = setup({ categories: [makeCategoryView()] });

    await user.click(screen.getByRole("button", { name: "Edit Groceries" }));
    expect(screen.getByRole("form", { name: "Edit Groceries" })).toBeInTheDocument();

    // Another Member (the Owner) archives it; the reactive list flips the row
    // in place — under the default all scope it stays visible, frozen.
    reconfigure([makeCategoryView({ status: "archived" })]);
    view.rerender();

    expect(screen.queryByRole("form", { name: "Edit Groceries" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore Groceries" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit Groceries" })).not.toBeInTheDocument();
  });

  it("never resurrects a stale editor: archived while filtered out, re-shown, then restored", async () => {
    const user = userEvent.setup();
    const view = setup({ categories: [makeCategoryView()] });

    // Narrow to active-only so the archive will REMOVE the row (stranding state).
    await user.click(screen.getByRole("button", { name: "Active" }));
    await user.click(screen.getByRole("button", { name: "Edit Groceries" }));
    expect(screen.getByRole("form", { name: "Edit Groceries" })).toBeInTheDocument();

    // Archived reactively while the active filter is on: the row leaves the list,
    // stranding the edit-mode state upstream.
    reconfigure([makeCategoryView({ status: "archived" })]);
    view.rerender();
    expect(screen.queryByRole("form", { name: "Edit Groceries" })).not.toBeInTheDocument();

    // The re-mounted archived row (back under all) must NOT render the stranded editor.
    await user.click(within(statusGroup()).getByRole("button", { name: "All" }));
    expect(screen.queryByRole("form", { name: "Edit Groceries" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore Groceries" })).toBeInTheDocument();

    // Nor may a later restore pop the forgotten editor back open.
    reconfigure([makeCategoryView()]);
    view.rerender();
    expect(screen.queryByRole("form", { name: "Edit Groceries" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit Groceries" })).toBeInTheDocument();
  });

  it("closes the open editor when the Circle archives mid-edit (read-only)", async () => {
    const user = userEvent.setup();
    const view = setup({ categories: [makeCategoryView()] });

    await user.click(screen.getByRole("button", { name: "Edit Groceries" }));
    expect(screen.getByRole("form", { name: "Edit Groceries" })).toBeInTheDocument();

    view.rerender(makeCircleView({ status: "archived" }));

    expect(screen.queryByRole("form", { name: "Edit Groceries" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit Groceries" })).not.toBeInTheDocument();
  });
});

describe("CircleCategories — archive / restore (CAT-2)", () => {
  it("archives a row through the mutation", async () => {
    const user = userEvent.setup();
    setup({ categories: [makeCategoryView()] });

    await archiveWithDoubleCheck(user, "Groceries");

    expect(archiveCategory).toHaveBeenCalledWith({ categoryId: "cat-groceries" });
  });

  it("shows archived rows with a badge and a Restore affordance (default all view)", async () => {
    const user = userEvent.setup();
    setup({ categories: mixedRows() });

    expect(within(rowFor("Old Subscriptions")).getByText("Archived")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Restore Old Subscriptions" }));
    expect(restoreCategory).toHaveBeenCalledWith({ categoryId: "cat-old" });
    // An archived row is frozen: no Edit even for its creator.
    expect(
      screen.queryByRole("button", { name: "Edit Old Subscriptions" }),
    ).not.toBeInTheDocument();
  });

  it("surfaces ConvexError archived guard when archive fails", async () => {
    const user = userEvent.setup();
    setup({ categories: [makeCategoryView()] });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    archiveCategory.mockRejectedValueOnce(
      new ConvexError(mutationErrorData(MUTATION_ERRORS.circleArchived)),
    );

    await archiveWithDoubleCheck(user, "Groceries");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(MUTATION_ERRORS.circleArchived.message);
    expect(consoleError).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Archive Groceries" })).toBeInTheDocument();
    archiveCategory.mockClear();
    await armArchive(user, "Groceries");
    await confirmArchive(user, "Groceries");
    expect(archiveCategory).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it('shows generic archive copy when mutation rejects with plain Error("Circle is archived")', async () => {
    const user = userEvent.setup();
    setup({ categories: [makeCategoryView()] });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    archiveCategory.mockRejectedValueOnce(new Error("Circle is archived"));

    await archiveWithDoubleCheck(user, "Groceries");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Couldn't archive the category/i);
    expect(alert).not.toHaveTextContent(/Circle is archived/);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("requires arm then confirm before archiving a category", async () => {
    const user = userEvent.setup();
    setup({ categories: [makeCategoryView()] });

    await armArchive(user, "Groceries");
    expect(archiveCategory).not.toHaveBeenCalled();
    const armed = screen.getByRole("button", { name: "Confirm archive Groceries" });
    expect(armed).toHaveTextContent("Confirm archive");
    expect(armed).toHaveClass("bg-destructive");

    await confirmArchive(user, "Groceries");
    expect(archiveCategory).toHaveBeenCalledWith({ categoryId: "cat-groceries" });
  });

  it("auto-resets armed archive after the timeout", () => {
    vi.useFakeTimers();
    setup({ categories: [makeCategoryView()] });

    fireEvent.click(screen.getByRole("button", { name: "Archive Groceries" }));
    act(() => {
      vi.advanceTimersByTime(10_001);
    });
    expect(screen.getByRole("button", { name: "Archive Groceries" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Archive Groceries" }));
    expect(archiveCategory).not.toHaveBeenCalled();
  });

  it("resets armed archive on blur", async () => {
    const user = userEvent.setup();
    setup({ categories: [makeCategoryView()] });

    await armArchive(user, "Groceries");
    fireEvent.blur(screen.getByRole("button", { name: "Confirm archive Groceries" }));
    expect(screen.getByRole("button", { name: "Archive Groceries" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Archive Groceries" }));
    expect(archiveCategory).not.toHaveBeenCalled();
  });

  it("resets armed archive on Escape", async () => {
    const user = userEvent.setup();
    setup({ categories: [makeCategoryView()] });

    await armArchive(user, "Groceries");
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Archive Groceries" })).toBeInTheDocument();
  });
});

describe("CircleCategories — history panel (CAT-2)", () => {
  it("expands a row's history newest-first with actor, action, and field changes", async () => {
    const user = userEvent.setup();
    setup({
      categories: [makeCategoryView()],
      categoryHistory: [
        makeHistoryEventView({
          id: testId<CategoryHistoryEvent["id"]>("h2"),
          action: "edited",
          actor: { displayName: "Cleo Creator", image: undefined },
          changes: [
            { field: "name", from: "Food", to: "Groceries" },
            { field: "color", from: "Teal", to: "Green" },
          ],
        }),
        makeHistoryEventView({
          id: testId<CategoryHistoryEvent["id"]>("h1"),
          action: "created",
          changes: [
            { field: "name", to: "Food" },
            { field: "color", to: "Teal" },
          ],
        }),
      ],
    });

    const historyButton = screen.getByRole("button", { name: "History of Groceries" });
    expect(historyButton).toHaveAttribute("aria-expanded", "false");
    await user.click(historyButton);
    expect(historyButton).toHaveAttribute("aria-expanded", "true");

    const panel = screen.getByRole("region", { name: "Groceries history" });
    expect(within(panel).getByText("Cleo Creator")).toBeInTheDocument();
    expect(within(panel).getByText("edited")).toBeInTheDocument();
    // The shared HistoryList renders the Category fields with their labels.
    expect(within(panel).getAllByText("Name:").length).toBeGreaterThan(0);
    expect(within(panel).getAllByText("Color:").length).toBeGreaterThan(0);
    // "Food" appears as the edit's `from` and the create's `to` — both render.
    expect(within(panel).getAllByText("Food")).toHaveLength(2);

    // Collapses again.
    await user.click(historyButton);
    expect(screen.queryByRole("region", { name: "Groceries history" })).not.toBeInTheDocument();
  });

  it("shows the empty history state for a row with no events", async () => {
    const user = userEvent.setup();
    setup({ categories: [makeCategoryView()], categoryHistory: [] });

    await user.click(screen.getByRole("button", { name: "History of Groceries" }));

    const panel = screen.getByRole("region", { name: "Groceries history" });
    expect(within(panel).getByText("No history yet.")).toBeInTheDocument();
  });

  it("keeps a manual Load more control on category history when more pages exist (issue #89)", async () => {
    const user = userEvent.setup();
    const historyLoadMore = vi.fn();
    setup({
      categories: [makeCategoryView()],
      categoryHistory: [makeHistoryEventView()],
      historyStatus: "CanLoadMore",
      historyLoadMore,
    });

    await user.click(screen.getByRole("button", { name: "History of Groceries" }));
    const panel = screen.getByRole("region", { name: "Groceries history" });
    await user.click(within(panel).getByRole("button", { name: "Load more" }));
    expect(historyLoadMore).toHaveBeenCalledTimes(1);
  });
});
