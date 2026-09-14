/**
 * Shared Push UI-state probe for Settings and the notification announcement
 * strip (#381 / #383). Refreshes on focus, visibility, subscription changes,
 * and Notification permission changes where the Permissions API fires them.
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
    // Drop the previous probe immediately so a vapid change cannot briefly keep
    // the prior enableable state with a new key / null key.
    setUiState(null);
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
    // Generation after the initial refresh bump — stale permission queries must
    // not attach listeners after this effect has been replaced.
    const subscribeGeneration = refreshGeneration.current;
    const onRefresh = () => {
      void refresh();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void refresh();
      }
    };
    window.addEventListener("focus", onRefresh);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener(PUSH_SUBSCRIPTION_CHANGED_EVENT, onRefresh);

    // Chromium fires PermissionStatus.change when site permission flips in-place;
    // Safari often exposes the API but never fires — focus/visibility still cover it.
    let permissionStatus: PermissionStatus | null = null;
    const permissions = navigator.permissions;
    if (permissions) {
      void permissions
        .query({ name: "notifications" })
        .then((status) => {
          if (refreshGeneration.current !== subscribeGeneration) {
            return;
          }
          permissionStatus = status;
          status.addEventListener("change", onRefresh);
        })
        .catch(() => {
          // Permissions API unavailable or notifications name unsupported.
        });
    }

    return () => {
      // Invalidate in-flight refresh so a late resolve cannot overwrite callers.
      refreshGeneration.current += 1;
      window.removeEventListener("focus", onRefresh);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener(PUSH_SUBSCRIPTION_CHANGED_EVENT, onRefresh);
      permissionStatus?.removeEventListener("change", onRefresh);
    };
  }, [vapid]);

  return {
    /** Null until the first probe settles. */
    uiState,
    refresh: () => refreshRunner.current(),
  };
}
