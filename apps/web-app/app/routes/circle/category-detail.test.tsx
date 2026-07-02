import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CategoryDetail, CategoryHistoryEvent, Transaction } from "~/lib/data.js";
import {
  configureConvex,
  makeCategoryDetailView,
  makeCircleView,
  makeHistoryEventView,
  makeTransactionView,
  renderCircleRoutes,
  testId,
} from "~/test/convex-react.js";

vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);

import CategoryDetailRoute from "./category-detail.js";

const REF = "trip-c1";
const CATEGORY_REF = "groceries-catgroceries";

const ROUTES = (
  <>
    <Route path="circles/:circleRef/categories" element={<div>categories list</div>} />
    <Route path="circles/:circleRef/search" element={<div>search</div>} />
    <Route
      path="circles/:circleRef/transactions/:transactionRef"
      element={<div>transaction detail</div>}
    />
    <Route path="circles/:circleRef/categories/:categoryRef" element={<CategoryDetailRoute />} />
  </>
);

function setup(
  opts: {
    circle?: Parameters<typeof makeCircleView>[0];
    categoryDetail?: CategoryDetail | null | undefined;
    categoryHistory?: ReturnType<typeof makeHistoryEventView>[];
    recentCategoryTransactions?: Transaction[];
    url?: string;
  } = {},
) {
  const circle = makeCircleView(opts.circle);
  configureConvex({
    categoryDetail: opts.categoryDetail,
    categoryHistory: opts.categoryHistory ?? [],
    recentCategoryTransactions: opts.recentCategoryTransactions ?? [],
  });
  const url = opts.url ?? `/circles/${REF}/categories/${CATEGORY_REF}`;
  return renderCircleRoutes(circle, ROUTES, { initialEntries: [url] });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("CategoryDetail — resolution", () => {
  it("shows a splash while the detail target resolves", () => {
    setup({ categoryDetail: undefined });
    expect(screen.getByText("Opening category…")).toBeInTheDocument();
  });

  it("renders the detail when the target resolves", () => {
    setup({
      categoryDetail: makeCategoryDetailView({ ref: CATEGORY_REF, name: "Groceries" }),
    });
    expect(screen.getByRole("heading", { name: "Groceries" })).toBeInTheDocument();
  });

  it("canonicalizes a stale name slug in place", async () => {
    const { location } = setup({
      categoryDetail: makeCategoryDetailView({ ref: CATEGORY_REF, name: "Groceries" }),
      url: `/circles/${REF}/categories/stale-slug-catgroceries`,
    });
    await waitFor(() => expect(location()).toBe(`/circles/${REF}/categories/${CATEGORY_REF}`));
  });

  it("falls back to the categories list and shows the generic snackbar for an unavailable target", async () => {
    const { location } = setup({ categoryDetail: null });
    await waitFor(() => expect(location()).toBe(`/circles/${REF}/categories`));
    expect(screen.getByText("That link isn't available.")).toBeInTheDocument();
  });

  it("ejects an unavailable target to the returnTo origin it was opened from", async () => {
    const origin = `/circles/${REF}/search?q=rent`;
    const { location } = setup({
      categoryDetail: null,
      url: `/circles/${REF}/categories/${CATEGORY_REF}?returnTo=${encodeURIComponent(origin)}`,
    });
    await waitFor(() => expect(location()).toBe(origin));
    expect(screen.getByText("That link isn't available.")).toBeInTheDocument();
  });
});

describe("CategoryDetail — fields", () => {
  it("shows name, type, creator, and archived badge when relevant", () => {
    setup({
      categoryDetail: makeCategoryDetailView({
        ref: CATEGORY_REF,
        name: "Old Subscriptions",
        type: "expense",
        status: "archived",
        creator: { displayName: "Cleo Creator", image: undefined },
      }),
    });

    expect(screen.getByRole("heading", { name: "Old Subscriptions" })).toBeInTheDocument();
    expect(screen.getByText("expense")).toBeInTheDocument();
    expect(screen.getByText("Cleo Creator")).toBeInTheDocument();
    expect(screen.getByText("Archived")).toBeInTheDocument();
  });
});

describe("CategoryDetail — edit and lifecycle affordances", () => {
  it("shows Edit for an active category the viewer may field-edit", async () => {
    const user = userEvent.setup();
    setup({
      categoryDetail: makeCategoryDetailView({
        ref: CATEGORY_REF,
        name: "Groceries",
        canEditFields: true,
        status: "active",
      }),
    });

    await user.click(screen.getByRole("button", { name: "Edit Groceries" }));
    expect(screen.getByRole("form", { name: "Edit Groceries" })).toBeInTheDocument();
  });

  it("hides Edit when canEditFields is false", () => {
    setup({
      categoryDetail: makeCategoryDetailView({
        ref: CATEGORY_REF,
        name: "Groceries",
        canEditFields: false,
      }),
    });
    expect(screen.queryByRole("button", { name: "Edit Groceries" })).not.toBeInTheDocument();
  });

  it("shows Archive when the viewer may manage lifecycle", () => {
    setup({
      categoryDetail: makeCategoryDetailView({
        ref: CATEGORY_REF,
        name: "Groceries",
        canArchive: true,
        status: "active",
      }),
    });
    expect(screen.getByRole("button", { name: "Archive Groceries" })).toBeInTheDocument();
  });

  it("shows Restore on an archived category the viewer may manage", () => {
    setup({
      categoryDetail: makeCategoryDetailView({
        ref: CATEGORY_REF,
        name: "Groceries",
        canArchive: true,
        status: "archived",
      }),
    });
    expect(screen.getByRole("button", { name: "Restore Groceries" })).toBeInTheDocument();
  });
});

describe("CategoryDetail — recent transactions and search CTA", () => {
  it("renders recent transactions and links each to transaction detail", () => {
    const txn = makeTransactionView({ ref: "weekly-shop-t1", title: "Weekly shop" });
    setup({
      categoryDetail: makeCategoryDetailView({ ref: CATEGORY_REF, name: "Groceries" }),
      recentCategoryTransactions: [txn],
      url: `/circles/${REF}/categories/${CATEGORY_REF}?returnTo=${encodeURIComponent(`/circles/${REF}/categories`)}`,
    });

    const link = screen.getByRole("link", { name: "View Weekly shop" });
    expect(link).toHaveAttribute(
      "href",
      expect.stringContaining(`/circles/${REF}/transactions/weekly-shop-t1`),
    );
  });

  it("points the all-matching CTA at all-time Transaction Search for this category", () => {
    const categoryId = testId<CategoryDetail["id"]>("catgroceries");
    setup({
      categoryDetail: makeCategoryDetailView({
        id: categoryId,
        ref: CATEGORY_REF,
        name: "Groceries",
        type: "expense",
      }),
    });

    const cta = screen.getByRole("link", { name: "View all matching transactions" });
    const url = new URL(cta.getAttribute("href") ?? "", "http://t");
    expect(url.pathname).toBe(`/circles/${REF}/search`);
    expect(url.searchParams.get("type")).toBe("expense");
    expect(url.searchParams.get("status")).toBe("all");
    expect(url.searchParams.get("categories")).toBe(categoryId);
    expect(url.searchParams.get("from")).toBeNull();
    expect(url.searchParams.get("to")).toBeNull();
  });
});

describe("CategoryDetail — Category History", () => {
  it("renders the Category History list", () => {
    setup({
      categoryDetail: makeCategoryDetailView({ ref: CATEGORY_REF, name: "Groceries" }),
      categoryHistory: [
        makeHistoryEventView({
          id: testId<CategoryHistoryEvent["id"]>("h1"),
          action: "created",
          actor: { displayName: "You", image: undefined },
          changes: [{ field: "name", to: "Groceries" }],
        }),
      ],
    });

    expect(screen.getByRole("region", { name: "Groceries history" })).toHaveTextContent("created");
  });
});

describe("CategoryDetail — returnTo origin (Back link)", () => {
  it("returns Back to the exact origin it was opened from", () => {
    const origin = `/circles/${REF}/categories?type=expense&status=active`;
    setup({
      categoryDetail: makeCategoryDetailView({ ref: CATEGORY_REF, name: "Groceries" }),
      url: `/circles/${REF}/categories/${CATEGORY_REF}?returnTo=${encodeURIComponent(origin)}`,
    });
    expect(screen.getByRole("link", { name: /Back/ })).toHaveAttribute("href", origin);
  });

  it("falls back to the bare categories list when returnTo is absent", () => {
    setup({
      categoryDetail: makeCategoryDetailView({ ref: CATEGORY_REF, name: "Groceries" }),
    });
    expect(screen.getByRole("link", { name: /Back/ })).toHaveAttribute(
      "href",
      `/circles/${REF}/categories`,
    );
  });
});
