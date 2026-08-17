import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { Outlet, Route } from "react-router";
import { describe, expect, it } from "vitest";
import { CircleMobileBottomNav } from "~/components/circle-mobile-bottom-nav.js";
import type { CircleOutletContext } from "~/routes/layouts/circle-layout.js";
import { makeCircleView, renderRoutes } from "~/test/convex-react.js";

const circle = makeCircleView();

function renderMobileNav(initialPath: string) {
  return renderRoutes(
    <Route element={<Outlet context={{ circle } satisfies CircleOutletContext} />}>
      <Route path="*" element={<CircleMobileBottomNav circle={circle} />} />
    </Route>,
    { initialEntries: [initialPath] },
  );
}

function renderStrictMobileNav(initialPath: string) {
  return renderRoutes(
    <Route
      element={
        <StrictMode>
          <Outlet context={{ circle } satisfies CircleOutletContext} />
        </StrictMode>
      }
    >
      <Route path="*" element={<CircleMobileBottomNav circle={circle} />} />
    </Route>,
    { initialEntries: [initialPath] },
  );
}

describe("CircleMobileBottomNav", () => {
  it("sizes the bar so safe-area padding adds below the content band", () => {
    renderMobileNav(`/circles/${circle.ref}`);
    const nav = screen.getByTestId("circle-mobile-bottom-nav");
    // Fixed h-16 + pb-safe under border-box crushed labels into the top; height must
    // be the CSS var that includes safe-area, with padding applied separately.
    expect(nav.className).toContain("h-[var(--mobile-bottom-nav-height)]");
    expect(nav.className).toContain("pb-[var(--mobile-bottom-nav-pad)]");
    expect(nav.className).toContain("mt-0");
    expect(nav.className).not.toMatch(/\bh-16\b/);
  });

  it("links Dashboard, Transactions, and Search to canonical circle routes", () => {
    renderMobileNav(`/circles/${circle.ref}`);
    const nav = screen.getByTestId("circle-mobile-bottom-nav");
    expect(within(nav).getByRole("link", { name: "Dashboard", hidden: true })).toHaveAttribute(
      "href",
      `/circles/${circle.ref}`,
    );
    expect(within(nav).getByRole("link", { name: "Transactions", hidden: true })).toHaveAttribute(
      "href",
      `/circles/${circle.ref}/transactions`,
    );
    expect(within(nav).getByRole("link", { name: "Search", hidden: true })).toHaveAttribute(
      "href",
      `/circles/${circle.ref}/search`,
    );
    expect(
      within(nav).queryByRole("link", { name: "Feedback", hidden: true }),
    ).not.toBeInTheDocument();
    expect(
      within(nav).queryByRole("link", { name: /Send feedback/, hidden: true }),
    ).not.toBeInTheDocument();
  });

  it("renders an icon in each primary slot", () => {
    renderMobileNav(`/circles/${circle.ref}`);
    const nav = screen.getByTestId("circle-mobile-bottom-nav");
    for (const label of ["Dashboard", "Transactions", "Search"]) {
      const link = within(nav).getByRole("link", { name: label, hidden: true });
      expect(link.querySelector("svg")).toBeInTheDocument();
    }
  });

  it("renders an icon beside each More item", async () => {
    const user = userEvent.setup();
    renderMobileNav(`/circles/${circle.ref}`);
    await user.click(screen.getByRole("button", { name: "More" }));
    const dialog = screen.getByRole("dialog", { name: "More" });
    for (const label of ["Categories", "Members", "History"]) {
      const link = within(dialog).getByRole("link", { name: label });
      expect(link.querySelector("svg")).toBeInTheDocument();
    }
  });

  it("opens More and lists Categories, Members, and History with canonical hrefs", async () => {
    const user = userEvent.setup();
    renderMobileNav(`/circles/${circle.ref}`);
    await user.click(screen.getByRole("button", { name: "More" }));
    const dialog = screen.getByRole("dialog", { name: "More" });
    expect(within(dialog).getByRole("link", { name: "Categories" })).toHaveAttribute(
      "href",
      `/circles/${circle.ref}/categories`,
    );
    expect(within(dialog).getByRole("link", { name: "Members" })).toHaveAttribute(
      "href",
      `/circles/${circle.ref}/members`,
    );
    expect(within(dialog).getByRole("link", { name: "History" })).toHaveAttribute(
      "href",
      `/circles/${circle.ref}/history`,
    );
    expect(within(dialog).queryByRole("link", { name: "Feedback" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("link", { name: /Send feedback/ })).not.toBeInTheDocument();
  });

  it("sets aria-current=page on More when the route is Categories", () => {
    renderMobileNav(`/circles/${circle.ref}/categories`);
    expect(screen.getByRole("button", { name: "More" })).toHaveAttribute("aria-current", "page");
  });

  it("keeps More active on a nested Categories child route", () => {
    renderMobileNav(`/circles/${circle.ref}/categories/groceries`);
    expect(screen.getByRole("button", { name: "More" })).toHaveAttribute("aria-current", "page");
  });

  it("does not mark More active on a sibling whose path shares a prefix", () => {
    renderMobileNav(`/circles/${circle.ref}/categories-archive`);
    expect(screen.getByRole("button", { name: "More" })).not.toHaveAttribute("aria-current");
  });

  it("navigates from the sheet and closes the dialog", async () => {
    const user = userEvent.setup();
    const view = renderMobileNav(`/circles/${circle.ref}`);
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "More" })).getByRole("link", { name: "Members" }),
    );
    expect(view.location()).toBe(`/circles/${circle.ref}/members`);
    expect(screen.queryByRole("dialog", { name: "More" })).not.toBeInTheDocument();
  });

  it("closes More on external route changes under StrictMode", async () => {
    const user = userEvent.setup();
    const view = renderStrictMobileNav(`/circles/${circle.ref}`);
    await user.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("dialog", { name: "More" })).toBeInTheDocument();
    await view.navigate(`/circles/${circle.ref}/transactions`);
    expect(view.location()).toBe(`/circles/${circle.ref}/transactions`);
    expect(screen.queryByRole("dialog", { name: "More" })).not.toBeInTheDocument();
  });

  it("keeps More open on same-route navigation under StrictMode", async () => {
    const user = userEvent.setup();
    const view = renderStrictMobileNav(`/circles/${circle.ref}`);
    await user.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("dialog", { name: "More" })).toBeInTheDocument();
    await view.navigate(`/circles/${circle.ref}`);
    expect(view.location()).toBe(`/circles/${circle.ref}`);
    expect(screen.getByRole("dialog", { name: "More" })).toBeInTheDocument();
  });
});
