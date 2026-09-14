import { tryDecodeVapidKeyBytes } from "@pocketcircle/domain";
import { XIcon } from "lucide-react";
import { useEffect, useEffectEvent, useId, useRef, useState, useSyncExternalStore } from "react";
import { href, Link } from "react-router";
import { isInstalledWebApp, isIosDevice, usePwaInstall } from "~/components/pwa-install.js";
import { Button } from "~/components/ui/button.js";
import { buttonVariants } from "~/components/ui/button-variants.js";
import {
  getAnalyticsCaptureReady,
  subscribeAnalyticsCaptureReady,
  track,
} from "~/lib/analytics.js";
import { useEnableNotifications, usePushVapidPublicKey } from "~/lib/data.js";
import { mutationErrorMessageForUser } from "~/lib/mutation-user-message.js";
import {
  hasRecordedNotificationAnnouncementImpression,
  isIosInstallPrerequisiteDismissed,
  isNotificationAnnouncementVisible,
  markNotificationAnnouncementImpressionRecorded,
  readNotificationAnnouncementDismissed,
  shouldSuppressNotificationAnnouncementForUiState,
  subscribeNotificationAnnouncementDismissed,
  writeNotificationAnnouncementDismissed,
} from "~/lib/notification-announcement.js";
import { useSnackbar } from "~/lib/snackbar.js";
import { usePushNotificationsUiState } from "~/lib/use-push-notifications-ui-state.js";
import { cn } from "~/lib/utils.js";

const TITLE = "Enable notifications on this device";
const BODY =
  "Get alerts for Circle activity while PocketCircle is closed. You can change this anytime in Settings.";

function subscribeDocumentVisible(onStoreChange: () => void) {
  document.addEventListener("visibilitychange", onStoreChange);
  return () => {
    document.removeEventListener("visibilitychange", onStoreChange);
  };
}

function getDocumentVisible() {
  return document.visibilityState === "visible";
}

/**
 * One-time, non-blocking notification announcement in document flow above the
 * sticky header (#383). Enable reuses the Settings subscription path; dismiss is
 * per-device localStorage. Never prompts without the Enable gesture.
 */
