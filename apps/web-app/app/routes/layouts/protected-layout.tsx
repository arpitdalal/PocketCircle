import { useEffect } from "react";
import { href, Link, Navigate, Outlet, useLocation, useNavigation } from "react-router";
import { AccountMenu } from "~/components/account-menu.js";
import {
  CircleBottomNavSkeleton,
  mobileBottomNavClearanceClassName,
} from "~/components/circle-mobile-bottom-nav.js";
import { CircleSwitcher } from "~/components/circle-switcher.js";
import { NotificationCenter } from "~/components/notification-center.js";
import { PwaInstallHeaderButton } from "~/components/pwa-install.js";
import { PageSkeleton } from "~/components/skeleton.js";
import { Splash } from "~/components/splash.js";
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
  const onboardingRedirect = withReturnTo(href("/onboarding"), location.pathname + location.search);
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

  useEffect(() => {
    if (analyticsUserId === undefined || analyticsEnabled === undefined) {
      teardownAnalytics();
      return;
    }
    initAnalytics({ id: analyticsUserId, analyticsEnabled });
  }, [analyticsUserId, analyticsEnabled]);

  useEffect(() => {
    if (MOCKS || readyUserEmail === undefined) {
      return;
    }
    setLastUsedGoogleEmail(readyUserEmail);
  }, [readyUserEmail]);

  if (session.state === "loading") {
    return <Splash />;
  }
  if (session.state === "unauthenticated") {
    return <Navigate to="/signin" replace />;
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
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-border bg-background/80 px-4 pt-[calc(0.75rem+var(--safe-area-top))] pb-3 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <Link
            to="/"
            prefetch="intent"
            className="flex items-center gap-2 font-display text-base font-semibold tracking-tight"
          >
            <BrandMark />
            PocketCircle
          </Link>
          <CircleSwitcher />
        </div>
        <div className="flex items-center gap-1">
          <PwaInstallHeaderButton />
          <NotificationCenter />
          <AccountMenu user={session.user} showSignOut={!MOCKS} />
        </div>
      </header>
      <main
        className={cn(
          "flex-1 px-4 pt-6 sm:pb-6",
          circleBarPainted
            ? mobileBottomNavClearanceClassName
            : "pb-[calc(1.5rem+var(--safe-area-bottom))]",
        )}
      >
        {showSkeleton ? <PageSkeleton /> : <Outlet />}
      </main>
      {showBottomNavSkeleton ? <CircleBottomNavSkeleton /> : null}
    </div>
  );
}

/** The circle motif as the brand glyph: two concentric rings in the accent. */
function BrandMark() {
  return (
    <span
      aria-hidden
      className="relative flex size-6 items-center justify-center rounded-full border-2 border-primary/35"
    >
      <span className="size-2.5 rounded-full bg-primary" />
    </span>
  );
}
