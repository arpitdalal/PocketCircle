import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changelogSource, parseChangelog } from "~/lib/changelog.js";
import { configureConvex, convexReactMock, makeCurrentUserView } from "~/test/convex-react.js";
import {
  posthogSdk,
  primeAnalyticsForTests,
  resetPostHogBoundary,
} from "~/test/posthog-boundary.js";

vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);
vi.mock("posthog-js", async () => (await import("~/test/posthog-mock.js")).posthogModuleMock);

import WhatsNew from "./whats-new.js";

const sections = parseChangelog(changelogSource);

function renderWhatsNew() {
  return render(
    <MemoryRouter>
      <WhatsNew />
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });
  await primeAnalyticsForTests();
});

afterEach(() => {
  resetPostHogBoundary();
  vi.clearAllMocks();
});

describe("What's new", () => {
  it("opens the latest released version, hides older copy until expanded, and skips Unreleased", async () => {
    const latest = sections[0];
    const older = sections[1];
    if (!latest || !older) {
      throw new Error("CHANGELOG.md must have at least two released versions");
    }
    const latestBullet = latest.categories[0]?.items[0];
    const olderSnippet = older.intro[0] ?? older.categories[0]?.items[0];
    if (!latestBullet || !olderSnippet) {
      throw new Error("expected latest bullets and older intro or bullets");
    }

    configureConvex({
      currentUser: makeCurrentUserView(),
    });
    const user = userEvent.setup();
    renderWhatsNew();

    expect(await screen.findByRole("heading", { name: "What's new" })).toBeInTheDocument();
    expect(screen.queryByText("Unreleased")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: `${latest.version} · ${latest.date}` }),
    ).toBeInTheDocument();
    expect(screen.getByText(latestBullet)).toBeInTheDocument();
    expect(screen.queryByText(olderSnippet)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: `${older.version} · ${older.date}` }));
    expect(await screen.findByText(olderSnippet)).toBeInTheDocument();
  });

  it("tracks whats_new_opened with the parsed latest version when sections exist", async () => {
    const latest = sections[0];
    if (!latest) {
      throw new Error("CHANGELOG.md must have at least one released version");
    }

    configureConvex({
      currentUser: makeCurrentUserView(),
    });
    renderWhatsNew();

    await waitFor(() => {
      expect(posthogSdk.capture).toHaveBeenCalledWith("whats_new_opened", {
        latestVersion: latest.version,
      });
    });
  });

  it("does not track while the session is still loading", async () => {
    configureConvex({ currentUser: undefined });
    renderWhatsNew();

    expect(screen.queryByRole("heading", { name: "What's new" })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(posthogSdk.capture).not.toHaveBeenCalled();
    });
  });
});
