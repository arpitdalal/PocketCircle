import { buildRef } from "@pocketcircle/domain";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureConvex, renderRoutes } from "~/test/convex-react.js";
import {
  posthogSdk,
  primeAnalyticsForTests,
  resetPostHogBoundary,
} from "~/test/posthog-boundary.js";

/**
 * Behavior test for the Create Circle flow (CS-0). Doubles ONLY Convex's reactive
 * client (via the shared helper) and runs the REAL route + real `useCreateCircle`
 * hook + the real shared domain helpers (`initials`, `buildRef`,
 * `defaultCurrencyForLocale`) against it (ADR 0006), so validation, the derived Mark,
 * the locale-default Currency, the mutation call, and the canonical-ref navigation are
 * exercised exactly as in the app.
 */
vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);
vi.mock("posthog-js", async () => (await import("~/test/posthog-mock.js")).posthogModuleMock);
vi.mock("~/lib/env.js", async (importOriginal) =>
  (await import("~/test/posthog-mock.js")).createPosthogEnvMock(importOriginal),
);

import CreateCircle from "./circle-new.js";

beforeEach(() => {
  primeAnalyticsForTests();
});

afterEach(() => {
  resetPostHogBoundary();
  // restoreAllMocks (not just clear) so a per-test navigator.language spy does not
  // leak its locale into later tests.
  vi.restoreAllMocks();
});

/** Mounts the create route with sink routes for the destinations it navigates to. */
function renderCreate(entry = "/circles/new") {
  return renderRoutes(
    <>
      <Route path="/" element={<div>home</div>} />
      <Route path="/circles/new" element={<CreateCircle />} />
      <Route path="/circles/:circleRef" element={<div>circle page</div>} />
      <Route path="/circles/:circleRef/setup" element={<div>setup page</div>} />
    </>,
    { initialEntries: [entry] },
  );
}

