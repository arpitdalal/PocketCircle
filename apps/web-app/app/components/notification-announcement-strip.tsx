import { tryDecodeVapidKeyBytes } from "@pocketcircle/domain";
import { XIcon } from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { href, Link } from "react-router";
import { isInstalledWebApp, isIosDevice, usePwaInstall } from "~/components/pwa-install.js";
import { Button } from "~/components/ui/button.js";
import { buttonVariants } from "~/components/ui/button-variants.js";
import {
  getAnalyticsCapturePhase,
  subscribeAnalyticsCaptureReady,
  track,
} from "~/lib/analytics.js";
import { useEnableNotifications, usePushVapidPublicKey } from "~/lib/data.js";
import { mutationErrorMessageForUser } from "~/lib/mutation-user-message.js";
import {
  flushPendingNotificationAnnouncementDismissTrack,
  hasRecordedNotificationAnnouncementImpression,
  isIosInstallPrerequisiteDismissed,
  isNotificationAnnouncementVisible,
  markNotificationAnnouncementImpressionRecorded,
  readNotificationAnnouncementDismissed,
  shouldSuppressNotificationAnnouncementForUiState,
  stripOwnsTopSafeArea,
  subscribeNotificationAnnouncementDismissed,
  trackNotificationAnnouncementDismissed,
  writeNotificationAnnouncementDismissed,
} from "~/lib/notification-announcement.js";
import { useAppSession } from "~/lib/session.js";
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
  const session = useAppSession();
  const userId = session.state === "ready" ? session.user.id : null;
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
  const capturePhase = useSyncExternalStore(
    subscribeAnalyticsCaptureReady,
    getAnalyticsCapturePhase,
    () => "off",
  );
  const analyticsReady = capturePhase === "ready";
  const [submitting, setSubmitting] = useState(false);
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

  useLayoutEffect(() => {
    if (!visible) {
      reportOwnsTopSafeArea(false);
      return;
    }
    const el = sectionRef.current;
    if (!el) {
      reportOwnsTopSafeArea(false);
      return;
    }
    // Assume top ownership on show (eligible strip mounts at scroll top); scroll/IO correct it.
    reportOwnsTopSafeArea(true);
    const update = () => {
      reportOwnsTopSafeArea(stripOwnsTopSafeArea(el.getBoundingClientRect()));
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
    if (!liveVisible || !analyticsReady || userId === null) {
      return;
    }
    if (hasRecordedNotificationAnnouncementImpression(userId)) {
      return;
    }
    // Mark only after capture succeeds so a cold-load race can retry.
    if (track("notification_announcement_impression", {})) {
      markNotificationAnnouncementImpressionRecorded(userId);
    }
  }, [liveVisible, analyticsReady, userId]);

  useEffect(() => {
    if (userId === null) {
      return;
    }
    // Ready → capture; off (opt-out / teardown) → drop queue so it cannot survive re-opt-in.
    if (capturePhase !== "deferred") {
      flushPendingNotificationAnnouncementDismissTrack(userId);
    }
  }, [capturePhase, userId]);

  const onDismiss = () => {
    writeNotificationAnnouncementDismissed();
    if (userId !== null) {
      trackNotificationAnnouncementDismissed(userId);
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
