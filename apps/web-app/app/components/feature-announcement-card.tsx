import type { FeatureAnnouncementId } from "@pocketcircle/domain";
import { XIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Link, useLocation } from "react-router";
import { usePwaInstall } from "~/components/pwa-install.js";
import { buttonVariants } from "~/components/ui/button-variants.js";
import { track } from "~/lib/analytics.js";
import { useAcknowledgeFeatureAnnouncement } from "~/lib/data.js";
import {
  ANNOUNCEMENT_ENTRANCE_DELAY_MS,
  activeFeatureAnnouncement,
  announcementLiveMessage,
  featureAnnouncementRouteScope,
  hasRecordedImpression,
  isEligibleForFeatureAnnouncement,
  markImpressionRecorded,
} from "~/lib/feature-announcements.js";
import { usePrefersReducedMotion } from "~/lib/motion.js";
import { useReturnToOrigin, withReturnTo } from "~/lib/return-to-url.js";
import type { SessionUser } from "~/lib/session.js";
import { useAppSession } from "~/lib/session.js";
import { useSnackbar } from "~/lib/snackbar.js";
import { useValueChange } from "~/lib/use-value-change.js";
import { cn } from "~/lib/utils.js";

const ACK_FAILURE_TOAST = "Couldn't save that preference.";

