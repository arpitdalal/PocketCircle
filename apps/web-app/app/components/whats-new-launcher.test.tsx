import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changelogSource, parseChangelog } from "~/lib/changelog.js";
import { markChangelogVersionSeen, readChangelogSeenVersion } from "~/lib/changelog-seen.js";
import { renderSidebarRow } from "~/test/activation-hosts.js";
import { configureConvex } from "~/test/convex-react.js";
import {
  posthogSdk,
  primeAnalyticsForTests,
  resetPostHogBoundary,
} from "~/test/posthog-boundary.js";

vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);
vi.mock("posthog-js", async () => (await import("~/test/posthog-mock.js")).posthogModuleMock);

import { WhatsNewLauncher } from "./whats-new-launcher.js";

/**
 * The condensed changelog feed (issue #351), driven by the REAL parsed `CHANGELOG.md`
 * — the same source the public archive reads, so the preview can never become a second
 * catalog. Assertions derive their expectations from the parser rather than hard-coding
 * release copy, which would rot on every release.
 */
const sections = parseChangelog(changelogSource);
const ADA = "user-ada";

beforeEach(async () => {
  configureConvex({});
  await primeAnalyticsForTests();
});

afterEach(() => {
  cleanup();
  resetPostHogBoundary();
  vi.restoreAllMocks();
});

function renderLauncher(userId = ADA) {
  return renderSidebarRow(<WhatsNewLauncher userId={userId} />, {
    routes: <Route path="/whats-new" element={<h2>archive-screen</h2>} />,
  });
}

function trigger() {
  return screen.getByRole("button", { name: /What's new/ });
}

async function openFeed(user: ReturnType<typeof userEvent.setup>) {
  await user.click(trigger());
  return await screen.findByRole("dialog");
}

describe("WhatsNewLauncher unread state", () => {
  it("marks the latest parsed version unread on a first visit", () => {
    renderLauncher();

    const latest = sections[0];
    expect(latest).toBeDefined();
    expect(trigger()).toHaveAccessibleDescription("Unread updates");
  });

  it("shows no indicator once the latest version has been seen", () => {
    const latest = sections[0];
    if (!latest) {
      throw new Error("CHANGELOG.md must have a released version");
    }
    markChangelogVersionSeen(ADA, latest.version);
    renderLauncher();

    expect(trigger()).not.toHaveAccessibleDescription();
  });

  it("shows the indicator again for a User who has only seen an older version", () => {
    const older = sections[1];
    if (!older) {
      throw new Error("CHANGELOG.md must have at least two released versions");
    }
    markChangelogVersionSeen(ADA, older.version);
    renderLauncher();

    expect(trigger()).toHaveAccessibleDescription("Unread updates");
  });

  it("does not share seen state across Users on one browser", () => {
    const latest = sections[0];
    if (!latest) {
      throw new Error("CHANGELOG.md must have a released version");
    }
    markChangelogVersionSeen("user-grace", latest.version);
    renderLauncher(ADA);

    expect(trigger()).toHaveAccessibleDescription("Unread updates");
  });
});

describe("WhatsNewLauncher feed", () => {
  it("previews at most three released sections, capped, and never Unreleased", async () => {
    const user = userEvent.setup();
    renderLauncher();

    const feed = await openFeed(user);
    expect(feed).toHaveAccessibleName("What's new");
    expect(feed).toHaveAccessibleDescription(/latest released updates/i);

    // Caps are asserted by COUNT against the parser, so they still bite on a CHANGELOG.md
    // with fewer releases or shorter releases than today's — a `if (sections[3])` guard
    // would quietly turn into a no-op there.
    const expected = sections.slice(0, 3);
    for (const section of expected) {
      expect(within(feed).getByText(section.version)).toBeInTheDocument();
      expect(within(feed).getByText(section.date)).toBeInTheDocument();
    }
    expect(within(feed).getAllByRole("heading", { level: 3 })).toHaveLength(expected.length);
    expect(within(feed).queryByText(/unreleased/i)).not.toBeInTheDocument();

    // Bullets are capped per section, flattened across its categories in order, and each
    // section shows at most its first intro paragraph.
    for (const section of expected) {
      const row = within(feed).getByText(section.version).closest("li");
      if (!row) {
        throw new Error(`No feed row rendered for ${section.version}`);
      }
      const bullets = section.categories.flatMap((category) => category.items);
      expect(row.querySelectorAll("ul > li")).toHaveLength(Math.min(3, bullets.length));
      expect(row.querySelectorAll(":scope > p")).toHaveLength(Math.min(1, section.intro.length));
      for (const item of bullets.slice(0, 3)) {
        expect(within(feed).getByText(item)).toBeInTheDocument();
      }
    }
  });

  it("keeps the New badge on the section being read, then clears the row indicator", async () => {
    const latest = sections[0];
    if (!latest) {
      throw new Error("CHANGELOG.md must have a released version");
    }
    const user = userEvent.setup();
    renderLauncher();

    const feed = await openFeed(user);

    // Marking seen clears the row indicator immediately, but the feed the User is
    // reading still labels which release is the new one.
    expect(within(feed).getByText("New")).toBeInTheDocument();
    expect(trigger()).not.toHaveAccessibleDescription();
    expect(readChangelogSeenVersion(ADA)).toBe(latest.version);
  });

  it("records the archive's analytics event with the parsed latest version", async () => {
    const latest = sections[0];
    if (!latest) {
      throw new Error("CHANGELOG.md must have a released version");
    }
    const user = userEvent.setup();
    renderLauncher();

    await openFeed(user);

    expect(posthogSdk.capture).toHaveBeenCalledWith("whats_new_opened", {
      latestVersion: latest.version,
    });
  });

  it("opens the full archive in a new tab instead of navigating in place", async () => {
    const user = userEvent.setup();
    const view = renderLauncher();

    const feed = await openFeed(user);
    const viewAll = within(feed).getByRole("link", { name: /View all updates/ });
    expect(viewAll).toHaveAttribute("href", "/whats-new");
    expect(viewAll).toHaveAttribute("target", "_blank");
    expect(viewAll).toHaveAttribute("rel", "noopener noreferrer");
    // Whitespace-tolerant: real engines insert a space between concatenated child text,
    // jsdom does not. Both read as the same pause.
    expect(viewAll).toHaveAccessibleName(/^View all updates\s*, opens in a new tab$/);
    expect(view.location()).toBe("/");
  });

  it("closes on Escape and returns focus to the row", async () => {
    const user = userEvent.setup();
    renderLauncher();

    await openFeed(user);
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger()).toHaveFocus();
  });
});
