import { isPushNotificationClickReturnTo } from "@pocketcircle/domain";
import { useEffect, useState } from "react";
import { href, Link, Navigate, Outlet, useLocation, useNavigation } from "react-router";
import { AccountMenu } from "~/components/account-menu.js";
import { ActivationChecklistProvider } from "~/components/activation-checklist-provider.js";
import { AppSidebar } from "~/components/app-sidebar.js";
import { BrandMark } from "~/components/brand-mark.js";
import {
  CircleBottomNavSkeleton,
  mobileBottomNavClearanceClassName,
} from "~/components/circle-mobile-bottom-nav.js";
import { CircleSwitcher } from "~/components/circle-switcher.js";
import { FeatureAnnouncementCard } from "~/components/feature-announcement-card.js";
import { MarketingHome } from "~/components/marketing-home.js";
import { NotificationAnnouncementStrip } from "~/components/notification-announcement-strip.js";
import { NotificationCenter } from "~/components/notification-center.js";
import { PushNotificationClickListener } from "~/components/push-notification-click-listener.js";
import { PushSubscriptionLifecycle } from "~/components/push-subscription-lifecycle.js";
import { PwaInstallHeaderButton } from "~/components/pwa-install.js";
import { PageSkeleton } from "~/components/skeleton.js";
import { MAIN_CONTENT_ID, SkipNavigation } from "~/components/skip-navigation.js";
import { Splash } from "~/components/splash.js";
import { SidebarInset, SidebarProvider } from "~/components/ui/sidebar.js";
import { initAnalytics, teardownAnalytics } from "~/lib/analytics.js";
import { isCircleScopedPath } from "~/lib/circle-path.js";
import { MOCKS } from "~/lib/env.js";
import { setLastUsedGoogleEmail } from "~/lib/last-used-google-email.js";
import { parseReturnTo, RETURN_TO_PARAM, withReturnTo } from "~/lib/return-to-url.js";
import { coversShellNavigation, usePendingRouteSkeleton } from "~/lib/route-skeleton.js";
import { useAppSession } from "~/lib/session.js";
import { cn } from "~/lib/utils.js";

/**
 * Gates the authenticated app across auth states (ADR 0017) and the product
 * Onboarding funnel (USR-1). The permission check is the reactive session
 * result, so live sign-out / revocation stay reactive with no second guard path.
 */
