import { tryDecodeVapidKeyBytes } from "@pocketcircle/domain";
import { XIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { href, Link } from "react-router";
import { isInstalledWebApp, isIosDevice, usePwaInstall } from "~/components/pwa-install.js";
import { Button } from "~/components/ui/button.js";
import { buttonVariants } from "~/components/ui/button-variants.js";
import { track } from "~/lib/analytics.js";
import { useEnableNotifications, usePushVapidPublicKey } from "~/lib/data.js";
import { mutationErrorMessageForUser } from "~/lib/mutation-user-message.js";
import {
  hasRecordedNotificationAnnouncementImpression,
  isIosInstallPrerequisiteDismissed,
  isNotificationAnnouncementVisible,
  markNotificationAnnouncementImpressionRecorded,
  readNotificationAnnouncementDismissed,
  writeNotificationAnnouncementDismissed,
} from "~/lib/notification-announcement.js";
import { useSnackbar } from "~/lib/snackbar.js";
import { usePushNotificationsUiState } from "~/lib/use-push-notifications-ui-state.js";
import { cn } from "~/lib/utils.js";

const TITLE = "Enable notifications on this device";
const BODY =
  "Get alerts for Circle activity while PocketCircle is closed. You can change this anytime in Settings.";

/**
 * One-time, non-blocking notification announcement in document flow above the
 * sticky header (#383). Enable reuses the Settings subscription path; dismiss is
 * per-device localStorage. Never prompts without the Enable gesture.
 */
export function NotificationAnnouncementStrip() {
  const vapid = usePushVapidPublicKey();
  const enableNotifications = useEnableNotifications();
  const { available, showInstallPrompt, installSurfaceOpen } = usePwaInstall();
  const { uiState } = usePushNotificationsUiState(vapid);
  const { show } = useSnackbar();
  const titleId = useId();
  const [dismissed, setDismissed] = useState(readNotificationAnnouncementDismissed);
  const [submitting, setSubmitting] = useState(false);

  const vapidUsable = Boolean(vapid && tryDecodeVapidKeyBytes(vapid.publicKey));
  const iosInstallPrerequisiteDismissed = isIosInstallPrerequisiteDismissed({
    isIos: isIosDevice(),
    installed: isInstalledWebApp(),
    installAvailable: available,
    showInstallPrompt,
  });

  const visible = isNotificationAnnouncementVisible({
    dismissed,
    uiState,
    vapidUsable,
    iosInstallPrerequisiteDismissed,
  });
  // Genuine visibility for analytics / live region — install modal covers the strip.
  const liveVisible = visible && !installSurfaceOpen;

  useEffect(() => {
    if (!liveVisible) {
      return;
    }
    if (!hasRecordedNotificationAnnouncementImpression()) {
      markNotificationAnnouncementImpressionRecorded();
      track("notification_announcement_impression", {});
    }
  }, [liveVisible]);

  const dismissStrip = () => {
    writeNotificationAnnouncementDismissed();
    setDismissed(true);
  };

  const onDismiss = () => {
    track("notification_announcement_dismissed", {});
    dismissStrip();
  };

  const onEnable = () => {
    if (submitting) {
      return;
    }
    setSubmitting(true);
    void (async () => {
      try {
        await enableNotifications();
        dismissStrip();
        show("Notifications enabled on this device.");
      } catch (caught) {
        // One-time strip: after Enable settles, Settings is the retry path —
        // including native prompt dismissed with permission still `default`.
        dismissStrip();
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

  if (!visible) {
    return null;
  }

  return (
    <section
      aria-labelledby={titleId}
      className="border-b border-border bg-muted/40 px-4 pt-[calc(0.75rem+var(--safe-area-top))] pb-3"
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
  );
}
