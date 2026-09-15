import { parsePushNotificationClickSearch } from "@pocketcircle/domain";
import { useEffect, useEffectEvent } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { Splash } from "~/components/splash.js";
import {
  useMarkNotificationRead,
  useResolvePushNotificationClick,
} from "~/lib/data/notifications.js";
import { applyPushNotificationClickResult } from "~/lib/push-notification-click.js";
import { useAppSession } from "~/lib/session.js";

/**
 * Authenticated Push click landing (#384). Resolves destination from Notification
 * identity with live access checks, then replace-navigates and marks read only
 * after apply succeeds. Unauthenticated visitors are redirected to sign-in with
 * this path as returnTo.
 */
export default function FromNotification() {
  const session = useAppSession();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const resolveClick = useResolvePushNotificationClick();
  const markRead = useMarkNotificationRead();

  const notificationId = parsePushNotificationClickSearch(searchParams);
  const sessionReady = session.state === "ready" && session.user.onboardingComplete === true;

  const runResolve = useEffectEvent(async (id: string, signal: AbortSignal) => {
    try {
      const result = await resolveClick({ notificationId: id });
      if (signal.aborted) {
        return;
      }
      await applyPushNotificationClickResult(
        result,
        async (to, opts) => {
          // Abort before destination apply must not navigate or mark.
          if (signal.aborted) {
            throw new DOMException("Aborted", "AbortError");
          }
          await navigate(to, opts);
        },
        async (markId) => {
          // After navigate, unmount aborts this effect — still mark read.
          // Successful resolution already applied the destination.
          await markRead({ notificationId: markId });
        },
      );
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        return;
      }
      void navigate("/", { replace: true });
    }
  });

  useEffect(() => {
    if (!sessionReady || !notificationId) {
      return;
    }
    const ac = new AbortController();
    void runResolve(notificationId, ac.signal);
    return () => {
      ac.abort();
    };
  }, [sessionReady, notificationId]);

  if (!notificationId) {
    return <Navigate to="/" replace />;
  }

  return <Splash />;
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}
