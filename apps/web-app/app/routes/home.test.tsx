import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Circle, HomeSummaryCircle } from "~/lib/data.js";
import { MOCK_CIRCLES } from "~/lib/fixtures.js";
import { RETURN_TO_PARAM } from "~/lib/return-to-url.js";
import {
  configureConvex,
  deferredMutationFn,
  makeActivationChecklistView,
  makeCircleView,
  makeHomeSummaryRecent,
  makeHomeSummaryView,
  renderRoutes,
  renderWithRouter,
  testId,
} from "~/test/convex-react.js";
import { getHeadlineMoney, queryHeadlineMoney } from "~/test/money.js";

vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);

import Home from "./home.js";

afterEach(() => {
  vi.clearAllMocks();
});

function renderHome() {
  return renderWithRouter(<Home />);
}

const HOME_ROUTES = <Route path="/" element={<Home />} />;

function setupHome(initialSearch = "") {
  return renderRoutes(HOME_ROUTES, { initialEntries: [`/${initialSearch}`] });
}

function cashFlowTotals() {
  return within(screen.getByRole("group", { name: "Cash flow totals" }));
}

function makeScopeCircle(
  over: Partial<HomeSummaryCircle> & Pick<HomeSummaryCircle, "id" | "name">,
): HomeSummaryCircle {
  return {
    ref: "trip-c1",
    kind: "regular",
    currency: "USD",
    status: "active",
    included: true,
    ...over,
  };
}

describe("Home (loading)", () => {
  it("shows loading shell before circles and summary resolve", () => {
    configureConvex({ circles: undefined, homeSummary: undefined });
    renderHome();
    expect(screen.getByRole("heading", { name: "Home" })).toBeInTheDocument();
    expect(screen.getByText("Loading home…")).toBeInTheDocument();
    expect(screen.queryByText("Net cash flow")).not.toBeInTheDocument();
    expect(screen.queryByText(/circles$/i)).not.toBeInTheDocument();
  });
});

