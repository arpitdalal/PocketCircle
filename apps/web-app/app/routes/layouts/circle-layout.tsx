import { MessageSquare, Settings } from "lucide-react";
import type { ReactNode } from "react";
import { href, Link, Navigate, NavLink, Outlet, useLocation, useOutletContext } from "react-router";
import { CircleMark } from "~/components/circle-mark.js";
import { CircleMobileBottomNav } from "~/components/circle-mobile-bottom-nav.js";
import { PageSkeleton } from "~/components/skeleton.js";
import { Splash } from "~/components/splash.js";
import { circleNavItems } from "~/lib/circle-nav.js";
import { useMembers } from "~/lib/data.js";
import { useReturnToOrigin, withReturnTo } from "~/lib/return-to-url.js";
import { coversCircleNavigation, usePendingRouteSkeleton } from "~/lib/route-skeleton.js";
import { type Circle, useResolvedCircle } from "~/lib/use-resolved-circle.js";
import { cn } from "~/lib/utils.js";

export interface CircleOutletContext {
  circle: Circle;
}

/** Reads the resolved Circle provided by the Circle guard layout. */
export function useCircle(): Circle {
  return useOutletContext<CircleOutletContext>().circle;
}

const chromeIconLinkClass =
  "flex size-9 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:border-ring/60 hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

function CircleChromeIconLink({
  to,
  label,
  children,
}: {
  to: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      prefetch="intent"
      aria-label={label}
      title={label}
      className={chromeIconLinkClass}
    >
      {children}
    </Link>
  );
}

/**
 * Circle guard layout for `/circles/:circleRef`. Resolves, canonicalizes, and
 * guards the Circle, then provides it to children via Outlet context (ADR 0017).
 */
export default function CircleLayout() {
  const resolution = useResolvedCircle();
  // Hooks run unconditionally (the Splash early-return is below), so the pending-
  // navigation subscription is stable across the guard's pending → resolved flip.
  const showSkeleton = usePendingRouteSkeleton(coversCircleNavigation);

  if (resolution.status === "pending") {
    return <Splash label="Opening circle…" />;
  }

  return <ResolvedCircleLayout circle={resolution.value} showSkeleton={showSkeleton} />;
}

function ResolvedCircleLayout({ circle, showSkeleton }: { circle: Circle; showSkeleton: boolean }) {
  const location = useLocation();
  const origin = useReturnToOrigin();
  const setupPath = href("/circles/:circleRef/setup", { circleRef: circle.ref });
  const tabs = circleNavItems(circle.ref);
  const members = useMembers(circle.id);
  const showSettings =
    members !== undefined && members?.find((member) => member.isSelf)?.role === "owner";
  const settingsPath = href("/circles/:circleRef/settings", { circleRef: circle.ref });
  const feedbackPath = href("/circles/:circleRef/feedback", { circleRef: circle.ref });
  const onFeedback = location.pathname === feedbackPath;

  if (!circle.setupComplete && location.pathname !== setupPath) {
    return <Navigate to={setupPath} replace />;
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-center gap-3">
        <CircleMark mark={circle.mark} color={circle.color} className="size-11 text-base" />
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-xl font-semibold tracking-tight">{circle.name}</h1>
          <p className="text-xs text-muted-foreground">
            {circle.kind === "personal" ? "Your Circle" : "Circle"} · {circle.currency}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {onFeedback ? null : (
            <CircleChromeIconLink
              to={withReturnTo(feedbackPath, origin)}
              label={`Send feedback about ${circle.name}`}
            >
              <MessageSquare aria-hidden className="size-4" />
            </CircleChromeIconLink>
          )}
          {showSettings ? (
            <CircleChromeIconLink to={settingsPath} label="Circle settings">
              <Settings aria-hidden className="size-4" />
            </CircleChromeIconLink>
          ) : null}
        </div>
      </div>

      <nav
        aria-label="Circle tabs"
        className="-mx-4 hidden gap-1 overflow-x-auto border-b border-border px-4 sm:flex"
      >
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            prefetch="intent"
            className={({ isActive }) =>
              cn(
                "shrink-0 border-b-2 px-3 py-2 text-sm transition-colors duration-150",
                isActive
                  ? "border-primary font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
              )
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>

      <CircleMobileBottomNav circle={circle} />

      {showSkeleton ? (
        <PageSkeleton />
      ) : (
        <Outlet context={{ circle } satisfies CircleOutletContext} />
      )}
    </div>
  );
}
