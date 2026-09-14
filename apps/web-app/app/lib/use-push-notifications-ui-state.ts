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
import { useValueChange } from "~/lib/use-value-change.js";

function probePushUiState(
  vapid: { publicKey: string; keyId: string } | null | undefined,
  generation: { current: number },
  setUiState: (state: PushNotificationsUiState | null) => void,
) {
  const requestId = ++generation.current;
  return resolvePushNotificationsUiState(vapid)
    .then((state) => {
      if (requestId === generation.current) {
        setUiState(state);
      }
    })
    .catch(() => {
      if (requestId === generation.current) {
        setUiState("unsupported");
      }
    });
}

export function usePushNotificationsUiState(
  vapid: { publicKey: string; keyId: string } | null | undefined,
) {
  const [uiState, setUiState] = useState<PushNotificationsUiState | null>(null);
  const generation = useRef(0);
  const vapidKey = vapid?.publicKey ?? null;

  // Same-commit clear when the key identity changes — avoids one stale enableable frame.
  useValueChange(vapidKey, () => {
    setUiState(null);
  });

  useEffect(() => {
    void probePushUiState(vapid, generation, setUiState);
    const onRefresh = () => {
      void probePushUiState(vapid, generation, setUiState);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void probePushUiState(vapid, generation, setUiState);
      }
    };
    window.addEventListener("focus", onRefresh);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener(PUSH_SUBSCRIPTION_CHANGED_EVENT, onRefresh);

    // Chromium fires PermissionStatus.change when site permission flips in-place;
    // Safari often exposes the API but never fires — focus/visibility still cover it.
    let permissionStatus: PermissionStatus | null = null;
    let permissionQueryAlive = true;
    const permissions = navigator.permissions;
    if (permissions) {
      void permissions
        .query({ name: "notifications" })
        .then((status) => {
          if (!permissionQueryAlive) {
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
      generation.current += 1;
      permissionQueryAlive = false;
      window.removeEventListener("focus", onRefresh);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener(PUSH_SUBSCRIPTION_CHANGED_EVENT, onRefresh);
      permissionStatus?.removeEventListener("change", onRefresh);
    };
  }, [vapid]);

  return {
    /** Null until the first probe settles. */
    uiState,
    refresh: () => probePushUiState(vapid, generation, setUiState),
  };
}
