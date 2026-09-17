import { render, screen } from "@testing-library/react";
import { Link, MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import {
  Sidebar,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "./sidebar.js";

/**
 * The repository-owned desktop subset of shadcn Sidebar (issue #351). These cover the
 * COLLAPSE CONTRACT a later issue will expose — provider state, `data-state`,
 * `data-collapsible`, and the width variables — plus `render`-prop composition, since
 * that contract is what makes exposing collapse additive rather than a rewrite.
 *
 * Collapse is driven the way a future trigger will drive it: through the provider's
 * `open` prop. No stand-in toggle component — a test may not invent a caller the app
 * does not have (ADR 0006).
 */
function panel() {
  return document.querySelector('[data-slot="sidebar"]');
}

function Shell({ open, onOpenChange }: { open?: boolean; onOpenChange?: (open: boolean) => void }) {
  return (
    <SidebarProvider open={open} onOpenChange={onOpenChange}>
      <Sidebar />
    </SidebarProvider>
  );
}

describe("SidebarProvider", () => {
  it("starts expanded and advertises its collapse mode only once collapsed", () => {
    const { rerender } = render(<Shell />);

    expect(panel()).toHaveAttribute("data-state", "expanded");
    expect(panel()).toHaveAttribute("data-collapsible", "");

    rerender(<Shell open={false} />);

    expect(panel()).toHaveAttribute("data-state", "collapsed");
    // Only a collapsed panel advertises its collapse mode, which is what the
    // `group-data-[collapsible=icon]` width and label rules key off.
    expect(panel()).toHaveAttribute("data-collapsible", "icon");
  });

  it("defers to a controlled `open` instead of self-updating", () => {
    const onOpenChange = vi.fn();
    render(<Shell open={false} onOpenChange={onOpenChange} />);

    // A controlled owner decides the state; the panel never overrides it.
    expect(panel()).toHaveAttribute("data-state", "collapsed");
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("throws when a sidebar part is used outside the provider", () => {
    expect(() => render(<Sidebar />)).toThrow(/SidebarProvider/);
  });
});

describe("Sidebar geometry", () => {
  it("paints only from `lg` up and reserves the panel's width in flow", () => {
    render(
      <SidebarProvider>
        <Sidebar />
        <SidebarInset>content</SidebarInset>
      </SidebarProvider>,
    );

    expect(panel()?.className).toContain("hidden");
    expect(panel()?.className).toContain("lg:block");
    // A gap element holds the space the fixed panel covers, so the inset never
    // renders underneath it.
    const gap = document.querySelector('[data-slot="sidebar-gap"]');
    expect(gap?.className).toContain("w-(--sidebar-width)");
    expect(gap?.className).toContain("group-data-[collapsible=icon]:w-(--sidebar-width-icon)");
    expect(document.querySelector('[data-slot="sidebar-container"]')?.className).toContain(
      "w-(--sidebar-width)",
    );
  });

  // At `lg` the header (and its `banner`) is not rendered, so the panel has to be a
  // landmark of its own or its controls belong to none.
  it("exposes the panel as a labelled complementary landmark", () => {
    render(
      <SidebarProvider>
        <Sidebar aria-label="PocketCircle" />
      </SidebarProvider>,
    );

    expect(screen.getByRole("complementary", { name: "PocketCircle" })).toBeInTheDocument();
  });

  it("keeps the inset out of the single `main` landmark", () => {
    render(
      <SidebarProvider>
        <SidebarInset>
          <main>page</main>
        </SidebarInset>
      </SidebarProvider>,
    );

    // The app owns exactly one `main` (the skip-link target); the inset is a plain box.
    expect(screen.getAllByRole("main")).toHaveLength(1);
  });
});

describe("SidebarMenuButton", () => {
  it("renders as a button by default and marks the active row", () => {
    render(
      <SidebarProvider>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton isActive>
              <span>Home</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarProvider>,
    );

    const row = screen.getByRole("button", { name: "Home" });
    expect(row).toHaveAttribute("data-active", "true");
    expect(row).toHaveAttribute("data-size", "default");
  });

  it("composes another element through `render`, merging its own classes", () => {
    render(
      <MemoryRouter>
        <SidebarProvider>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                render={<Link to="/somewhere" />}
                className="mt-1"
                aria-describedby="badge"
              >
                <span>Somewhere</span>
              </SidebarMenuButton>
              <SidebarMenuBadge id="badge">2 of 4</SidebarMenuBadge>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarProvider>
      </MemoryRouter>,
    );

    const link = screen.getByRole("link", { name: "Somewhere" });
    expect(link).toHaveAttribute("href", "/somewhere");
    expect(link).toHaveClass("peer/menu-button", "mt-1");
    // The badge is a positioned SIBLING, so its text reaches the row by description.
    expect(link).toHaveAccessibleDescription("2 of 4");
  });

  it("reserves badge space itself so callers never hand-roll right padding", () => {
    render(
      <SidebarProvider>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton>
              <span>Get started</span>
            </SidebarMenuButton>
            <SidebarMenuBadge>0 of 4</SidebarMenuBadge>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarProvider>,
    );

    expect(screen.getByRole("button", { name: "Get started" })).toHaveClass(
      "group-has-data-[slot=sidebar-menu-badge]/menu-item:pr-14",
    );
  });

  it("clips row labels when collapsed instead of removing their accessible names", () => {
    render(
      <SidebarProvider open={false}>
        <Sidebar>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton>
                <span>Home</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </Sidebar>
      </SidebarProvider>,
    );

    // `display:none` labels would leave collapsed rows as unnamed buttons; clipping via
    // the row's own `overflow-hidden` keeps the name.
    const row = screen.getByRole("button", { name: "Home" });
    expect(row).toHaveClass("overflow-hidden", "[&>span:last-child]:truncate");
    expect(row.className).not.toContain("[&>span:last-child]:hidden");
  });

  it("sizes rows through the shared variants", () => {
    render(
      <SidebarProvider>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg">
              <span>Tall</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarProvider>,
    );

    const row = screen.getByRole("button", { name: "Tall" });
    expect(row).toHaveAttribute("data-size", "lg");
    expect(row).toHaveClass("h-12");
  });
});
