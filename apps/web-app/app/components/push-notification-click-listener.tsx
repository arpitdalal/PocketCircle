import { useEffect } from "react";
import { useNavigate } from "react-router";
import { handlePushNotificationClickMessage } from "~/lib/push-notification-click.js";

/**
 * Fallback when the service worker can focus a client but not navigate it
 * (older browsers). Routes into `/from-notification?n=…` for the shared resolver.
 */
export function PushNotificationClickListener() {
  const navigate = useNavigate();

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

  return null;
}