describe("Home (loaded)", () => {
  it("renders Home, then Get started, Cash flow, then Your circles", () => {
    configureConvex({
      circles: MOCK_CIRCLES,
      homeSummary: makeHomeSummaryView(),
      activation: makeActivationChecklistView(),
    });
    renderHome();
    const names = screen.getAllByRole("heading").map((h) => h.textContent);
    expect(names.indexOf("Home")).toBeLessThan(names.indexOf("Get started"));
    expect(names.indexOf("Get started")).toBeLessThan(names.indexOf("Cash flow"));
    expect(names.indexOf("Cash flow")).toBeLessThan(names.indexOf("Your circles"));
    expect(screen.getByRole("region", { name: "Cash flow" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Your circles" })).toBeInTheDocument();
  });

  it("shows the secondary Create circle link", () => {
    configureConvex({
      circles: MOCK_CIRCLES,
      homeSummary: makeHomeSummaryView(),
    });
    renderHome();
    expect(screen.getByRole("link", { name: "Create circle" })).toHaveAttribute(
      "href",
      "/circles/new",
    );
  });

  it("shows one persistent primary Add transaction action carrying the exact Home origin", () => {
    configureConvex({
      circles: MOCK_CIRCLES,
      homeSummary: makeHomeSummaryView({ selectedCurrency: "CAD", range: 3 }),
      activation: makeActivationChecklistView(),
    });
    setupHome("?currency=CAD&range=3");
    const url = new URL(
      screen.getByRole("link", { name: "Add transaction" }).getAttribute("href") ?? "",
      "http://t",
    );
    expect(url.pathname).toBe("/transactions/new");
    expect(url.searchParams.get("type")).toBe("expense");
    expect(url.searchParams.get(RETURN_TO_PARAM)).toBe("/?currency=CAD&range=3");
  });

  it("keeps the Add transaction action while the summary is still loading", () => {
    configureConvex({ circles: MOCK_CIRCLES, homeSummary: undefined });
    renderRoutes(HOME_ROUTES, { initialEntries: ["/?currency=CAD&range=3"] });
    expect(screen.getByText("Loading home…")).toBeInTheDocument();
    const url = new URL(
      screen.getByRole("link", { name: "Add transaction" }).getAttribute("href") ?? "",
      "http://t",
    );
    expect(url.pathname).toBe("/transactions/new");
    expect(url.searchParams.get(RETURN_TO_PARAM)).toBe("/?currency=CAD&range=3");
  });

  it("displays range-wide totals: Income, Expenses, Net cash flow", () => {
    configureConvex({
      circles: MOCK_CIRCLES,
      homeSummary: makeHomeSummaryView({
        totals: { incomeMinor: 500000, expenseMinor: 300000, netMinor: 200000 },
      }),
    });
    renderHome();
    const totals = cashFlowTotals();
    expect(
      getHeadlineMoney(within(totals.getByRole("group", { name: "Income" })), "$5,000.00"),
    ).toBeInTheDocument();
    expect(
      getHeadlineMoney(within(totals.getByRole("group", { name: "Expenses" })), "$3,000.00"),
    ).toBeInTheDocument();
    expect(
      getHeadlineMoney(within(totals.getByRole("group", { name: "Net cash flow" })), "$2,000.00"),
    ).toBeInTheDocument();
  });

  it("shows scope text with currency, included, and available counts", () => {
    configureConvex({
      circles: MOCK_CIRCLES,
      homeSummary: makeHomeSummaryView({
        selectedCurrency: "CAD",
        includedCount: 2,
        availableCount: 3,
      }),
    });
    renderHome();
    expect(screen.getByText(/CAD · 2 of 3 circles/)).toBeInTheDocument();
  });

  it("shows a Circles multi-select with included Circles as chips", () => {
    configureConvex({
      circles: MOCK_CIRCLES,
      homeSummary: makeHomeSummaryView(),
    });
    renderHome();
    expect(screen.getByRole("combobox", { name: "Circles" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Trip" })).toBeInTheDocument();
  });
});

describe("Home (zero included)", () => {
  it("shows zero-included empty state and keeps the Circles multi-select", () => {
    configureConvex({
      circles: MOCK_CIRCLES,
      homeSummary: makeHomeSummaryView({
        includedCount: 0,
        availableCount: 2,
        circles: [makeScopeCircle({ id: testId("c1"), name: "Trip", included: false })],
      }),
    });
    renderHome();
    expect(screen.getByText(/No circles included in this USD scope/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Circles" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove Trip" })).not.toBeInTheDocument();
  });
});

describe("Home (no transactions)", () => {
  it("distinguishes no transactions truthfully", () => {
    configureConvex({
      circles: MOCK_CIRCLES,
      homeSummary: makeHomeSummaryView({ recent: [], includedCount: 1 }),
    });
    renderHome();
    expect(screen.getByText(/No transactions in the selected .+ scope yet/)).toBeInTheDocument();
  });
});

describe("Home (CashFlowTrend accessibility)", () => {
  it("renders an sr-only data table for the chart", () => {
    configureConvex({
      circles: MOCK_CIRCLES,
      homeSummary: makeHomeSummaryView({
        series: [{ month: "2026-08", incomeMinor: 1000, expenseMinor: 500, netMinor: 500 }],
      }),
    });
    renderHome();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Month" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Income" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Expense" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Net" })).toBeInTheDocument();
  });
});

describe("Home (contributions and recent drilldowns)", () => {
  it("contribution links to the canonical Circle Dashboard", () => {
    configureConvex({
      circles: MOCK_CIRCLES,
      homeSummary: makeHomeSummaryView({
        contributions: [
          {
            circleId: testId("c1"),
            circleRef: "trip-c1",
            name: "Trip",
            kind: "regular",
            incomeMinor: 100,
            expenseMinor: 50,
            netMinor: 50,
          },
        ],
      }),
    });
    renderHome();
    expect(
      within(screen.getByRole("region", { name: "Per-Circle contribution" })).getByRole("link", {
        name: /Trip/,
      }),
    ).toHaveAttribute("href", "/circles/trip-c1");
  });

  it("recent transaction links include exact returnTo with currency/range", () => {
    configureConvex({
      circles: MOCK_CIRCLES,
      homeSummary: makeHomeSummaryView({
        selectedCurrency: "CAD",
        range: 3,
        recent: [makeHomeSummaryRecent()],
      }),
    });
    setupHome("?currency=CAD&range=3");
    const href =
      within(screen.getByRole("region", { name: "Recent transactions" }))
        .getByRole("link", { name: /Rent/ })
        .getAttribute("href") ?? "";
    expect(href).toContain("/circles/trip-c1/transactions/rent-t1");
    expect(new URL(href, "http://t").searchParams.get(RETURN_TO_PARAM)).toBe(
      "/?currency=CAD&range=3",
    );
  });
});

describe("Home (Circle cards)", () => {
  it("renders active and archived circles separately", () => {
    configureConvex({
      circles: [
        makeCircleView({
          id: testId<Circle["id"]>("c0"),
          ref: "personal-c0",
          name: "Personal",
          kind: "personal",
        }),
        makeCircleView({ id: testId<Circle["id"]>("c1"), ref: "trip-c1", name: "Trip" }),
        makeCircleView({
          id: testId<Circle["id"]>("c2"),
          ref: "old-c2",
          name: "Old Trip",
          status: "archived",
        }),
      ],
      homeSummary: makeHomeSummaryView(),
    });
    renderHome();
    expect(screen.getByRole("heading", { name: "Your circles" })).toBeInTheDocument();
    expect(screen.getByText("Archived")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Old Trip.*Archived/ })).toBeInTheDocument();
  });
});

