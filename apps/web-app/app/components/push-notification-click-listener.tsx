import { useEffect, useSyncExternalStore } from "react";
import { useNavigate } from "react-router";
import { getAnalyticsCapturePhase, subscribeAnalyticsCapturePhase } from "~/lib/analytics.js";
import {
  flushPendingNotificationOpenedTrack,
  handlePushNotificationClickMessage,
} from "~/lib/push-notification-click.js";

/**
 * SW postMessage fallback + flush deferred `notification_opened` after cold
 * analytics init (#384). Mounted on public + every protected auth gate.
 */
export function PushNotificationClickListener() {
  const navigate = useNavigate();
  const capturePhase = useSyncExternalStore(
    subscribeAnalyticsCapturePhase,
    getAnalyticsCapturePhase,
    () => "off" as const,
  );

  useEffect(() => {
    if (!("serviceWorker" in navigator)) {
      return;
    }
    const onMessage = (event: MessageEvent) => {
      handlePushNotificationClickMessage(event.data, navigate);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => {
      navigator.serviceWorker.removeEventListener("message", onMessage);
    };
  }, [navigate]);

  useEffect(() => {
    // Ready → capture; off (opt-out / teardown) → drop queue so it cannot survive re-opt-in.
    if (capturePhase !== "deferred") {
      flushPendingNotificationOpenedTrack();
    }
  }, [capturePhase]);

  return null;
}
