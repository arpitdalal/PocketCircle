/**
 * Shared Push UI-state probe for Settings and the notification announcement
 * strip (#381 / #383). Refreshes on focus, visibility, and subscription changes.
 */
import { useEffect, useRef, useState } from "react";
import {
  PUSH_SUBSCRIPTION_CHANGED_EVENT,
  type PushNotificationsUiState,
  resolvePushNotificationsUiState,
} from "~/lib/push-subscriptions.js";

export function usePushNotificationsUiState(
  vapid: { publicKey: string; keyId: string } | null | undefined,
) {
  const [uiState, setUiState] = useState<PushNotificationsUiState | null>(null);
  const refreshGeneration = useRef(0);
  const refreshRunner = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    const refresh = () => {
      const requestId = ++refreshGeneration.current;
      return resolvePushNotificationsUiState(vapid)
        .then((state) => {
          if (requestId === refreshGeneration.current) {
            setUiState(state);
          }
        })
        .catch(() => {
          if (requestId === refreshGeneration.current) {
            setUiState("unsupported");
          }
        });
    };
    refreshRunner.current = refresh;
    void refresh();
    const onFocus = () => {
      void refresh();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void refresh();
      }
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener(PUSH_SUBSCRIPTION_CHANGED_EVENT, onFocus);
    return () => {
      // Invalidate in-flight refresh so a late resolve cannot overwrite callers.
      refreshGeneration.current += 1;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener(PUSH_SUBSCRIPTION_CHANGED_EVENT, onFocus);
    };
  }, [vapid]);

  return {
    /** Null until the first probe settles. */
    uiState,
    refresh: () => refreshRunner.current(),
  };
}
