import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureAnnouncementCard } from "~/components/feature-announcement-card.js";
import { activeFeatureAnnouncement, impressionStorageKey } from "~/lib/feature-announcements.js";
import {
  configureConvex,
  convexReactMock,
  deferredValue,
  makeCircleView,
  makeCurrentUserView,
  renderRoutes,
} from "~/test/convex-react.js";
import {
  posthogSdk,
  primeAnalyticsForTests,
  resetPostHogBoundary,
} from "~/test/posthog-boundary.js";
import {
  clearPwaInstallPromptDismissal,
  dispatchBeforeInstallPrompt,
  installMatchMediaFake,
  resetNavigatorInstallProps,
  setNavigatorInstallProps,
} from "~/test/pwa-install-env.js";

vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);
vi.mock("posthog-js", async () => (await import("~/test/posthog-mock.js")).posthogModuleMock);

const acknowledge = vi.fn().mockResolvedValue(undefined);
const ACTIVE_TITLE = /Connect PocketCircle to your AI assistant/i;
const ACTIVE_ID = "mcp-connections" as const;

beforeEach(() => {
  sessionStorage.clear();
  clearPwaInstallPromptDismissal();
  resetNavigatorInstallProps();
  installMatchMediaFake(false);
  acknowledge.mockReset();
  acknowledge.mockResolvedValue(undefined);
  primeAnalyticsForTests(makeCurrentUserView({ createdAt: 1, analyticsEnabled: true }));
  posthogSdk.capture.mockClear();
  convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });
});