export function NotificationAnnouncementStrip({
  onOwnsTopSafeAreaChange,
}: {
  /** True while the strip covers the viewport top and must own notch inset alone. */
  onOwnsTopSafeAreaChange?: (owns: boolean) => void;
} = {}) {
  const vapid = usePushVapidPublicKey();
  const enableNotifications = useEnableNotifications();
  const { available, showInstallPrompt, installSurfaceOpen } = usePwaInstall();
  const { uiState } = usePushNotificationsUiState(vapid);
  const { show } = useSnackbar();
  const titleId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const dismissed = useSyncExternalStore(
    subscribeNotificationAnnouncementDismissed,
    readNotificationAnnouncementDismissed,
    () => false,
  );
  const documentVisible = useSyncExternalStore(
    subscribeDocumentVisible,
    getDocumentVisible,
    () => true,
  );
  const analyticsReady = useSyncExternalStore(
    subscribeAnalyticsCaptureReady,
    getAnalyticsCaptureReady,
    () => false,
  );
  const [submitting, setSubmitting] = useState(false);
  const [pendingDismissTrack, setPendingDismissTrack] = useState(false);
  const reportOwnsTopSafeArea = useEffectEvent((owns: boolean) => {
    onOwnsTopSafeAreaChange?.(owns);
  });

  const vapidUsable = Boolean(vapid && tryDecodeVapidKeyBytes(vapid.publicKey));
  const iosInstallPrerequisiteDismissed = isIosInstallPrerequisiteDismissed({
    isIos: isIosDevice(),
    installed: isInstalledWebApp(),
    installAvailable: available,
    showInstallPrompt,
  });

  // Anyone who already enabled Push on this device must not see the strip after
  // they later disable — persist dismiss when we observe an opted-in state.
  useEffect(() => {
    if (shouldSuppressNotificationAnnouncementForUiState(uiState)) {
      writeNotificationAnnouncementDismissed();
    }
  }, [uiState]);

  const visible = isNotificationAnnouncementVisible({
    dismissed,
    uiState,
    vapidUsable,
    iosInstallPrerequisiteDismissed,
  });
  // Genuine visibility for analytics / live region — install modal + background tabs.
  const liveVisible = visible && !installSurfaceOpen && documentVisible;

  useEffect(() => {
    if (!visible) {
      reportOwnsTopSafeArea(false);
      return;
    }
    const el = sectionRef.current;
    if (!el) {
      reportOwnsTopSafeArea(false);
      return;
    }
    const update = () => {
      // Own notch inset only while the strip's top edge is still at the viewport top.
      reportOwnsTopSafeArea(el.getBoundingClientRect().top <= 0.5);
    };
    update();
    const io = new IntersectionObserver(update, { threshold: [0, 1] });
    io.observe(el);
    window.addEventListener("scroll", update, { passive: true });
    return () => {
      io.disconnect();
      window.removeEventListener("scroll", update);
      reportOwnsTopSafeArea(false);
    };
  }, [visible]);

  useEffect(() => {
    if (!liveVisible || !analyticsReady) {
      return;
    }
    if (hasRecordedNotificationAnnouncementImpression()) {
      return;
    }
    // Mark only after capture succeeds so a cold-load race can retry.
    if (track("notification_announcement_impression", {})) {
      markNotificationAnnouncementImpressionRecorded();
    }
  }, [liveVisible, analyticsReady]);

  useEffect(() => {
    if (!analyticsReady || !pendingDismissTrack) {
      return;
    }
    if (track("notification_announcement_dismissed", {})) {
      setPendingDismissTrack(false);
    }
  }, [analyticsReady, pendingDismissTrack]);

  const onDismiss = () => {
    writeNotificationAnnouncementDismissed();
    if (!track("notification_announcement_dismissed", {})) {
      setPendingDismissTrack(true);
    }
  };

  const onEnable = () => {
    if (submitting) {
      return;
    }
    setSubmitting(true);
    void (async () => {
      try {
        await enableNotifications();
        writeNotificationAnnouncementDismissed();
        show("Notifications enabled on this device.");
      } catch (caught) {
        // One-time strip: after Enable settles, Settings is the retry path —
        // including native prompt dismissed with permission still `default`.
        writeNotificationAnnouncementDismissed();
        show(
          mutationErrorMessageForUser(
            caught,
            "Couldn't enable notifications. Please try again in Settings.",
          ),
        );
      } finally {
        setSubmitting(false);
      }
    })();
  };

  return (
    <>
      {uiState !== null ? (
        <div hidden data-testid="notification-announcement-probe" data-state={uiState} />
      ) : null}
      {visible ? (
        <section
          ref={sectionRef}
          aria-labelledby={titleId}
          className="border-b border-border bg-muted/40 pt-[calc(0.75rem+var(--safe-area-top))] pr-[max(1rem,var(--safe-area-right))] pb-3 pl-[max(1rem,var(--safe-area-left))]"
          data-testid="notification-announcement-strip"
        >
          {liveVisible ? (
            <div className="sr-only" role="status">
              {TITLE}. {BODY}
            </div>
          ) : null}
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1 space-y-1">
              <h2 id={titleId} className="font-display text-sm font-semibold tracking-tight">
                {TITLE}
              </h2>
              <p className="text-sm text-muted-foreground">{BODY}</p>
              <p className="text-xs text-muted-foreground">
                Or manage this later in{" "}
                <Link to={href("/settings")} className="underline underline-offset-2">
                  Settings
                </Link>
                .
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button type="button" size="sm" disabled={submitting} onClick={onEnable}>
                Enable notifications
              </Button>
              <button
                type="button"
                aria-label="Dismiss notification announcement"
                className={cn(
                  buttonVariants({ variant: "ghost", size: "icon-xs" }),
                  "shrink-0 text-muted-foreground",
                )}
                onClick={onDismiss}
              >
                <XIcon />
              </button>
            </div>
          </div>
        </section>
      ) : null}
    </>
  );
}