describe("Create Circle", () => {
  it("submits parsed input, then navigates to the new Circle's canonical ref", async () => {
    const user = userEvent.setup();
    const newId = "c-new";
    const createCircle = vi.fn().mockResolvedValue(newId);
    configureConvex({ createCircle });
    const view = renderCreate();

    await user.type(screen.getByLabelText("Name"), "My Home");
    await user.click(screen.getByRole("button", { name: "Teal" }));
    await user.click(screen.getByRole("button", { name: "Create circle" }));

    // The Mark is derived from the name's initials ("My Home" → "MH"); the locale
    // default Currency (jsdom en-US → USD) and the chosen Color ride along.
    expect(createCircle).toHaveBeenCalledTimes(1);
    expect(createCircle).toHaveBeenCalledWith({
      name: "My Home",
      currency: "USD",
      color: "teal",
      mark: "MH",
    });
    expect(posthogSdk.capture).toHaveBeenCalledWith("circle_created", { currency: "USD" });

    // Canonical-ref navigation (ADR 0016) — id-authoritative from first load.
    await waitFor(() => {
      expect(view.location()).toBe(`/circles/${buildRef("My Home", newId)}/setup`);
    });
    expect(await screen.findByText(/"My Home" created\./)).toBeInTheDocument();
  });

  it("defaults the Currency from the viewer's locale (not a hardcoded USD)", () => {
    vi.spyOn(window.navigator, "language", "get").mockReturnValue("en-GB");
    configureConvex({ createCircle: vi.fn() });
    renderCreate();

    expect(screen.getByLabelText<HTMLSelectElement>("Currency").value).toBe("GBP");
  });

  it("defaults the Currency to a Eurozone locale's EUR", () => {
    vi.spyOn(window.navigator, "language", "get").mockReturnValue("de-DE");
    configureConvex({ createCircle: vi.fn() });
    renderCreate();

    expect(screen.getByLabelText<HTMLSelectElement>("Currency").value).toBe("EUR");
  });

  it("falls back to USD when the viewer's locale region is unsupported", () => {
    // The real viewerLocale → defaultCurrencyForLocale wiring must fall back, not
    // throw or blank the select, for a region we don't map (jp).
    vi.spyOn(window.navigator, "language", "get").mockReturnValue("ja-JP");
    configureConvex({ createCircle: vi.fn() });
    renderCreate();

    expect(screen.getByLabelText<HTMLSelectElement>("Currency").value).toBe("USD");
  });

  it("derives the Mark live from the name's initials", async () => {
    const user = userEvent.setup();
    configureConvex({ createCircle: vi.fn() });
    renderCreate();

    // "?" before any input (the domain `initials` fallback).
    expect(screen.getByText("?")).toBeInTheDocument();

    const name = screen.getByLabelText("Name");
    await user.type(name, "Olive Owner");
    expect(screen.getByText("OO")).toBeInTheDocument();

    await user.clear(name);
    await user.type(name, "Alex");
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("propagates returnTo into setup and Cancel", async () => {
    const user = userEvent.setup();
    const newId = "c-ret";
    const origin = "/circles/personal-p1";
    const createCircle = vi.fn().mockResolvedValue(newId);
    configureConvex({ createCircle });
    const view = renderCreate(`/circles/new?returnTo=${encodeURIComponent(origin)}`);

    expect(screen.getByRole("link", { name: "Cancel" })).toHaveAttribute("href", origin);

    await user.type(screen.getByLabelText("Name"), "Cabin");
    await user.click(screen.getByRole("button", { name: "Create circle" }));

    await waitFor(() => {
      expect(view.location()).toBe(
        `/circles/${buildRef("Cabin", newId)}/setup?returnTo=${encodeURIComponent(origin)}`,
      );
    });
  });

  it("never blocks on a duplicate name (identity is mark + color + ref, not the name)", async () => {
    const user = userEvent.setup();
    const createCircle = vi.fn().mockResolvedValue("c-dup");
    configureConvex({ createCircle });
    renderCreate();

    // There is no client-side uniqueness check; any name simply submits (PRD 10).
    await user.type(screen.getByLabelText("Name"), "Home");
    await user.click(screen.getByRole("button", { name: "Create circle" }));

    expect(createCircle).toHaveBeenCalledWith(expect.objectContaining({ name: "Home", mark: "H" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("disables submit for an empty or whitespace-only name", async () => {
    const user = userEvent.setup();
    const createCircle = vi.fn();
    configureConvex({ createCircle });
    renderCreate();

    const submit = screen.getByRole("button", { name: "Create circle" });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText("Name"), "   ");
    expect(submit).toBeDisabled();

    await user.click(submit);
    expect(createCircle).not.toHaveBeenCalled();
  });

  it("disables submit while the create is in flight (guards double-submit)", async () => {
    const user = userEvent.setup();
    let resolve: ((id: string) => void) | undefined;
    const createCircle = vi.fn().mockReturnValue(
      new Promise<string>((res) => {
        resolve = res;
      }),
    );
    configureConvex({ createCircle });
    renderCreate();

    await user.type(screen.getByLabelText("Name"), "Trip");
    const submit = screen.getByRole("button", { name: "Create circle" });
    await user.click(submit);

    const busy = screen.getByRole("button", { name: "Creating…" });
    expect(busy).toBeDisabled();

    resolve?.("c-trip");
  });

  it("does not let Cancel navigate while a create is in flight", async () => {
    const user = userEvent.setup();
    // A create that never resolves, so the form stays in its submitting state.
    const createCircle = vi.fn().mockReturnValue(new Promise<string>(() => {}));
    configureConvex({ createCircle });
    const view = renderCreate();

    await user.type(screen.getByLabelText("Name"), "Trip");
    await user.click(screen.getByRole("button", { name: "Create circle" }));

    // Cancel is a real disabled button mid-submit (not a `disabled` anchor that
    // would still navigate), so clicking it stays on the form.
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel).toBeDisabled();
    await user.click(cancel);
    expect(view.location()).toBe("/circles/new");
  });

  it("surfaces a failed create and stays on the form", async () => {
    const user = userEvent.setup();
    const createCircle = vi.fn().mockRejectedValue(new Error("network"));
    configureConvex({ createCircle });
    const view = renderCreate();

    await user.type(screen.getByLabelText("Name"), "Trip");
    await user.click(screen.getByRole("button", { name: "Create circle" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/Couldn't create the circle/);
    expect(view.location()).toBe("/circles/new");
    // Re-enabled for a retry.
    expect(screen.getByRole("button", { name: "Create circle" })).toBeEnabled();
  });

  it("cancels back to the safe route", async () => {
    const user = userEvent.setup();
    configureConvex({ createCircle: vi.fn() });
    const view = renderCreate();

    await user.click(screen.getByRole("link", { name: "Cancel" }));
    expect(view.location()).toBe("/");
  });
});