describe("Home (no forbidden UI)", () => {
  it("does not render global search, category analytics, balance/share language", () => {
    configureConvex({
      circles: MOCK_CIRCLES,
      homeSummary: makeHomeSummaryView(),
    });
    renderHome();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.queryByText(/category analytics/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/balance/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/share/i)).not.toBeInTheDocument();
  });
});

describe("Home (ActivationChecklist on Home only)", () => {
  it("shows the checklist when visible", () => {
    configureConvex({
      circles: MOCK_CIRCLES,
      homeSummary: makeHomeSummaryView(),
      activation: makeActivationChecklistView(),
    });
    renderHome();
    expect(screen.getByRole("heading", { name: "Get started" })).toBeInTheDocument();
  });

  it("hides the checklist when not visible", () => {
    configureConvex({
      circles: MOCK_CIRCLES,
      homeSummary: makeHomeSummaryView(),
      activation: makeActivationChecklistView({ visible: false }),
    });
    renderHome();
    expect(screen.queryByRole("heading", { name: "Get started" })).not.toBeInTheDocument();
  });
});

describe("Home (circle scope)", () => {
  it("lists Circles with currency and selected state in the searchable picker", async () => {
    const user = userEvent.setup();
    configureConvex({
      circles: MOCK_CIRCLES,
      homeSummary: makeHomeSummaryView({
        circles: [
          makeScopeCircle({ id: testId("c1"), name: "Trip" }),
          makeScopeCircle({
            id: testId("c2"),
            ref: "euro-c2",
            name: "Euro Circle",
            currency: "EUR",
            included: false,
          }),
        ],
      }),
    });
    renderHome();
    expect(screen.getByRole("button", { name: "Remove Trip" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove Euro Circle" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Circles" }));
    expect(screen.getByRole("option", { name: /Trip/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: /Trip/ })).toHaveTextContent("USD");
    expect(screen.getByRole("option", { name: /Euro Circle/ })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    expect(screen.getByRole("option", { name: /Euro Circle/ })).toHaveTextContent("EUR");
  });

  it("marks archived circles", async () => {
    const user = userEvent.setup();
    configureConvex({
      circles: MOCK_CIRCLES,
      homeSummary: makeHomeSummaryView({
        circles: [makeScopeCircle({ id: testId("c1"), name: "Old", status: "archived" })],
      }),
    });
    renderHome();
    await user.click(screen.getByRole("combobox", { name: "Circles" }));
    expect(screen.getByRole("option", { name: /Old/ })).toHaveTextContent("Archived");
  });

  it("filters Circles by name in the picker", async () => {
    const user = userEvent.setup();
    configureConvex({
      circles: MOCK_CIRCLES,
      homeSummary: makeHomeSummaryView({
        includedCount: 0,
        circles: [
          makeScopeCircle({ id: testId("c1"), name: "Trip", included: false }),
          makeScopeCircle({
            id: testId("c2"),
            ref: "euro-c2",
            name: "Euro Circle",
            currency: "EUR",
            included: false,
          }),
        ],
      }),
    });
    renderHome();
    await user.click(screen.getByRole("combobox", { name: "Circles" }));
    await user.type(screen.getByRole("combobox", { name: "Circles" }), "Euro");
    expect(screen.getByRole("option", { name: /Euro Circle/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Trip/ })).not.toBeInTheDocument();
  });

  it("persists an exclusion through the excludeCircle mutation", async () => {
    const user = userEvent.setup();
    const excludeCircle = vi.fn().mockResolvedValue(undefined);
    configureConvex({
      circles: MOCK_CIRCLES,
      excludeCircle,
      homeSummary: makeHomeSummaryView({
        circles: [makeScopeCircle({ id: testId("c1"), name: "Trip" })],
      }),
    });
    renderHome();
    await user.click(screen.getByRole("button", { name: "Remove Trip" }));
    expect(excludeCircle).toHaveBeenCalledWith({ circleId: testId("c1") });
  });

  it("persists a re-inclusion through the includeCircle mutation", async () => {
    const user = userEvent.setup();
    const includeCircle = vi.fn().mockResolvedValue(undefined);
    configureConvex({
      circles: MOCK_CIRCLES,
      includeCircle,
      homeSummary: makeHomeSummaryView({
        circles: [makeScopeCircle({ id: testId("c1"), name: "Trip", included: false })],
      }),
    });
    renderHome();
    await user.click(screen.getByRole("combobox", { name: "Circles" }));
    await user.click(await screen.findByRole("option", { name: /Trip/ }));
    expect(includeCircle).toHaveBeenCalledWith({ circleId: testId("c1") });
  });

  it("keeps the included chip while includeCircle is in flight", async () => {
    const user = userEvent.setup();
    const includeCircle = deferredMutationFn<void>();
    configureConvex({
      circles: MOCK_CIRCLES,
      includeCircle: includeCircle.fn,
      homeSummary: makeHomeSummaryView({
        circles: [makeScopeCircle({ id: testId("c1"), name: "Trip", included: false })],
      }),
    });
    renderHome();
    await user.click(screen.getByRole("combobox", { name: "Circles" }));
    await user.click(await screen.findByRole("option", { name: /Trip/ }));
    expect(includeCircle.fn).toHaveBeenCalledWith({ circleId: testId("c1") });
    expect(screen.getByRole("combobox", { name: "Circles" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Remove Trip", hidden: true })).toBeInTheDocument();
    includeCircle.resolve();
  });

  it("persists a later selection after an in-flight includeCircle completes", async () => {
    const user = userEvent.setup();
    const includeCircle = deferredMutationFn<void>();
    const excludeCircle = vi.fn().mockResolvedValue(undefined);
    configureConvex({
      circles: MOCK_CIRCLES,
      includeCircle: includeCircle.fn,
      excludeCircle,
      homeSummary: makeHomeSummaryView({
        circles: [
          makeScopeCircle({ id: testId("c1"), name: "Trip", included: false }),
          makeScopeCircle({ id: testId("c2"), name: "Cabin", included: true }),
        ],
      }),
    });
    renderHome();
    await user.click(screen.getByRole("combobox", { name: "Circles" }));
    await user.click(await screen.findByRole("option", { name: /Trip/ }));
    expect(includeCircle.fn).toHaveBeenCalledWith({ circleId: testId("c1") });
    await user.click(screen.getByRole("button", { name: "Remove Cabin", hidden: true }));
    expect(excludeCircle).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Remove Cabin", hidden: true }),
    ).not.toBeInTheDocument();
    includeCircle.resolve();
    await waitFor(() => expect(excludeCircle).toHaveBeenCalledWith({ circleId: testId("c2") }));
  });

  it("surfaces a scope-update failure without changing Circle cards", async () => {
    const user = userEvent.setup();
    configureConvex({
      circles: MOCK_CIRCLES,
      excludeCircle: vi.fn().mockRejectedValue(new Error("unavailable")),
      homeSummary: makeHomeSummaryView({
        circles: [makeScopeCircle({ id: testId("c1"), name: "Trip" })],
      }),
    });
    renderHome();
    await user.click(screen.getByRole("button", { name: "Remove Trip" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Couldn't update Trip/);
    expect(screen.getByRole("region", { name: "Your circles" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Mock's Circle/ })).toBeInTheDocument();
  });
});

describe("Home (URL state)", () => {
  it("canonicalizes a bare URL to the resolved Personal Currency and omits default range", async () => {
    configureConvex({
      circles: MOCK_CIRCLES,
      homeSummary: makeHomeSummaryView({ selectedCurrency: "USD", range: 1 }),
    });
    const view = setupHome();
    await waitFor(() => expect(view.location()).toBe("/?currency=USD"));
  });

  it("restores currency and range from the URL and queries with them", () => {
    configureConvex({
      circles: MOCK_CIRCLES,
      homeSummary: (args) =>
        args.currency === "CAD" && args.range === 3
          ? makeHomeSummaryView({
              selectedCurrency: "CAD",
              availableCurrencies: ["CAD", "USD"],
              range: 3,
              totals: { incomeMinor: 0, expenseMinor: 4200, netMinor: -4200 },
            })
          : makeHomeSummaryView(),
    });
    setupHome("?currency=CAD&range=3");
    expect(screen.getByRole("button", { name: "CAD", pressed: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "3 mo", pressed: true })).toBeInTheDocument();
    expect(getHeadlineMoney(cashFlowTotals(), "-CA$42.00")).toBeInTheDocument();
  });

  it("writes range to the URL, drops it at the default, and walks Back/Forward", async () => {
    const user = userEvent.setup();
    configureConvex({
      circles: MOCK_CIRCLES,
      homeSummary: (args) =>
        args.range === 3
          ? makeHomeSummaryView({
              selectedCurrency: "USD",
              range: 3,
              totals: { incomeMinor: 80000, expenseMinor: 10000, netMinor: 70000 },
              series: [
                { month: "2026-06", incomeMinor: 10000, expenseMinor: 0, netMinor: 10000 },
                { month: "2026-07", incomeMinor: 20000, expenseMinor: 0, netMinor: 20000 },
                { month: "2026-08", incomeMinor: 50000, expenseMinor: 10000, netMinor: 40000 },
              ],
            })
          : makeHomeSummaryView({
              selectedCurrency: "USD",
              range: 1,
              totals: { incomeMinor: 50000, expenseMinor: 10000, netMinor: 40000 },
              series: [
                { month: "2026-08", incomeMinor: 50000, expenseMinor: 10000, netMinor: 40000 },
              ],
            }),
    });
    const view = setupHome("?currency=USD");
    expect(getHeadlineMoney(cashFlowTotals(), "$500.00")).toBeInTheDocument();
    expect(getHeadlineMoney(cashFlowTotals(), "$400.00")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "3 mo" }));
    await waitFor(() => expect(view.location()).toBe("/?currency=USD&range=3"));
    expect(getHeadlineMoney(cashFlowTotals(), "$800.00")).toBeInTheDocument();
    expect(getHeadlineMoney(cashFlowTotals(), "$700.00")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(4);

    await view.navigate(-1);
    await waitFor(() => expect(view.location()).toBe("/?currency=USD"));
    expect(getHeadlineMoney(cashFlowTotals(), "$500.00")).toBeInTheDocument();
    expect(getHeadlineMoney(cashFlowTotals(), "$400.00")).toBeInTheDocument();

    await view.navigate(1);
    await waitFor(() => expect(view.location()).toBe("/?currency=USD&range=3"));
    expect(getHeadlineMoney(cashFlowTotals(), "$800.00")).toBeInTheDocument();
    expect(getHeadlineMoney(cashFlowTotals(), "$700.00")).toBeInTheDocument();
  });

  it("switches Currency without combining totals", async () => {
    const user = userEvent.setup();
    const currencies = ["EUR", "USD"];
    configureConvex({
      circles: MOCK_CIRCLES,
      homeSummary: (args) =>
        args.currency === "EUR"
          ? makeHomeSummaryView({
              selectedCurrency: "EUR",
              availableCurrencies: currencies,
              totals: { incomeMinor: 111, expenseMinor: 22, netMinor: 89 },
            })
          : makeHomeSummaryView({
              selectedCurrency: "USD",
              availableCurrencies: currencies,
              totals: { incomeMinor: 99900, expenseMinor: 100, netMinor: 99800 },
            }),
    });
    const view = setupHome("?currency=USD");
    expect(getHeadlineMoney(cashFlowTotals(), "$999.00")).toBeInTheDocument();
    expect(queryHeadlineMoney(screen, "€1.11")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "EUR" }));
    await waitFor(() => expect(view.location()).toBe("/?currency=EUR"));
    expect(getHeadlineMoney(cashFlowTotals(), "€1.11")).toBeInTheDocument();
    expect(queryHeadlineMoney(screen, "$999.00")).not.toBeInTheDocument();
  });

  it("does not canonicalize from a stale summary while the next currency is loading", async () => {
    const user = userEvent.setup();
    configureConvex({
      circles: MOCK_CIRCLES,
      homeSummary: (args) => {
        // EUR never resolves — models the Convex arg-change `undefined` gap.
        if (args.currency === "EUR") return undefined;
        return makeHomeSummaryView({
          selectedCurrency: "USD",
          availableCurrencies: ["USD", "EUR"],
          totals: { incomeMinor: 99900, expenseMinor: 100, netMinor: 99800 },
        });
      },
    });
    const view = setupHome("?currency=USD");
    expect(getHeadlineMoney(cashFlowTotals(), "$999.00")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "EUR" }));
    await waitFor(() => {
      expect(view.location()).toBe("/?currency=EUR");
      expect(screen.getByRole("button", { name: "EUR", pressed: true })).toBeInTheDocument();
    });
    // Stale USD totals stay mounted; URL must not be rewritten back to USD.
    expect(getHeadlineMoney(cashFlowTotals(), "$999.00")).toBeInTheDocument();
    await waitFor(() => expect(view.location()).toBe("/?currency=EUR"));
  });

  it("keeps the pending currency when Range changes before the currency query resolves", async () => {
    const user = userEvent.setup();
    configureConvex({
      circles: MOCK_CIRCLES,
      homeSummary: (args) => {
        if (args.currency === "EUR") return undefined;
        return makeHomeSummaryView({
          selectedCurrency: "USD",
          availableCurrencies: ["USD", "EUR"],
          range: 1,
          totals: { incomeMinor: 99900, expenseMinor: 100, netMinor: 99800 },
        });
      },
    });
    const view = setupHome("?currency=USD");
    await user.click(screen.getByRole("button", { name: "EUR" }));
    await waitFor(() => expect(view.location()).toBe("/?currency=EUR"));
    await user.click(screen.getByRole("button", { name: "3 mo" }));
    await waitFor(() => expect(view.location()).toBe("/?currency=EUR&range=3"));
  });

  it("uses an accessible Currency select past four Currencies", async () => {
    const user = userEvent.setup();
    const currencies = ["AUD", "CAD", "EUR", "GBP", "USD"];
    configureConvex({
      circles: MOCK_CIRCLES,
      homeSummary: (args) =>
        makeHomeSummaryView({
          selectedCurrency: args.currency === "GBP" ? "GBP" : "USD",
          availableCurrencies: currencies,
          totals:
            args.currency === "GBP"
              ? { incomeMinor: 3300, expenseMinor: 400, netMinor: 2900 }
              : { incomeMinor: 1100, expenseMinor: 200, netMinor: 900 },
        }),
    });
    const view = setupHome("?currency=USD");
    const select = screen.getByRole("combobox", { name: "Currency" });
    expect(select).toHaveValue("USD");
    expect(screen.queryByRole("button", { name: "USD" })).not.toBeInTheDocument();
    expect(getHeadlineMoney(cashFlowTotals(), "$11.00")).toBeInTheDocument();
    expect(getHeadlineMoney(cashFlowTotals(), "$9.00")).toBeInTheDocument();

    await user.selectOptions(select, "GBP");
    await waitFor(() => expect(view.location()).toBe("/?currency=GBP"));
    expect(getHeadlineMoney(cashFlowTotals(), "£33.00")).toBeInTheDocument();
    expect(getHeadlineMoney(cashFlowTotals(), "£29.00")).toBeInTheDocument();
    expect(queryHeadlineMoney(cashFlowTotals(), "$11.00")).not.toBeInTheDocument();
  });

  it("canonicalizes an invalid range and preserves foreign params", async () => {
    configureConvex({
      circles: MOCK_CIRCLES,
      homeSummary: makeHomeSummaryView({ selectedCurrency: "USD", range: 1 }),
    });
    const view = setupHome("?range=2&utm=campaign");
    await waitFor(() => expect(view.location()).toBe("/?utm=campaign&currency=USD"));
    expect(screen.getByRole("button", { name: "1 mo", pressed: true })).toBeInTheDocument();
  });
});
