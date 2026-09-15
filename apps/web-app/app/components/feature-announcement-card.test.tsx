import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureAnnouncementCard } from "~/components/feature-announcement-card.js";
import {
  ANNOUNCEMENT_ENTRANCE_DELAY_MS,
  activeFeatureAnnouncement,
  impressionStorageKey,
} from "~/lib/feature-announcements.js";
import {
  configureConvex,
  convexReactMock,
  deferredValue,
  makeCircleView,
  makeCurrentUserView,
  renderRoutes,
} from "~/test/convex-react.js";
import { installMatchMediaFake } from "~/test/match-media.js";
import {
  posthogSdk,
  primeAnalyticsForTests,
  resetPostHogBoundary,
} from "~/test/posthog-boundary.js";
import {
  clearPwaInstallPromptDismissal,
  dispatchBeforeInstallPrompt,
  resetNavigatorInstallProps,
  setNavigatorInstallProps,
} from "~/test/pwa-install-env.js";

vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);
vi.mock("posthog-js", async () => (await import("~/test/posthog-mock.js")).posthogModuleMock);

const acknowledge = vi.fn().mockResolvedValue(undefined);
let media: ReturnType<typeof installMatchMediaFake> | undefined;

/** Both queries the card's tree reads: install-prompt display mode + motion. */
function installMedia(opts: { reducedMotion?: boolean } = {}) {
  media?.restore();
  media = installMatchMediaFake({
    "(display-mode: standalone)": false,
    "(prefers-reduced-motion: reduce)": opts.reducedMotion === true,
  });
}

const ACTIVE_TITLE = /Connect PocketCircle to your AI assistant/i;
const ACTIVE_ID = "mcp-connections" as const;

beforeEach(async () => {
  sessionStorage.clear();
  clearPwaInstallPromptDismissal();
  resetNavigatorInstallProps();
  installMedia();
  acknowledge.mockReset();
  acknowledge.mockResolvedValue(undefined);
  await primeAnalyticsForTests(makeCurrentUserView({ createdAt: 1, analyticsEnabled: true }));
  posthogSdk.capture.mockClear();
  convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });
});

afterEach(() => {
  media?.restore();
  media = undefined;
  sessionStorage.clear();
  clearPwaInstallPromptDismissal();
  resetNavigatorInstallProps();
  resetPostHogBoundary();
});

/**
 * The card reveal is delayed (#334) on real timers: RTL's `waitFor` only detects
 * Jest's fake clock, so faking time here deadlocks every async assertion.
 */
function findCard() {
  return screen.findByRole("region", { name: ACTIVE_TITLE }, { timeout: 3000 });
}

/**
 * For cases that assert the card never appears — outlast the entrance timer.
 * Wrapped in `act` so the timer's state update flushes inside React's batch.
 */
async function waitPastEntranceDelay() {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, ANNOUNCEMENT_ENTRANCE_DELAY_MS + 150);
    });
  });
}

function renderCard(opts: {
  path: string;
  user?: ReturnType<typeof makeCurrentUserView>;
  circles?: ReturnType<typeof makeCircleView>[];
}) {
  const user = opts.user ?? makeCurrentUserView({ createdAt: 1 });
  configureConvex({
    currentUser: user,
    acknowledgeFeatureAnnouncement: acknowledge,
    circles: opts.circles ?? [makeCircleView({ ref: "trip-abc", name: "Trip" })],
  });
  return renderRoutes(<Route path="*" element={<FeatureAnnouncementCard />} />, {
    initialEntries: [opts.path],
  });
}

