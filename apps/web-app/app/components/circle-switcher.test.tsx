import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AppChrome, SIDEBAR_CHROME_QUERY } from "~/lib/app-chrome.js";
import type { Circle } from "~/lib/data.js";
import { configureConvex, makeCircleView, renderRoutes, testId } from "~/test/convex-react.js";
import { createMatchMediaFakeController } from "~/test/match-media.js";

/**
 * Behavior test for the Circle switcher (CS-0). Doubles ONLY Convex's reactive client
 * (via the shared helper) and runs the REAL `useMyCircles` hook + switcher against it
 * (ADR 0006), so the list, ordering, links, and the disclosure behavior are exercised
 * exactly as in the shell.
 */
vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);

import { CircleSwitcher } from "./circle-switcher.js";

afterEach(() => {
  vi.clearAllMocks();
});

/** Mounts the switcher at `/` with sink routes for the two destinations it links to,
 * so a click's navigation is observable through `location()`. `header` is jsdom's default
 * chrome: `matchMedia` reports the `lg` query unmatched. */
function renderSwitcher(chrome: AppChrome = "header") {
  return renderRoutes(
    <>
      <Route path="/" element={<CircleSwitcher chrome={chrome} />} />
      <Route path="/circles/new" element={<div>create page</div>} />
      <Route path="/circles/:circleRef" element={<div>circle page</div>} />
    </>,
    { initialEntries: ["/"] },
  );
}

const PERSONAL = makeCircleView({
  id: testId<Circle["id"]>("c0"),
  ref: "personal-c0",
  name: "Personal",
  kind: "personal",
  mark: "P",
  color: "iris",
});
const TRIP = makeCircleView({
  id: testId<Circle["id"]>("c1"),
  ref: "trip-c1",
  name: "Trip",
  mark: "T",
  color: "teal",
});
const ARCHIVED_TRIP = makeCircleView({
  id: testId<Circle["id"]>("c2"),
  ref: "old-trip-c2",
  name: "Old Trip",
  mark: "OT",
  color: "gray",
  status: "archived",
});