/**
 * Fixed non-modal Feature Announcement card (#282, enriched in #334). Mounted from
 * the protected shell so it can coexist with the Home Activation Checklist and stay
 * behind the PWA install modal / snackbars. Never steals focus; no Escape / backdrop.
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
  const { installSurfaceOpen } = usePwaInstall();
  const acknowledge = useAcknowledgeFeatureAnnouncement();
  const titleId = useId();
  // Tracks server settlement even after optimistic hide removes the visible card.
  const [ackResult, setAckResult] = useState<"saved" | "failed" | null>(null);
  const [entranceElapsed, setEntranceElapsed] = useState(false);
  const [heroFailed, setHeroFailed] = useState(false);
  const [liveMessage, setLiveMessage] = useState("");
  const prefersReducedMotion = usePrefersReducedMotion();

  const announcement = activeFeatureAnnouncement();
  const scope = featureAnnouncementRouteScope(location.pathname);
  const eligible =
    announcement !== null && scope !== null && isEligibleForFeatureAnnouncement(announcement, user);

  // Genuinely showable: eligible on an allowed route and not covered by the soft
  // install promo or the iOS Home Screen instructions.
  const showable = eligible && !installSurfaceOpen;
  // Under reduced motion the entrance animation is already neutralized by the
  // global reset, so there is no motion to land and no beat worth waiting for.
  const revealed = entranceElapsed || (showable && prefersReducedMotion);

  // One-shot entrance. `entranceElapsed` latches, so a later install-surface
  // toggle cannot replay the delay for a card the User has already seen.
  useEffect(() => {
    if (!showable || entranceElapsed || prefersReducedMotion) {
      return;
    }
    const timer = setTimeout(() => {
      setEntranceElapsed(true);
    }, ANNOUNCEMENT_ENTRANCE_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [showable, entranceElapsed, prefersReducedMotion]);

  const visible = eligible && revealed;
  // `revealed` latches, so an acknowledgment rollback could otherwise restore the
  // card while an install surface covers it. One rule for render, impressions, and
  // the spoken announcement: the card is in the DOM only when genuinely on screen.
  const onScreen = visible && !installSurfaceOpen;

  useEffect(() => {
    if (!onScreen || !announcement) {
      return;
    }
    if (!hasRecordedImpression(announcement.id)) {
      markImpressionRecorded(announcement.id);
      track("feature_announcement_impression", { announcement: announcement.id });
    }
  }, [onScreen, announcement]);

  // Reset during render (ADR 0025) so the region is empty again before the next
  // appearance repopulates it — an Effect would leave one stale spoken frame.
  useValueChange(onScreen, (current) => {
    if (!current) {
      setLiveMessage("");
    }
  });

  // Live regions announce CHANGES, not initial content: a region created with its
  // text already in place is announced by almost no browser/screen-reader pair.
  // So the region below stays mounted and empty, and the text lands in a later
  // task. https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Guides/Live_regions
  useEffect(() => {
    if (!onScreen || !announcement) {
      return;
    }
    const timer = setTimeout(() => {
      setLiveMessage(announcementLiveMessage(announcement));
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, [onScreen, announcement]);

  const fireAcknowledge = (announcementId: FeatureAnnouncementId) => {
    void acknowledge({ announcementId })
      .then(() => {
        setAckResult("saved");
      })
      .catch(() => {
        setAckResult("failed");
        show(ACK_FAILURE_TOAST);
      });
  };

  const onCtaClick = () => {
    if (!announcement) {
      return;
    }
    track("feature_announcement_cta_clicked", { announcement: announcement.id });
    fireAcknowledge(announcement.id);
  };

  const onDismiss = () => {
    if (!announcement) {
      return;
    }
    track("feature_announcement_dismissed", { announcement: announcement.id });
    fireAcknowledge(announcement.id);
  };

  const aboveCircleNav = scope?.kind === "circle";

  return (
    <>
      {ackResult !== null ? (
        <div hidden data-testid="feature-announcement-ack" data-result={ackResult} />
      ) : null}
      {onScreen && announcement ? (
        <section
          aria-labelledby={titleId}
          className={cn(
            // Below Circle nav (z-30), dialogs (z-50), and snackbars (z-60).
            "pointer-events-auto fixed z-20 flex flex-col overflow-hidden rounded-lg border border-border bg-background shadow-md",
            // Fluid width: never wider than the viewport allows on a phone, grows
            // with the viewport past ~1000px, capped at 32rem. One clamp instead
            // of a breakpoint ladder — the hero follows via `aspect-video w-full`.
            "w-[clamp(min(22rem,100vw-1.5rem),35vw,32rem)]",
            "animate-slide-up left-[max(0.75rem,var(--safe-area-left,0px))]",
            // `svh` (toolbar-shown height) so an expanded mobile toolbar cannot
            // clip the card, minus the sticky header it must stop below and the
            // Circle nav it must clear. A guard for landscape / large font
            // scales — portrait copy is sized to fit without scrolling.
            aboveCircleNav
              ? "bottom-[calc(var(--mobile-bottom-nav-height)+0.75rem)] max-h-[calc(100svh-var(--app-header-height)-var(--mobile-bottom-nav-height)-1.5rem)] sm:bottom-[max(0.75rem,var(--safe-area-bottom))] sm:max-h-[calc(100svh-var(--app-header-height)-1.5rem)]"
              : "bottom-[max(0.75rem,var(--safe-area-bottom))] max-h-[calc(100svh-var(--app-header-height)-1.5rem)]",
          )}
        >
          {/* Hero bleeds to the card edges; the close button rides its top-right
                corner (Cursor's pattern) with its own scrim so contrast never
                depends on the image. Stays outside the scroll region below. The
                wrapper owns the 16:9 box, so a failed load leaves a muted panel
                rather than collapsing the layout. */}
          <div
            className="relative aspect-video w-full shrink-0 bg-muted"
            data-testid="feature-announcement-hero"
          >
            {heroFailed ? null : (
              <img
                src={announcement.heroImage.src}
                alt={announcement.heroImage.alt}
                width={1280}
                height={720}
                // The card only mounts when it is about to be on screen, so
                // there is nothing to defer — `lazy` would only risk a delay.
                loading="eager"
                decoding="async"
                // Drop the element on error: the browser's broken-image glyph
                // inside a promo card looks worse than a plain muted panel, and
                // the title and highlights already carry the message.
                onError={() => {
                  setHeroFailed(true);
                }}
                className="size-full object-cover"
              />
            )}
            <button
              type="button"
              aria-label="Close"
              className={cn(
                buttonVariants({ variant: "ghost" }),
                "absolute top-2 right-2 size-7 rounded-full p-0 xl:size-8",
                // Barely-there scrim over the hero; hover restores full contrast.
                "bg-background/10 text-foreground/40 backdrop-blur-sm",
                "hover:bg-background/60 hover:text-foreground",
                // Visible chip stays small so it hides as little of the hero as
                // possible, but the hit area is padded out to 44px (WCAG 2.5.5).
                "before:absolute before:-inset-2 before:content-['']",
                "[&_svg]:size-3.5 xl:[&_svg]:size-4",
              )}
              onClick={onDismiss}
            >
              <XIcon />
            </button>
          </div>
          {/* Type and spacing step up once the card is meaningfully wider (xl),
                so a 28rem+ card is not a large hero over phone-sized copy. */}
          <div className="min-h-0 space-y-3 overflow-y-auto px-4 pt-3 pb-4 xl:space-y-4 xl:px-5 xl:pt-4 xl:pb-5">
            <div className="space-y-0.5">
              <p className="text-xs font-medium tracking-wide text-primary uppercase">
                {announcement.label}
              </p>
              <h2
                id={titleId}
                className="font-display text-base font-semibold tracking-tight xl:text-lg"
              >
                {announcement.title}
              </h2>
            </div>
            <ul className="space-y-3 xl:space-y-4">
              {announcement.highlights.map((highlight) => (
                <li key={highlight.title} className="flex gap-2.5 xl:gap-3">
                  <highlight.icon
                    aria-hidden="true"
                    className="mt-0.5 size-4 shrink-0 text-primary xl:size-5"
                  />
                  <div className="min-w-0 space-y-0.5">
                    <p className="text-sm font-medium leading-snug xl:text-base">
                      {highlight.title}
                    </p>
                    <p className="text-sm leading-snug text-muted-foreground xl:text-base">
                      {highlight.body}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
            <Link
              to={withReturnTo(announcement.ctaHref, returnTo)}
              className={cn(
                buttonVariants({ variant: "default", size: "sm" }),
                "w-full xl:h-10 xl:text-base",
              )}
              onClick={onCtaClick}
            >
              {announcement.ctaLabel}
            </Link>
          </div>
        </section>
      ) : null}
      {/* Mounted whether or not the card is showing, so the text below is an
          UPDATE to an existing region — see the live-region effect above. */}
      <p className="sr-only" role="status" aria-live="polite">
        {liveMessage}
      </p>
    </>
  );
}