describe("FeatureAnnouncementCard", () => {
  it("stays absent until the entrance delay elapses, then slides in", async () => {
    renderCard({ path: "/?currency=USD&range=3" });
    // Eligibility has already settled — absence here is the delay, not loading.
    expect(screen.queryByRole("region")).not.toBeInTheDocument();

    const region = await findCard();
    expect(region).toBeVisible();
    expect(region.className).toContain("animate-slide-up");

    const cta = screen.getByRole("link", { name: "Open Connections" });
    expect(cta).toHaveAttribute("href", "/connections?returnTo=%2F%3Fcurrency%3DUSD%26range%3D3");
    // The polite region is mounted empty and only then updated, so the spoken
    // text arrives in a later task — assert the update, not the first paint.
    await waitFor(() => {
      expect(
        screen.getAllByRole("status").some((node) => ACTIVE_TITLE.test(node.textContent ?? "")),
      ).toBe(true);
    });
  });

  it("renders the required hero image with the close button over it", async () => {
    renderCard({ path: "/" });
    const region = await findCard();

    const announcement = activeFeatureAnnouncement();
    if (!announcement) {
      throw new Error("expected active announcement");
    }
    const hero = within(region).getByRole("img", { name: announcement.heroImage.alt });
    expect(hero).toHaveAttribute("src", announcement.heroImage.src);
    // Intrinsic size so nothing reflows when the image resolves. The card only
    // mounts when it is about to be on screen, so the load is eager.
    expect(hero).toHaveAttribute("width", "1280");
    expect(hero).toHaveAttribute("height", "720");
    expect(hero).toHaveAttribute("loading", "eager");

    // The wrapper owns the 16:9 box so a failed load cannot collapse the layout,
    // and the close button rides the same wrapper, over the media.
    const heroBox = hero.parentElement;
    expect(heroBox?.className).toContain("aspect-video");
    const close = within(region).getByRole("button", { name: "Close" });
    expect(heroBox?.contains(close)).toBe(true);
  });

  it("renders every highlight row with a decorative icon", async () => {
    renderCard({ path: "/" });
    const region = await findCard();

    const announcement = activeFeatureAnnouncement();
    if (!announcement) {
      throw new Error("expected active announcement");
    }
    const rows = within(region).getAllByRole("listitem");
    expect(rows).toHaveLength(announcement.highlights.length);
    for (const [index, highlight] of announcement.highlights.entries()) {
      const row = rows[index];
      if (!row) {
        throw new Error(`missing highlight row ${index}`);
      }
      expect(row).toHaveTextContent(highlight.title);
      expect(row).toHaveTextContent(highlight.body);
      // Icon beside a visible title adds only audible clutter if labelled.
      expect(row.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("renders nothing for new Users or when acknowledged", async () => {
    const cutoff = Date.parse(activeFeatureAnnouncement()?.eligibleBefore ?? "Invalid Date");
    const { unmount: newUser } = renderCard({
      path: "/",
      user: makeCurrentUserView({ createdAt: cutoff }),
    });
    await waitPastEntranceDelay();
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    newUser();

    const { unmount: acknowledged } = renderCard({
      path: "/",
      user: makeCurrentUserView({
        createdAt: 1,
        acknowledgedFeatureAnnouncementIds: [ACTIVE_ID],
      }),
    });
    await waitPastEntranceDelay();
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    acknowledged();
  });

  it("does not show on excluded routes including Connections", async () => {
    renderCard({ path: "/settings" });
    await waitPastEntranceDelay();
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    renderCard({ path: "/connections" });
    await waitPastEntranceDelay();
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("skips the entrance delay under reduced motion", async () => {
    installMedia({ reducedMotion: true });
    renderCard({ path: "/" });
    // The CSS animation is already neutralized by the global reduced-motion
    // reset, so the delay would be pure lag: assert it is not waited out.
    expect(
      await screen.findByRole(
        "region",
        { name: ACTIVE_TITLE },
        { timeout: ANNOUNCEMENT_ENTRANCE_DELAY_MS / 2 },
      ),
    ).toBeVisible();
  });

  it("mounts the polite region empty, then updates it with the announcement", async () => {
    renderCard({ path: "/" });
    // Live regions announce CHANGES: the region has to exist before the text, or
    // almost no screen reader speaks it.
    // Scoped to the card's own sr-only region — the router stub also exposes a
    // status node, and it legitimately carries the current location.
    const liveRegion = screen
      .getAllByRole("status")
      .filter((node) => node.classList.contains("sr-only"));
    expect(liveRegion).toHaveLength(1);
    expect(liveRegion[0]?.textContent).toBe("");

    await findCard();
    await waitFor(() => {
      expect(
        screen.getAllByRole("status").some((node) => ACTIVE_TITLE.test(node.textContent ?? "")),
      ).toBe(true);
    });
  });

  it("drops a failed hero and keeps the 16:9 panel, close, and CTA usable", async () => {
    renderCard({ path: "/" });
    const region = await findCard();
    const hero = within(region).getByRole("img");
    const heroBox = hero.parentElement;

    fireEvent.error(hero);

    await waitFor(() => {
      expect(within(region).queryByRole("img")).toBeNull();
    });
    // The browser's broken-image glyph is worse than a plain muted panel, and the
    // box must not collapse or the close button lands over the copy.
    expect(heroBox?.className).toContain("aspect-video");
    expect(within(region).getByRole("button", { name: "Close" })).toBeVisible();
    expect(within(region).getByRole("link", { name: "Open Connections" })).toBeVisible();
  });

  it("never steals focus, exposes a labelled region and accessible close, and ignores Escape", async () => {
    const u = userEvent.setup();
    renderCard({ path: "/" });
    const region = await findCard();
    expect(document.activeElement).not.toBe(region);
    expect(within(region).getByRole("button", { name: "Close" })).toBeVisible();
    await u.keyboard("{Escape}");
    expect(screen.getByRole("region", { name: ACTIVE_TITLE })).toBeVisible();
  });

  it("optimistically hides on close; mutation failure rolls back and shows the exact toast", async () => {
    const u = userEvent.setup();
    const pending = deferredValue<void>();
    acknowledge.mockImplementation(() => pending.promise);
    renderCard({ path: "/" });
    await findCard();
    await u.click(screen.getByRole("button", { name: "Close" }));
    expect(acknowledge).toHaveBeenCalledWith({ announcementId: ACTIVE_ID });
    await waitFor(() => {
      expect(screen.queryByRole("region")).not.toBeInTheDocument();
    });
    pending.reject(new Error("network"));
    expect(await screen.findByText("Couldn't save that preference.")).toBeVisible();
    // Entrance is one-shot: the rollback restores the card without a second delay.
    await waitFor(() => {
      expect(screen.getByRole("region", { name: ACTIVE_TITLE })).toBeVisible();
    });
    expect(screen.getByTestId("feature-announcement-ack")).toHaveAttribute("data-result", "failed");
  });

  it("records one impression per tab session once the card actually appears", async () => {
    const first = renderCard({ path: "/" });
    // No impression while the entrance is still pending.
    expect(posthogSdk.capture).not.toHaveBeenCalledWith(
      "feature_announcement_impression",
      expect.anything(),
    );

    await waitPastEntranceDelay();
    await waitFor(() => {
      expect(posthogSdk.capture).toHaveBeenCalledWith("feature_announcement_impression", {
        announcement: ACTIVE_ID,
      });
    });
    expect(sessionStorage.getItem(impressionStorageKey(ACTIVE_ID))).toBe("1");
    first.unmount();

    posthogSdk.capture.mockClear();
    const second = renderCard({ path: "/circles/trip-abc/transactions" });
    await waitPastEntranceDelay();
    screen.getByRole("region", { name: ACTIVE_TITLE });
    expect(posthogSdk.capture).not.toHaveBeenCalledWith(
      "feature_announcement_impression",
      expect.anything(),
    );
    second.unmount();

    posthogSdk.capture.mockClear();
    renderCard({ path: "/" });
    await waitPastEntranceDelay();
    screen.getByRole("region", { name: ACTIVE_TITLE });
    expect(posthogSdk.capture).not.toHaveBeenCalledWith(
      "feature_announcement_impression",
      expect.anything(),
    );
  });

  it("keeps stacking below snackbars/dialogs, clears the Circle mobile nav, and caps its height", async () => {
    renderCard({ path: "/circles/trip-abc/transactions" });
    const region = await findCard();
    expect(region.className).toContain("z-20");
    expect(region.className).toContain("bottom-[calc(var(--mobile-bottom-nav-height)+0.75rem)]");
    // `svh` = toolbar-shown height, and the budget must clear the sticky header
    // (z-30) as well as the Circle nav, or the card grows up underneath it.
    expect(region.className).toContain(
      "max-h-[calc(100svh-var(--app-header-height)-var(--mobile-bottom-nav-height)-1.5rem)]",
    );
  });

  it("withholds the entrance and impression while the PWA install modal covers the card", async () => {
    const u = userEvent.setup();
    setNavigatorInstallProps();
    // Start ineligible so the card cannot appear while the PWA modal opens.
    const cutoff = Date.parse(activeFeatureAnnouncement()?.eligibleBefore ?? "Invalid Date");
    const view = renderCard({
      path: "/",
      user: makeCurrentUserView({ createdAt: cutoff, analyticsEnabled: true }),
    });
    dispatchBeforeInstallPrompt();
    const dialog = await screen.findByRole("dialog", { name: "Install PocketCircle" });

    // Become eligible under the covering modal — still no card, no impression.
    configureConvex({
      currentUser: makeCurrentUserView({ createdAt: 1, analyticsEnabled: true }),
      acknowledgeFeatureAnnouncement: acknowledge,
      circles: [makeCircleView({ ref: "trip-abc", name: "Trip" })],
    });
    view.rerenderRoutes(<Route path="*" element={<FeatureAnnouncementCard />} />);
    await waitPastEntranceDelay();
    expect(screen.queryByRole("region", { name: ACTIVE_TITLE, hidden: true })).toBeNull();
    expect(posthogSdk.capture).not.toHaveBeenCalledWith(
      "feature_announcement_impression",
      expect.anything(),
    );

    await u.click(within(dialog).getByRole("button", { name: "Not now" }));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Install PocketCircle" }),
      ).not.toBeInTheDocument();
    });
    expect(await findCard()).toBeVisible();
    await waitFor(() => {
      expect(posthogSdk.capture).toHaveBeenCalledWith("feature_announcement_impression", {
        announcement: ACTIVE_ID,
      });
    });
  });

  it("withholds the entrance while the Chromium native install prompt is pending", async () => {
    const u = userEvent.setup();
    setNavigatorInstallProps();
    const cutoff = Date.parse(activeFeatureAnnouncement()?.eligibleBefore ?? "Invalid Date");
    const view = renderCard({
      path: "/",
      user: makeCurrentUserView({ createdAt: cutoff, analyticsEnabled: true }),
    });
    const { resolveOutcome } = dispatchBeforeInstallPrompt("accepted");
    const dialog = await screen.findByRole("dialog", { name: "Install PocketCircle" });

    configureConvex({
      currentUser: makeCurrentUserView({ createdAt: 1, analyticsEnabled: true }),
      acknowledgeFeatureAnnouncement: acknowledge,
      circles: [makeCircleView({ ref: "trip-abc", name: "Trip" })],
    });
    view.rerenderRoutes(<Route path="*" element={<FeatureAnnouncementCard />} />);

    await u.click(within(dialog).getByRole("button", { name: "Install" }));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Install PocketCircle" }),
      ).not.toBeInTheDocument();
    });
    await waitPastEntranceDelay();
    expect(screen.queryByRole("region", { name: ACTIVE_TITLE, hidden: true })).toBeNull();
    expect(posthogSdk.capture).not.toHaveBeenCalledWith(
      "feature_announcement_impression",
      expect.anything(),
    );

    resolveOutcome();
    await waitPastEntranceDelay();
    await waitFor(() => {
      expect(posthogSdk.capture).toHaveBeenCalledWith("feature_announcement_impression", {
        announcement: ACTIVE_ID,
      });
    });
  });

  it("withholds the entrance while iOS Home Screen instructions cover the card", async () => {
    const u = userEvent.setup();
    setNavigatorInstallProps({
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      platform: "iPhone",
      maxTouchPoints: 5,
    });
    const cutoff = Date.parse(activeFeatureAnnouncement()?.eligibleBefore ?? "Invalid Date");
    const view = renderCard({
      path: "/",
      user: makeCurrentUserView({ createdAt: cutoff, analyticsEnabled: true }),
    });
    const promo = await screen.findByRole("dialog", { name: "Install PocketCircle" });

    configureConvex({
      currentUser: makeCurrentUserView({ createdAt: 1, analyticsEnabled: true }),
      acknowledgeFeatureAnnouncement: acknowledge,
      circles: [makeCircleView({ ref: "trip-abc", name: "Trip" })],
    });
    view.rerenderRoutes(<Route path="*" element={<FeatureAnnouncementCard />} />);
    await waitPastEntranceDelay();
    expect(screen.queryByRole("region", { name: ACTIVE_TITLE, hidden: true })).toBeNull();

    await u.click(within(promo).getByRole("button", { name: "Install" }));
    expect(await screen.findByText("Share", { exact: true })).toBeInTheDocument();
    await waitPastEntranceDelay();
    expect(screen.queryByRole("region", { name: ACTIVE_TITLE, hidden: true })).toBeNull();
    expect(posthogSdk.capture).not.toHaveBeenCalledWith(
      "feature_announcement_impression",
      expect.anything(),
    );

    await u.click(screen.getByRole("button", { name: "Got it" }));
    await waitFor(() => {
      expect(screen.queryByText("Share", { exact: true })).not.toBeInTheDocument();
    });
    expect(await findCard()).toBeVisible();
    await waitFor(() => {
      expect(posthogSdk.capture).toHaveBeenCalledWith("feature_announcement_impression", {
        announcement: ACTIVE_ID,
      });
    });
  });
});