export default function ProtectedLayout() {
  const session = useAppSession();
  const location = useLocation();
  const onOnboarding = location.pathname === "/onboarding";
  const returnToCandidate = location.pathname + location.search;
  const shouldPreserveReturnTo =
    location.pathname === "/mcp/authorize" ||
    location.pathname.startsWith("/mcp/authorize?") ||
    location.pathname.startsWith("/mcp/authorize#") ||
    isPushNotificationClickReturnTo(returnToCandidate);
  const signinRedirect = shouldPreserveReturnTo
    ? withReturnTo(href("/signin"), returnToCandidate)
    : href("/signin");
  const onboardingRedirect = withReturnTo(href("/onboarding"), returnToCandidate);
  const postOnboardingTarget = parseReturnTo(
    new URLSearchParams(location.search).get(RETURN_TO_PARAM),
    { fallback: "/" },
  );
  // Unconditional so the pending-navigation subscription is stable across the auth
  // guard's state flips; only consulted in the Ready branch below.
  const showSkeleton = usePendingRouteSkeleton(coversShellNavigation);
  // When the shell skeleton covers a navigation INTO a Circle (a cross-Circle switch,
  // or Home→Circle), keep a Circle bottom-bar placeholder mounted so the mobile bar
  // doesn't flash out while CircleLayout is unmounted — the destination is a Circle, so
  // it will own a real bar once it resolves.
  const navigation = useNavigation();
  const pendingTo = navigation.location?.pathname;
  const showBottomNavSkeleton = showSkeleton && pendingTo != null && isCircleScopedPath(pendingTo);
  // Clearance tracks a painted bar, not "this is a protected route". Home/Settings have
  // no Circle bar (ADR 0022); Circle→Home unmounts it with the shell skeleton.
  const circleBarPainted =
    showBottomNavSkeleton || (!showSkeleton && isCircleScopedPath(location.pathname));
  const analyticsSession =
    session.state === "ready" && session.user.onboardingComplete ? session.user : undefined;
  const analyticsUserId = analyticsSession?.id;
  const analyticsEnabled = analyticsSession?.analyticsEnabled;
  const readyUserEmail = session.state === "ready" ? session.user.email : undefined;
  // Strip reports when it covers the viewport top so header drops duplicate safe-area.
  const [notificationStripOwnsTopSafeArea, setNotificationStripOwnsTopSafeArea] = useState(false);
  // Mount on every auth gate (Splash / MarketingHome), not only the ready shell —
  // SW postMessage is last-resort after openWindow fails (#384).
  const pushClickListener = !MOCKS ? <PushNotificationClickListener /> : null;

  useEffect(() => {
    if (analyticsUserId === undefined || analyticsEnabled === undefined) {
      teardownAnalytics();
      return;
    }
    void initAnalytics({ id: analyticsUserId, analyticsEnabled });
  }, [analyticsUserId, analyticsEnabled]);

  useEffect(() => {
    if (MOCKS || readyUserEmail === undefined) {
      return;
    }
    setLastUsedGoogleEmail(readyUserEmail);
  }, [readyUserEmail]);

  if (session.state === "loading") {
    return (
      <>
        {pushClickListener}
        <Splash />
      </>
    );
  }
  if (session.state === "unauthenticated") {
    // `/` stays public so Google branding (and visitors) see product purpose
    // instead of a login-only redirect. Other protected paths still require sign-in.
    if (location.pathname === "/") {
      return (
        <>
          {pushClickListener}
          <MarketingHome />
        </>
      );
    }
    return <Navigate to={signinRedirect} replace />;
  }
  if (session.state === "bootstrap") {
    return onOnboarding ? <Outlet /> : <Navigate to={onboardingRedirect} replace />;
  }
  if (!session.user.onboardingComplete) {
    return onOnboarding ? <Outlet /> : <Navigate to={onboardingRedirect} replace />;
  }
  if (onOnboarding) {
    return <Navigate to={postOnboardingTarget} replace />;
  }

  return (
    // The sidebar replaces the header at `lg` and above (issue #351). Both chromes are
    // always in the tree; CSS alone picks which is painted, so no JavaScript viewport
    // branch can desync server and client markup.
    <SidebarProvider className="bg-background">
      {/* One Activation Checklist subscription for both presentations (Home card and
          sidebar launcher), so its initialize / completion mutations fire once. */}
      <ActivationChecklistProvider>
        {/* First tab stop: bypass the sidebar / sticky header (WCAG 2.4.1 / issue #312). */}
        <SkipNavigation />
        <AppSidebar user={session.user} showSignOut={!MOCKS} />
        <SidebarInset>
          <NotificationAnnouncementStrip
            onOwnsTopSafeAreaChange={setNotificationStripOwnsTopSafeArea}
          />
          <header
            className={cn(
              "sticky top-0 z-30 flex items-center justify-between border-b border-border bg-background/80 px-4 pb-3 backdrop-blur-md lg:hidden",
              // Strip owns the notch inset while it covers the top edge; otherwise the
              // sticky header must (MDN sticky + env(safe-area) prior art).
              notificationStripOwnsTopSafeArea ? "pt-3" : "pt-[calc(0.75rem+var(--safe-area-top))]",
            )}
          >
            <div className="flex items-center gap-3">
              <Link
                to="/"
                prefetch="intent"
                className="flex items-center gap-2 font-display text-base font-semibold tracking-tight"
              >
                <BrandMark />
                PocketCircle
              </Link>
              <CircleSwitcher chrome="header" />
            </div>
            <div className="flex items-center gap-1">
              <PwaInstallHeaderButton />
              <NotificationCenter chrome="header" />
              <AccountMenu chrome="header" user={session.user} showSignOut={!MOCKS} />
            </div>
          </header>
          {/* outline-none: APG skip-target; next Tab shows focus-visible on a real control. */}
          <main
            id={MAIN_CONTENT_ID}
            tabIndex={-1}
            className={cn(
              "flex-1 px-4 pt-6 outline-none sm:pb-6",
              circleBarPainted
                ? mobileBottomNavClearanceClassName
                : "pb-[calc(1.5rem+var(--safe-area-bottom))]",
            )}
          >
            {showSkeleton ? <PageSkeleton /> : <Outlet />}
          </main>
          {showBottomNavSkeleton ? <CircleBottomNavSkeleton /> : null}
        </SidebarInset>
        <FeatureAnnouncementCard />
        {!MOCKS ? <PushSubscriptionLifecycle key={session.user.id} /> : null}
        {pushClickListener}
      </ActivationChecklistProvider>
    </SidebarProvider>
  );
}
