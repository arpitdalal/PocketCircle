import { screen, waitFor } from "@testing-library/react";
import { Route } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Circle, Member, TransactionDetail, TransactionHistoryEvent } from "~/lib/data.js";
import { withReturnTo } from "~/lib/return-to-url.js";
import {
  configureConvex,
  makeCircleView,
  makeHistoryEventView,
  makeTransactionDetailView,
  renderCircleRoutes,
  testId,
} from "~/test/convex-react.js";

const memberId = (slug: string) => testId<Member["id"]>(slug);

/**
 * Behavior test for the Transaction DETAIL object route (jsdom, TXN-4/ADR 0016/0017) — the
 * reference object route. Doubles ONLY Convex's reactive client and runs the REAL route +
 * the REAL `useResolvedTransactionDetail` adapter + the REAL `useResolvedRef` state machine
 * + the REAL `useTransactionHistory` hook under a REAL router, so the detail deep link's
 * resolution (fetch-by-id, stale-slug canonicalization, unavailable fallback) and the
 * rendered Audit Metadata + Transaction History are exercised exactly as in the app.
 */
vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);

import TransactionDetailRoute from "./transaction-detail.js";

const REF = "trip-c1";

const ROUTES = (
  <>
    {/* The fallback / return target; a placeholder is enough to assert the URL landed. */}
    <Route path="circles/:circleRef/transactions" element={<div>ledger</div>} />
    <Route
      path="circles/:circleRef/transactions/:transactionRef"
      element={<TransactionDetailRoute />}
    />
  </>
);

