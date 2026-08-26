import { XIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Link, useLocation } from "react-router";
import { usePwaInstall } from "~/components/pwa-install.js";
import { buttonVariants } from "~/components/ui/button-variants.js";
import { track } from "~/lib/analytics.js";
import {
  useAcknowledgeFeatureAnnouncement,
  useFeatureAnnouncementSource,
  useMyCircles,
} from "~/lib/data.js";
import { MOCKS } from "~/lib/env.js";
import {
  activeFeatureAnnouncement,
  featureAnnouncementRouteScope,
  hasRecordedImpression,
  isEligibleForFeatureAnnouncement,
  markImpressionRecorded,
} from "~/lib/feature-announcements.js";
import { transactionDetailHref } from "~/lib/ledger-url.js";
import { useReturnToOrigin, withReturnTo } from "~/lib/return-to-url.js";
import type { SessionUser } from "~/lib/session.js";
import { useAppSession } from "~/lib/session.js";
import { useSnackbar } from "~/lib/snackbar.js";
import { cn } from "~/lib/utils.js";

const ACK_FAILURE_TOAST = "Couldn't save that preference.";

/**
 * Fixed non-modal Feature Announcement card (#282). Mounted from the protected
 * shell so it can coexist with Home Activation Checklist and stay behind the
 * PWA install modal / snackbars. Never steals focus; no Escape / backdrop.
 * Reads the live session so Convex optimistic acknowledgment hides it immediately.
 */
export function FeatureAnnouncementCard() {
  const session = useAppSession();
  if (session.state !== "ready") {
    return null;
  }
  return <FeatureAnnouncementCardBody user={session.user} />;
}

function FeatureAnnouncementCardBody({ user }: { user: SessionUser }) {
  const location = useLocation();
  const returnTo = useReturnToOrigin();
  const { show } = useSnackbar();
  const { showInstallPrompt } = usePwaInstall();
  const acknowledge = useAcknowledgeFeatureAnnouncement();
  const titleId = useId();
  const [liveMessage, setLiveMessage] = useState("");

  const announcement = activeFeatureAnnouncement();
  const scope = featureAnnouncementRouteScope(location.pathname);
  const eligible =
    announcement !== null && scope !== null && isEligibleForFeatureAnnouncement(announcement, user);

  const circles = useMyCircles();
  const circleId =
    scope?.kind === "circle"
      ? circles?.find((circle) => circle.ref === scope.circleRef)?.id
      : undefined;
  const circleLookupPending = scope?.kind === "circle" && circles === undefined;
  const circleMissing = scope?.kind === "circle" && circles !== undefined && circleId === undefined;

  const sourceEnabled = !MOCKS && eligible && !circleLookupPending && !circleMissing;
  const source = useFeatureAnnouncementSource(circleId, sourceEnabled);

  const sourceReady = source !== undefined;
  const hasSource = source != null;
  const visible =
    eligible && !circleLookupPending && !circleMissing && sourceReady && hasSource && source;

  // Genuinely visible: mounted card not covered by the PWA install modal.
  const liveVisible = Boolean(visible) && !showInstallPrompt;

  useEffect(() => {
    if (!liveVisible || !announcement) {
      return;
    }
    setLiveMessage(`${announcement.label}. ${announcement.title}. ${announcement.body}`);
    if (!hasRecordedImpression(announcement.id)) {
      markImpressionRecorded(announcement.id);
      track("feature_announcement_impression", { announcement: announcement.id });
    }
  }, [liveVisible, announcement]);

  if (!visible || !announcement) {
    return null;
  }

  const detailPath = withReturnTo(
    transactionDetailHref({ ref: visible.circleRef }, { ref: visible.transactionRef }),
    returnTo,
  );

  const fireAcknowledge = () => {
    void acknowledge({ announcementId: announcement.id }).catch(() => {
      show(ACK_FAILURE_TOAST);
    });
  };

  const onCtaClick = () => {
    track("feature_announcement_cta_clicked", { announcement: announcement.id });
    fireAcknowledge();
  };

  const onDismiss = () => {
    track("feature_announcement_dismissed", { announcement: announcement.id });
    fireAcknowledge();
  };

  const aboveCircleNav = scope.kind === "circle";

  return (
    <>
      <section
        aria-labelledby={titleId}
        className={cn(
          // Below Circle nav (z-30), dialogs (z-50), and snackbars (z-60).
          "pointer-events-auto fixed z-20 w-[min(22rem,calc(100vw-1.5rem))] rounded-lg border border-border bg-background p-4 shadow-md",
          "left-[max(0.75rem,var(--safe-area-left,0px))]",
          aboveCircleNav
            ? "bottom-[calc(var(--mobile-bottom-nav-height)+0.75rem)] sm:bottom-[max(0.75rem,var(--safe-area-bottom))]"
            : "bottom-[max(0.75rem,var(--safe-area-bottom))]",
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="text-xs font-medium tracking-wide text-primary uppercase">
              {announcement.label}
            </p>
            <h2 id={titleId} className="font-display text-base font-semibold tracking-tight">
              {announcement.title}
            </h2>
            <p className="text-sm text-muted-foreground">{announcement.body}</p>
          </div>
          <button
            type="button"
            aria-label="Close"
            className={cn(
              buttonVariants({ variant: "ghost", size: "icon-xs" }),
              "shrink-0 text-muted-foreground",
            )}
            onClick={onDismiss}
          >
            <XIcon />
          </button>
        </div>
        <div className="mt-3">
          <Link
            to={detailPath}
            state={{ featureAnnouncementFocus: announcement.id }}
            className={buttonVariants({ variant: "default", size: "sm" })}
            onClick={onCtaClick}
          >
            {announcement.ctaLabel}
          </Link>
        </div>
      </section>
      <p className="sr-only" role="status" aria-live="polite">
        {liveVisible ? liveMessage : ""}
      </p>
    </>
  );
}
