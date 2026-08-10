import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaginationStatus } from "~/lib/data.js";
import { type HistoryEventLike, HistoryList } from "./history-list.js";

/**
 * Unit test for the shared HistoryList (TXN-4). It renders a frozen, ID-free audit, so
 * the test drives it with already-display-safe event values (the contract the backend
 * guarantees) and asserts the presentation: newest-first order, actor + action + field
 * labels, money formatted in the viewer locale from typed values, and the loading / empty
 * / load-more read states.
 */
function renderList(
  events: HistoryEventLike[],
  opts: { status?: PaginationStatus; loadMore?: () => void } = {},
) {
  return render(
    <HistoryList
      events={events}
      status={opts.status ?? "Exhausted"}
      loadMore={opts.loadMore ?? (() => {})}
    />,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("HistoryList — content", () => {
  it("renders events in the given (newest-first) order with actor, action verb, and field changes", () => {
    renderList([
      {
        id: "h2",
        action: "edited",
        createdAt: Date.UTC(2026, 4, 16, 14, 5),
        actor: { displayName: "Olive Owner" },
        changes: [{ field: "title", from: "Weekly shop", to: "Renamed shop" }],
      },
      {
        id: "h1",
        action: "created",
        createdAt: Date.UTC(2026, 4, 15, 9, 30),
        actor: { displayName: "Olive Owner" },
        changes: [{ field: "title", to: "Weekly shop" }],
      },
    ]);

    // The edited event renders before the created event (newest-first preserved from the
    // query order) — asserted by document position, not nested-listitem indexing.
    const edited = screen.getByText(/edited/);
    const created = screen.getByText(/created/);
    expect(edited.compareDocumentPosition(created) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("Renamed shop")).toBeInTheDocument(); // the edit's `to`
    // "Weekly shop" appears twice: the edit's `from` and the create's `to`.
    expect(screen.getAllByText("Weekly shop")).toHaveLength(2);
    expect(screen.getAllByText("Olive Owner")).toHaveLength(2);
  });

  it("formats a typed money change in the viewer locale (not a raw number or string)", () => {
    renderList([
      {
        id: "h1",
        action: "edited",
        createdAt: Date.UTC(2026, 4, 16, 14, 5),
        actor: { displayName: "You" },
        changes: [
          {
            field: "amount",
            fromMoney: { minorUnits: 1250, currency: "USD" },
            toMoney: { minorUnits: 9900, currency: "USD" },
          },
        ],
      },
    ]);
    expect(screen.getByText("Amount:")).toBeInTheDocument();
    expect(screen.getByText("$12.50")).toBeInTheDocument();
    expect(screen.getByText("$99.00")).toBeInTheDocument();
  });

  it("shows the stored timestamp in UTC (never the viewer timezone)", () => {
    renderList([
      {
        id: "h1",
        action: "created",
        createdAt: Date.UTC(2026, 4, 15, 9, 30),
        actor: { displayName: "You" },
        changes: [],
      },
    ]);
    expect(screen.getByText(/May 15, 2026/)).toBeInTheDocument();
    expect(screen.getByText(/UTC/)).toBeInTheDocument();
  });

  it("labels a system event (no actor) rather than leaving it blank", () => {
    renderList([
      { id: "h1", action: "archived", createdAt: Date.UTC(2026, 4, 16), actor: null, changes: [] },
    ]);
    expect(screen.getByText("System")).toBeInTheDocument();
  });

  it("labels Circle Settings history events and setup fields", () => {
    renderList([
      {
        id: "h1",
        action: "settings_changed",
        createdAt: Date.UTC(2026, 4, 16, 14, 5),
        actor: { displayName: "Olive Owner" },
        changes: [
          { field: "color", from: "Blue", to: "Green" },
          { field: "setup.purpose", from: "trip", to: "residence" },
          { field: "setup.residenceType", to: "leased" },
        ],
      },
    ]);

    expect(screen.getByText(/updated settings/)).toBeInTheDocument();
    expect(screen.getByText("Circle use:")).toBeInTheDocument();
    expect(screen.getByText("Residence type:")).toBeInTheDocument();
    expect(screen.getByText("Color:")).toBeInTheDocument();
  });

  it("labels setup completion even when there are no answer changes", () => {
    renderList([
      {
        id: "h1",
        action: "setup_completed",
        createdAt: Date.UTC(2026, 4, 16, 14, 5),
        actor: { displayName: "Olive Owner" },
        changes: [],
      },
    ]);

    expect(screen.getByText(/completed setup/)).toBeInTheDocument();
  });

  it("labels member deleted distinctly from member removed", () => {
    renderList([
      {
        id: "h1",
        action: "member deleted",
        createdAt: Date.UTC(2026, 4, 16, 14, 5),
        actor: null,
        changes: [{ field: "member", from: "Rex" }],
      },
      {
        id: "h2",
        action: "member removed",
        createdAt: Date.UTC(2026, 4, 15, 14, 5),
        actor: { displayName: "Olive" },
        changes: [{ field: "member", from: "Yuki" }],
      },
    ]);
    expect(screen.getByText("deleted account")).toBeInTheDocument();
    expect(screen.getByText("removed")).toBeInTheDocument();
  });
});

describe("HistoryList — read states", () => {
  it("shows a loading line for the first page", () => {
    renderList([], { status: "LoadingFirstPage" });
    expect(screen.getByText("Loading history…")).toBeInTheDocument();
  });

  it("shows an empty state when there is no history", () => {
    renderList([], { status: "Exhausted" });
    expect(screen.getByText("No history yet.")).toBeInTheDocument();
  });

  it("offers Load more only while more pages remain, and calls loadMore", async () => {
    const user = userEvent.setup();
    const loadMore = vi.fn();
    renderList(
      [{ id: "h1", action: "created", createdAt: 0, actor: { displayName: "You" }, changes: [] }],
      { status: "CanLoadMore", loadMore },
    );
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(loadMore).toHaveBeenCalledOnce();
  });

  it("disables the control while a further page is loading", () => {
    renderList(
      [{ id: "h1", action: "created", createdAt: 0, actor: { displayName: "You" }, changes: [] }],
      { status: "LoadingMore" },
    );
    expect(screen.getByRole("button", { name: "Loading…" })).toBeDisabled();
  });
});