describe("CircleSwitcher", () => {
  const media = createMatchMediaFakeController();

  // Both chromes mount a switcher and CSS paints one, so an open menu has to close when
  // its own chrome stops being painted — otherwise it hangs off a `display: none` trigger
  // and comes back open on the next resize.
  it("closes the sidebar menu when the viewport stops painting the sidebar", async () => {
    const matchMedia = media.queries({ [SIDEBAR_CHROME_QUERY]: true });
    const user = userEvent.setup();
    configureConvex({ circles: [PERSONAL] });
    renderSwitcher("sidebar");

    await user.click(screen.getByRole("button", { name: /circles/i }));
    expect(screen.getByRole("menu", { name: "Your circles" })).toBeInTheDocument();

    await act(async () => {
      matchMedia.setQueryMatches(SIDEBAR_CHROME_QUERY, false);
    });

    expect(screen.queryByRole("menu", { name: "Your circles" })).not.toBeInTheDocument();
  });

  it("lists only the User's own circles, Personal first, as canonical-ref links", async () => {
    const user = userEvent.setup();
    // `listMyCircles` already returns active-only, Personal-first; the switcher renders
    // exactly that (no discovery of others' Circles — PRD 24).
    configureConvex({ circles: [PERSONAL, TRIP] });
    renderSwitcher();

    await user.click(screen.getByRole("button", { name: /circles/i }));

    const menu = screen.getByRole("menu", { name: "Your circles" });
    const circleLinks = within(menu)
      .getAllByRole("menuitem")
      .filter((item) => item.getAttribute("href") !== "/circles/new");
    expect(circleLinks).toHaveLength(2);
    expect(circleLinks[0]).toHaveTextContent("Personal");
    expect(circleLinks[0]).toHaveAttribute("href", "/circles/personal-c0");
    expect(circleLinks[1]).toHaveTextContent("Trip");
    expect(circleLinks[1]).toHaveAttribute("href", "/circles/trip-c1");
  });

  it("disambiguates same-named circles by Circle Color label (not the aria-hidden chip)", async () => {
    const user = userEvent.setup();
    // Two Circles share name + kind + currency; only the Color differs (allowed —
    // PRD 10). The color chip is aria-hidden, so without a text Color label these
    // rows would be announced identically and a screen-reader/color-blind user
    // couldn't tell which "Home" they're choosing.
    const blueHome = makeCircleView({
      id: testId<Circle["id"]>("c0"),
      ref: "home-c0",
      name: "Home",
      mark: "H",
      color: "blue",
    });
    const tealHome = makeCircleView({
      id: testId<Circle["id"]>("c1"),
      ref: "home-c1",
      name: "Home",
      mark: "H",
      color: "teal",
    });
    configureConvex({ circles: [blueHome, tealHome] });
    renderSwitcher();

    await user.click(screen.getByRole("button", { name: /circles/i }));
    const menu = screen.getByRole("menu", { name: "Your circles" });
    const rows = within(menu)
      .getAllByRole("menuitem")
      .filter((item) => item.getAttribute("href") !== "/circles/new");

    // Each row's accessible text carries its distinct Color label, so the two are
    // distinguishable by name + color text alone.
    expect(rows[0]).toHaveTextContent("Blue");
    expect(rows[1]).toHaveTextContent("Teal");
    // Targetable by the disambiguated accessible name.
    expect(within(menu).getByRole("menuitem", { name: /Home.*Blue/s })).toHaveAttribute(
      "href",
      "/circles/home-c0",
    );
    expect(within(menu).getByRole("menuitem", { name: /Home.*Teal/s })).toHaveAttribute(
      "href",
      "/circles/home-c1",
    );
  });

  it("navigates to a circle's canonical ref when selected", async () => {
    const user = userEvent.setup();
    configureConvex({ circles: [PERSONAL, TRIP] });
    const view = renderSwitcher();

    await user.click(screen.getByRole("button", { name: /circles/i }));
    await user.click(screen.getByRole("menuitem", { name: /Trip/ }));

    expect(view.location()).toBe("/circles/trip-c1");
  });

  it("offers a Create circle entry that navigates to the create route", async () => {
    const user = userEvent.setup();
    configureConvex({ circles: [PERSONAL] });
    const view = renderSwitcher();

    await user.click(screen.getByRole("button", { name: /circles/i }));
    const create = screen.getByRole("menuitem", { name: "Create circle" });
    expect(create).toHaveAttribute("href", "/circles/new");

    await user.click(create);
    expect(view.location()).toBe("/circles/new");
  });

  it("shows a loading state while circles resolve, keeping Create available", async () => {
    const user = userEvent.setup();
    configureConvex({ circles: undefined }); // subscription still loading
    renderSwitcher();

    await user.click(screen.getByRole("button", { name: /circles/i }));
    expect(screen.getByText(/Loading circles/)).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Create circle" })).toBeInTheDocument();
  });

  it("groups archived circles below an Archived section", async () => {
    const user = userEvent.setup();
    configureConvex({ circles: [PERSONAL, TRIP, ARCHIVED_TRIP] });
    renderSwitcher();

    await user.click(screen.getByRole("button", { name: /circles/i }));

    const menu = screen.getByRole("menu", { name: "Your circles" });
    expect(within(menu).getByText("Archived")).toBeInTheDocument();
    const circleLinks = within(menu)
      .getAllByRole("menuitem")
      .filter((item) => item.getAttribute("href") !== "/circles/new");
    expect(circleLinks[0]).toHaveTextContent("Personal");
    expect(circleLinks[1]).toHaveTextContent("Trip");
    expect(circleLinks[2]).toHaveTextContent("Old Trip");
    expect(circleLinks[2]).toHaveTextContent("Archived");
  });

  it("is a labelled disclosure that closes on Escape", async () => {
    const user = userEvent.setup();
    configureConvex({ circles: [PERSONAL] });
    renderSwitcher();

    const trigger = screen.getByRole("button", { name: /circles/i });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("closes on an outside click", async () => {
    const user = userEvent.setup();
    configureConvex({ circles: [PERSONAL] });
    renderSwitcher();

    await user.click(screen.getByRole("button", { name: /circles/i }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await user.click(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