afterEach(() => {
  sessionStorage.clear();
  clearPwaInstallPromptDismissal();
  resetNavigatorInstallProps();
  resetPostHogBoundary();
});

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
  it("renders on allowed routes when eligible without a Transaction source", async () => {
    renderCard({ path: "/?currency=USD&range=3" });
    expect(await screen.findByRole("region", { name: ACTIVE_TITLE })).toBeVisible();
    const cta = screen.getByRole("link", { name: "Open Connections" });
    expect(cta).toHaveAttribute("href", "/connections?returnTo=%2F%3Fcurrency%3DUSD%26range%3D3");
    expect(
      screen.getAllByRole("status").some((node) => ACTIVE_TITLE.test(node.textContent ?? "")),
    ).toBe(true);
  });

  it("renders nothing for new Users or when acknowledged", () => {
    const cutoff = Date.parse(activeFeatureAnnouncement()?.eligibleBefore ?? "Invalid Date");
    const { unmount: newUser } = renderCard({
      path: "/",
      user: makeCurrentUserView({ createdAt: cutoff }),
    });
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    newUser();

    const { unmount: acknowledged } = renderCard({
      path: "/",
      user: makeCurrentUserView({
        createdAt: 1,
        acknowledgedFeatureAnnouncementIds: [ACTIVE_ID],
      }),
    });
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    acknowledged();
  });

  it("does not show on excluded routes including Connections", () => {
    renderCard({ path: "/settings" });
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    renderCard({ path: "/connections" });
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("never steals focus, exposes a labelled region and accessible close, and ignores Escape", async () => {
    const u = userEvent.setup();
    renderCard({ path: "/" });
    const region = await screen.findByRole("region", { name: ACTIVE_TITLE });
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
    await screen.findByRole("region", { name: ACTIVE_TITLE });
    await u.click(screen.getByRole("button", { name: "Close" }));
    expect(acknowledge).toHaveBeenCalledWith({ announcementId: ACTIVE_ID });
    await waitFor(() => {
      expect(screen.queryByRole("region")).not.toBeInTheDocument();
    });
    pending.reject(new Error("network"));
    expect(await screen.findByText("Couldn't save that preference.")).toBeVisible();
    await waitFor(() => {
      expect(screen.getByRole("region", { name: ACTIVE_TITLE })).toBeVisible();
    });
    expect(screen.getByTestId("feature-announcement-ack")).toHaveAttribute("data-result", "failed");
  });

  it("records one impression per tab session after genuine visibility", async () => {
    const first = renderCard({ path: "/" });
    await screen.findByRole("region", { name: ACTIVE_TITLE });
    await waitFor(() => {
      expect(posthogSdk.capture).toHaveBeenCalledWith("feature_announcement_impression", {
        announcement: ACTIVE_ID,
      });
    });
    expect(sessionStorage.getItem(impressionStorageKey(ACTIVE_ID))).toBe("1");
    first.unmount();

    posthogSdk.capture.mockClear();
    const second = renderCard({ path: "/circles/trip-abc/transactions" });
    await screen.findByRole("region", { name: ACTIVE_TITLE });
    expect(posthogSdk.capture).not.toHaveBeenCalledWith(
      "feature_announcement_impression",
      expect.anything(),
    );
    second.unmount();

    posthogSdk.capture.mockClear();
    renderCard({ path: "/" });
    await screen.findByRole("region", { name: ACTIVE_TITLE });
    expect(posthogSdk.capture).not.toHaveBeenCalledWith(
      "feature_announcement_impression",
      expect.anything(),
    );
  });

  it("keeps stacking below snackbars/dialogs and clears the Circle mobile nav", async () => {
    renderCard({ path: "/circles/trip-abc/transactions" });
    const region = await screen.findByRole("region", { name: ACTIVE_TITLE });
    expect(region.className).toContain("z-20");
    expect(region.className).toContain("bottom-[calc(var(--mobile-bottom-nav-height)+0.75rem)]");
  });

  it("delays the live announcement and impression while the PWA install modal covers the card", async () => {
    const u = userEvent.setup();
    setNavigatorInstallProps();
    // Start ineligible so the card is absent while the PWA modal opens.
    const cutoff = Date.parse(activeFeatureAnnouncement()?.eligibleBefore ?? "Invalid Date");
    const view = renderCard({
      path: "/",
      user: makeCurrentUserView({ createdAt: cutoff, analyticsEnabled: true }),
    });
    dispatchBeforeInstallPrompt();
    const dialog = await screen.findByRole("dialog", { name: "Install PocketCircle" });
    expect(posthogSdk.capture).not.toHaveBeenCalledWith(
      "feature_announcement_impression",
      expect.anything(),
    );

    // Become eligible under the covering modal — card mounts, no live announce.
    configureConvex({
      currentUser: makeCurrentUserView({ createdAt: 1, analyticsEnabled: true }),
      acknowledgeFeatureAnnouncement: acknowledge,
      circles: [makeCircleView({ ref: "trip-abc", name: "Trip" })],
    });
    view.rerenderRoutes(<Route path="*" element={<FeatureAnnouncementCard />} />);
    const region = await screen.findByRole("region", {
      name: ACTIVE_TITLE,
      hidden: true,
    });
    expect(region).toBeInTheDocument();
    expect(posthogSdk.capture).not.toHaveBeenCalledWith(
      "feature_announcement_impression",
      expect.anything(),
    );
    const liveStatuses = screen.getAllByRole("status", { hidden: true });
    expect(liveStatuses.some((node) => node.textContent === "")).toBe(true);

    await u.click(within(dialog).getByRole("button", { name: "Not now" }));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Install PocketCircle" }),
      ).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(posthogSdk.capture).toHaveBeenCalledWith("feature_announcement_impression", {
        announcement: ACTIVE_ID,
      });
    });
    expect(
      screen.getAllByRole("status").some((node) => ACTIVE_TITLE.test(node.textContent ?? "")),
    ).toBe(true);
  });

  it("delays live announcement while the Chromium native install prompt is pending", async () => {
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
    await screen.findByRole("heading", {
      name: "Connect PocketCircle to your AI assistant",
      hidden: true,
    });

    await u.click(within(dialog).getByRole("button", { name: "Install" }));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Install PocketCircle" }),
      ).not.toBeInTheDocument();
    });
    expect(posthogSdk.capture).not.toHaveBeenCalledWith(
      "feature_announcement_impression",
      expect.anything(),
    );

    resolveOutcome();
    await waitFor(() => {
      expect(posthogSdk.capture).toHaveBeenCalledWith("feature_announcement_impression", {
        announcement: ACTIVE_ID,
      });
    });
  });

  it("delays live announcement while iOS Home Screen instructions cover the card", async () => {
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
    expect(posthogSdk.capture).not.toHaveBeenCalledWith(
      "feature_announcement_impression",
      expect.anything(),
    );

    configureConvex({
      currentUser: makeCurrentUserView({ createdAt: 1, analyticsEnabled: true }),
      acknowledgeFeatureAnnouncement: acknowledge,
      circles: [makeCircleView({ ref: "trip-abc", name: "Trip" })],
    });
    view.rerenderRoutes(<Route path="*" element={<FeatureAnnouncementCard />} />);
    expect(
      await screen.findByRole("heading", {
        name: "Connect PocketCircle to your AI assistant",
        hidden: true,
      }),
    ).toBeInTheDocument();
    expect(posthogSdk.capture).not.toHaveBeenCalledWith(
      "feature_announcement_impression",
      expect.anything(),
    );

    await u.click(within(promo).getByRole("button", { name: "Install" }));
    expect(await screen.findByText("Share", { exact: true })).toBeInTheDocument();
    expect(posthogSdk.capture).not.toHaveBeenCalledWith(
      "feature_announcement_impression",
      expect.anything(),
    );
    expect(
      screen.getAllByRole("status", { hidden: true }).some((node) => node.textContent === ""),
    ).toBe(true);

    await u.click(screen.getByRole("button", { name: "Got it" }));
    await waitFor(() => {
      expect(screen.queryByText("Share", { exact: true })).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(posthogSdk.capture).toHaveBeenCalledWith("feature_announcement_impression", {
        announcement: ACTIVE_ID,
      });
    });
  });
});
