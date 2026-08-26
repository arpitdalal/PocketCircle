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
  source?: { circleRef: string; transactionRef: string } | null | "omit";
  circles?: ReturnType<typeof makeCircleView>[];
}) {
  const user = opts.user ?? makeCurrentUserView({ createdAt: 1 });
  configureConvex({
    currentUser: user,
    acknowledgeFeatureAnnouncement: acknowledge,
    circles: opts.circles ?? [makeCircleView({ ref: "trip-abc", name: "Trip" })],
    ...(opts.source === "omit"
      ? {}
      : {
          featureAnnouncementSource:
            opts.source === undefined
              ? { circleRef: "trip-abc", transactionRef: "shop-xyz" }
              : opts.source,
        }),
  });
  return renderRoutes(<Route path="*" element={<FeatureAnnouncementCard />} />, {
    initialEntries: [opts.path],
  });
}

describe("FeatureAnnouncementCard", () => {
  it("renders on allowed routes when eligible with a source", async () => {
    renderCard({ path: "/?currency=USD&range=3" });
    expect(await screen.findByRole("region", { name: /Duplicate a transaction/i })).toBeVisible();
    const cta = screen.getByRole("link", { name: "Try Duplicate" });
    expect(cta).toHaveAttribute(
      "href",
      "/circles/trip-abc/transactions/shop-xyz?returnTo=%2F%3Fcurrency%3DUSD%26range%3D3",
    );
    expect(
      screen
        .getAllByRole("status")
        .some((node) => /Duplicate a transaction/i.test(node.textContent ?? "")),
    ).toBe(true);
  });

  it("renders nothing while loading, with no source, for new Users, or when acknowledged", () => {
    const { unmount: loading } = renderCard({ path: "/", source: "omit" });
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    loading();

    const { unmount: noSource } = renderCard({ path: "/", source: null });
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    noSource();

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
        acknowledgedFeatureAnnouncementIds: ["duplicate-transaction"],
      }),
    });
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    acknowledged();
  });

  it("does not show on excluded routes", () => {
    renderCard({ path: "/settings" });
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("never steals focus, exposes a labelled region and accessible close, and ignores Escape", async () => {
    const u = userEvent.setup();
    renderCard({ path: "/" });
    const region = await screen.findByRole("region", { name: /Duplicate a transaction/i });
    expect(document.activeElement).not.toBe(region);
    expect(within(region).getByRole("button", { name: "Close" })).toBeVisible();
    await u.keyboard("{Escape}");
    expect(screen.getByRole("region", { name: /Duplicate a transaction/i })).toBeVisible();
  });

  it("optimistically hides on close; mutation failure rolls back and shows the exact toast", async () => {
    const u = userEvent.setup();
    const pending = deferredValue<void>();
    acknowledge.mockImplementation(() => pending.promise);
    renderCard({ path: "/" });
    await screen.findByRole("region", { name: /Duplicate a transaction/i });
    await u.click(screen.getByRole("button", { name: "Close" }));
    expect(acknowledge).toHaveBeenCalledWith({ announcementId: "duplicate-transaction" });
    await waitFor(() => {
      expect(screen.queryByRole("region")).not.toBeInTheDocument();
    });
    pending.reject(new Error("network"));
    expect(await screen.findByText("Couldn't save that preference.")).toBeVisible();
    await waitFor(() => {
      expect(screen.getByRole("region", { name: /Duplicate a transaction/i })).toBeVisible();
    });
    expect(screen.getByTestId("feature-announcement-ack")).toHaveAttribute("data-result", "failed");
  });

  it("records one impression per tab session after genuine visibility", async () => {
    const first = renderCard({ path: "/" });
    await screen.findByRole("region", { name: /Duplicate a transaction/i });
    await waitFor(() => {
      expect(posthogSdk.capture).toHaveBeenCalledWith("feature_announcement_impression", {
        announcement: "duplicate-transaction",
      });
    });
    expect(sessionStorage.getItem(impressionStorageKey("duplicate-transaction"))).toBe("1");
    first.unmount();

    posthogSdk.capture.mockClear();
    // Remount on another route — models a route change in the same tab session.
    const second = renderCard({ path: "/circles/trip-abc/transactions" });
    await screen.findByRole("region", { name: /Duplicate a transaction/i });
    expect(posthogSdk.capture).not.toHaveBeenCalledWith(
      "feature_announcement_impression",
      expect.anything(),
    );
    second.unmount();

    posthogSdk.capture.mockClear();
    // Remount after unmount with the same sessionStorage — models a same-tab reload.
    renderCard({ path: "/" });
    await screen.findByRole("region", { name: /Duplicate a transaction/i });
    expect(posthogSdk.capture).not.toHaveBeenCalledWith(
      "feature_announcement_impression",
      expect.anything(),
    );
  });

  it("keeps stacking below snackbars/dialogs and clears the Circle mobile nav", async () => {
    renderCard({ path: "/circles/trip-abc/transactions" });
    const region = await screen.findByRole("region", { name: /Duplicate a transaction/i });
    expect(region.className).toContain("z-20");
    expect(region.className).toContain("bottom-[calc(var(--mobile-bottom-nav-height)+0.75rem)]");
  });

  it("delays the live announcement and impression while the PWA install modal covers the card", async () => {
    const u = userEvent.setup();
    setNavigatorInstallProps();
    // Start without a source so the card is absent while the PWA modal opens.
    const view = renderCard({ path: "/", source: "omit" });
    dispatchBeforeInstallPrompt();
    const dialog = await screen.findByRole("dialog", { name: "Install PocketCircle" });
    expect(posthogSdk.capture).not.toHaveBeenCalledWith(
      "feature_announcement_impression",
      expect.anything(),
    );

    // Source becomes available under the covering modal — card mounts, no live announce.
    configureConvex({
      currentUser: makeCurrentUserView({ createdAt: 1 }),
      acknowledgeFeatureAnnouncement: acknowledge,
      circles: [makeCircleView({ ref: "trip-abc", name: "Trip" })],
      featureAnnouncementSource: { circleRef: "trip-abc", transactionRef: "shop-xyz" },
    });
    view.rerenderRoutes(<Route path="*" element={<FeatureAnnouncementCard />} />);
    const region = await screen.findByRole("region", {
      name: /Duplicate a transaction/i,
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
        announcement: "duplicate-transaction",
      });
    });
    expect(
      screen
        .getAllByRole("status")
        .some((node) => /Duplicate a transaction/i.test(node.textContent ?? "")),
    ).toBe(true);
  });

  it("delays live announcement while the Chromium native install prompt is pending", async () => {
    const u = userEvent.setup();
    setNavigatorInstallProps();
    const view = renderCard({ path: "/", source: "omit" });
    const { resolveOutcome } = dispatchBeforeInstallPrompt("accepted");
    const dialog = await screen.findByRole("dialog", { name: "Install PocketCircle" });

    configureConvex({
      currentUser: makeCurrentUserView({ createdAt: 1 }),
      acknowledgeFeatureAnnouncement: acknowledge,
      circles: [makeCircleView({ ref: "trip-abc", name: "Trip" })],
      featureAnnouncementSource: { circleRef: "trip-abc", transactionRef: "shop-xyz" },
    });
    view.rerenderRoutes(<Route path="*" element={<FeatureAnnouncementCard />} />);
    await screen.findByRole("heading", {
      name: "Duplicate a transaction",
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
        announcement: "duplicate-transaction",
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
    // Omit source until the promo covers the app — same arbitration shape as Chromium BIP.
    const view = renderCard({ path: "/", source: "omit" });
    const promo = await screen.findByRole("dialog", { name: "Install PocketCircle" });
    expect(posthogSdk.capture).not.toHaveBeenCalledWith(
      "feature_announcement_impression",
      expect.anything(),
    );

    configureConvex({
      currentUser: makeCurrentUserView({ createdAt: 1 }),
      acknowledgeFeatureAnnouncement: acknowledge,
      circles: [makeCircleView({ ref: "trip-abc", name: "Trip" })],
      featureAnnouncementSource: { circleRef: "trip-abc", transactionRef: "shop-xyz" },
    });
    view.rerenderRoutes(<Route path="*" element={<FeatureAnnouncementCard />} />);
    expect(
      await screen.findByRole("heading", {
        name: "Duplicate a transaction",
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
        announcement: "duplicate-transaction",
      });
    });
  });
});