function setup(
  opts: {
    circle?: Partial<Circle>;
    transactionDetail?: TransactionDetail | null | undefined;
    transactionHistory?: ReturnType<typeof makeHistoryEventView>[];
    url?: string;
  } = {},
) {
  const circle = makeCircleView(opts.circle);
  configureConvex({
    transactionDetail: opts.transactionDetail,
    transactionHistory: opts.transactionHistory ?? [],
  });
  const url = opts.url ?? `/circles/${REF}/transactions/weekly-shop-t1`;
  return renderCircleRoutes(circle, ROUTES, { initialEntries: [url] });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("TransactionDetail — resolution", () => {
  it("shows a splash while the detail target resolves", () => {
    setup({ transactionDetail: undefined }); // query still loading
    expect(screen.getByText("Opening transaction…")).toBeInTheDocument();
  });

  it("renders the detail when the target resolves", () => {
    setup({
      transactionDetail: makeTransactionDetailView({ ref: "weekly-shop-t1", title: "Weekly shop" }),
    });
    expect(screen.getByRole("heading", { name: "Weekly shop" })).toBeInTheDocument();
  });

  it("canonicalizes a stale title slug in place", async () => {
    const { location } = setup({
      transactionDetail: makeTransactionDetailView({ ref: "weekly-shop-t1", title: "Weekly shop" }),
      url: `/circles/${REF}/transactions/stale-slug-t1`,
    });
    await waitFor(() => expect(location()).toBe(`/circles/${REF}/transactions/weekly-shop-t1`));
  });

  it("falls back to the ledger and shows the generic snackbar for an unavailable target (anti-enumeration)", async () => {
    const { location } = setup({ transactionDetail: null });
    await waitFor(() => expect(location()).toBe(`/circles/${REF}/transactions`));
    expect(screen.getByText("That link isn't available.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Weekly shop" })).not.toBeInTheDocument();
  });

  it("ejects an unavailable target to the returnTo origin it was opened from", async () => {
    const origin = `/circles/${REF}/search?q=rent&page=2`;
    const { location } = setup({
      transactionDetail: null,
      url: `/circles/${REF}/transactions/weekly-shop-t1?returnTo=${encodeURIComponent(origin)}`,
    });
    await waitFor(() => expect(location()).toBe(origin));
    expect(screen.getByText("That link isn't available.")).toBeInTheDocument();
  });

  it("takes the bad-link path for a malformed ref (an app-emitted bad link)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { location } = setup({ url: `/circles/${REF}/transactions/not-valid!` });
    await waitFor(() => expect(location()).toBe(`/circles/${REF}/transactions`));
    expect(screen.getByText("That link isn't available.")).toBeInTheDocument();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("TransactionDetail — fields & Audit Metadata (PRD 76)", () => {
  it("shows the Transaction fields and the created / last-updated audit, timestamps in UTC", () => {
    setup({
      transactionDetail: makeTransactionDetailView({
        ref: "weekly-shop-t1",
        title: "Weekly shop",
        amountMinorUnits: 1250,
        date: "2026-05-15",
        paidBy: { id: memberId("mem-alex"), displayName: "Alex", image: undefined },
        recordedBy: { id: memberId("mem-you"), displayName: "Olive Owner", image: undefined },
        audit: {
          createdBy: { id: memberId("mem-you"), displayName: "Olive Owner", image: undefined },
          createdAt: Date.UTC(2026, 4, 15, 9, 30),
          updatedBy: { id: memberId("mem-alex"), displayName: "Alex", image: undefined },
          updatedAt: Date.UTC(2026, 4, 16, 14, 5),
        },
      }),
    });

    expect(screen.getByText("-$12.50")).toBeInTheDocument(); // expense, sign + amount
    expect(screen.getByText("2026-05-15")).toBeInTheDocument();

    const audit = screen.getByRole("region", { name: "Audit metadata" });
    expect(audit).toHaveTextContent("Created by");
    expect(audit).toHaveTextContent("Olive Owner");
    expect(audit).toHaveTextContent("Last updated by");
    expect(audit).toHaveTextContent("Alex"); // the last editor
    expect(audit).toHaveTextContent("May 15, 2026");
    expect(audit).toHaveTextContent("May 16, 2026");
    expect(audit).toHaveTextContent("UTC"); // never the viewer timezone
  });
});

describe("TransactionDetail — Transaction History (PRD 77)", () => {
  it("renders the Transaction History list fed by the paginated query", () => {
    setup({
      transactionDetail: makeTransactionDetailView({ ref: "weekly-shop-t1", title: "Weekly shop" }),
      transactionHistory: [
        makeHistoryEventView({
          id: testId<TransactionHistoryEvent["id"]>("h2"),
          action: "edited",
          actor: { displayName: "Olive Owner", image: undefined },
          changes: [{ field: "title", from: "Weekly shop", to: "Renamed shop" }],
        }),
        makeHistoryEventView({
          id: testId<TransactionHistoryEvent["id"]>("h1"),
          action: "created",
          actor: { displayName: "Olive Owner", image: undefined },
          changes: [{ field: "title", to: "Weekly shop" }],
        }),
      ],
    });

    const history = screen.getByRole("region", { name: "History" });
    expect(history).toHaveTextContent("edited");
    expect(history).toHaveTextContent("Renamed shop");
    expect(history).toHaveTextContent("created");
  });

  it("shows the history empty state when the audit has no events yet", () => {
    setup({
      transactionDetail: makeTransactionDetailView({ ref: "weekly-shop-t1", title: "Weekly shop" }),
      transactionHistory: [],
    });
    expect(screen.getByText("No history yet.")).toBeInTheDocument();
  });
});

/** Reads the decoded `returnTo` param off a link's href (issue #123). */
function returnToOf(href: string | null) {
  return new URL(href ?? "", "http://t").searchParams.get("returnTo");
}

describe("TransactionDetail — returnTo origin (Back link)", () => {
  it("returns Back to the exact origin it was opened from, all query state preserved", () => {
    const origin = `/circles/${REF}/search?q=rent&page=2&status=archived`;
    setup({
      transactionDetail: makeTransactionDetailView({ ref: "weekly-shop-t1", title: "Weekly shop" }),
      url: `/circles/${REF}/transactions/weekly-shop-t1?returnTo=${encodeURIComponent(origin)}`,
    });
    expect(screen.getByRole("link", { name: /Back/ })).toHaveAttribute("href", origin);
  });

  it("falls back to the bare ledger when the URL carries no returnTo", () => {
    setup({
      transactionDetail: makeTransactionDetailView({ ref: "weekly-shop-t1", title: "Weekly shop" }),
      url: `/circles/${REF}/transactions/weekly-shop-t1`,
    });
    expect(screen.getByRole("link", { name: /Back/ })).toHaveAttribute(
      "href",
      `/circles/${REF}/transactions`,
    );
  });

  it("falls back to the bare ledger for a tampered (protocol-relative) returnTo — no open redirect", () => {
    setup({
      transactionDetail: makeTransactionDetailView({ ref: "weekly-shop-t1", title: "Weekly shop" }),
      url: `/circles/${REF}/transactions/weekly-shop-t1?returnTo=${encodeURIComponent("//evil.com")}`,
    });
    expect(screen.getByRole("link", { name: /Back/ })).toHaveAttribute(
      "href",
      `/circles/${REF}/transactions`,
    );
  });
});

describe("TransactionDetail — edit affordance (courtesy nav, server enforces)", () => {
  it("offers an Edit link to the recorder carrying THIS detail URL as returnTo, so close returns here", () => {
    const detailUrl = `/circles/${REF}/transactions/weekly-shop-t1?returnTo=${encodeURIComponent(
      `/circles/${REF}/transactions?month=2026-05`,
    )}`;
    setup({
      transactionDetail: makeTransactionDetailView({
        ref: "weekly-shop-t1",
        title: "Weekly shop",
        canEditFields: true,
      }),
      url: detailUrl,
    });
    const edit = screen.getByRole("link", { name: "Edit Weekly shop" });
    expect(new URL(edit.getAttribute("href") ?? "", "http://t").pathname).toBe(
      `/circles/${REF}/transactions/weekly-shop-t1/edit`,
    );
    // The editor's returnTo is the full detail URL (which still carries its own ledger
    // returnTo) — so edit → close lands on detail, and detail's Back still points at the
    // ledger.
    expect(returnToOf(edit.getAttribute("href"))).toBe(detailUrl);
  });

  it("pins the editor's returnTo to the detail with Back on the ledger fallback when opened with no origin", () => {
    setup({
      transactionDetail: makeTransactionDetailView({
        ref: "weekly-shop-t1",
        title: "Weekly shop",
        canEditFields: true,
      }),
      url: `/circles/${REF}/transactions/weekly-shop-t1`,
    });
    // No origin → the detail's own Back resolved to the ledger fallback. The editor's
    // returnTo is the detail page re-built from THAT validated fallback (not the empty raw
    // search), so edit → close lands on detail and Back still points at the ledger.
    expect(
      returnToOf(screen.getByRole("link", { name: "Edit Weekly shop" }).getAttribute("href")),
    ).toBe(
      withReturnTo(`/circles/${REF}/transactions/weekly-shop-t1`, `/circles/${REF}/transactions`),
    );
  });

  it("hides the Edit link from a non-recorder (canEditFields=false)", () => {
    setup({
      transactionDetail: makeTransactionDetailView({
        ref: "weekly-shop-t1",
        title: "Weekly shop",
        canEditFields: false,
      }),
    });
    expect(screen.queryByRole("link", { name: "Edit Weekly shop" })).not.toBeInTheDocument();
  });

  it("hides the Edit link on an archived circle even from the recorder (read-only)", () => {
    setup({
      circle: { status: "archived" },
      transactionDetail: makeTransactionDetailView({
        ref: "weekly-shop-t1",
        title: "Weekly shop",
        canEditFields: true,
      }),
    });
    expect(screen.queryByRole("link", { name: "Edit Weekly shop" })).not.toBeInTheDocument();
  });
});

describe("TransactionDetail — Duplicate action (issue #299)", () => {
  it("offers Duplicate beside Edit for an editable active Transaction", () => {
    const ledger = `/circles/${REF}/transactions?month=2026-05`;
    setup({
      transactionDetail: makeTransactionDetailView({
        ref: "weekly-shop-t1",
        title: "Weekly shop",
        type: "expense",
        canEditFields: true,
      }),
      url: `/circles/${REF}/transactions/weekly-shop-t1?returnTo=${encodeURIComponent(ledger)}`,
    });
    const duplicate = screen.getByRole("link", { name: "Duplicate Weekly shop" });
    const edit = screen.getByRole("link", { name: "Edit Weekly shop" });
    expect(duplicate.compareDocumentPosition(edit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const href = new URL(duplicate.getAttribute("href") ?? "", "http://t");
    expect(href.pathname).toBe("/transactions/new");
    expect(href.searchParams.get("type")).toBe("expense");
    expect(href.searchParams.get("circle")).toBe(REF);
    expect(href.searchParams.get("sourceCircle")).toBe(REF);
    expect(href.searchParams.get("sourceTransaction")).toBe("weekly-shop-t1");
    expect(href.searchParams.get("returnTo")).toBe(
      withReturnTo(`/circles/${REF}/transactions/weekly-shop-t1`, ledger),
    );
  });

  it("keeps Duplicate when Edit is hidden (non-recorder)", () => {
    setup({
      transactionDetail: makeTransactionDetailView({
        ref: "weekly-shop-t1",
        title: "Weekly shop",
        canEditFields: false,
      }),
    });
    expect(screen.getByRole("link", { name: "Duplicate Weekly shop" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Edit Weekly shop" })).not.toBeInTheDocument();
  });

  it("keeps Duplicate for an Archived Transaction", () => {
    setup({
      transactionDetail: makeTransactionDetailView({
        ref: "weekly-shop-t1",
        title: "Weekly shop",
        status: "archived",
        canEditFields: true,
      }),
    });
    expect(screen.getByRole("link", { name: "Duplicate Weekly shop" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Edit Weekly shop" })).not.toBeInTheDocument();
  });

  it("keeps Duplicate in an Archived Circle without a destination Circle param", () => {
    setup({
      circle: { status: "archived", setupComplete: true },
      transactionDetail: makeTransactionDetailView({
        ref: "weekly-shop-t1",
        title: "Weekly shop",
        type: "income",
        canEditFields: true,
      }),
    });
    const href = new URL(
      screen.getByRole("link", { name: "Duplicate Weekly shop" }).getAttribute("href") ?? "",
      "http://t",
    );
    expect(href.searchParams.get("type")).toBe("income");
    expect(href.searchParams.get("circle")).toBeNull();
    expect(href.searchParams.get("sourceCircle")).toBe(REF);
    expect(href.searchParams.get("sourceTransaction")).toBe("weekly-shop-t1");
    expect(screen.queryByRole("link", { name: "Edit Weekly shop" })).not.toBeInTheDocument();
  });
});
