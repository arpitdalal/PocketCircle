import { useEffect, useEffectEvent } from "react";
import {
  useDisablePushSubscription,
  useEnablePushSubscription,
  usePushVapidPublicKey,
  useReconcilePushSubscription,
} from "~/lib/data.js";
import { MOCKS } from "~/lib/env.js";
import {
  readPushSubscriptionMaterial,
  registerPushServiceWorker,
} from "~/lib/push-subscriptions.js";

/**
 * Registers the Push SW (outside MOCKS) and reconciles the browser subscription
 * on mount + focus/visibility — never requests notification permission (#381).
 */
export function PushSubscriptionLifecycle() {
  const vapid = usePushVapidPublicKey();
  const reconcile = useReconcilePushSubscription();
  const enable = useEnablePushSubscription();
  const disable = useDisablePushSubscription();

  const runReconcile = useEffectEvent(async () => {
    if (!vapid) {
      return;
    }
    try {
      const result = await readPushSubscriptionMaterial(vapid);
      if (result.unboundEndpoint) {
        try {
          await disable({ endpoint: result.unboundEndpoint });
        } catch {
          // Best-effort old-endpoint cleanup during VAPID rotation.
        }
      }
      if (!result.subscription) {
        return;
      }
      if (result.unboundEndpoint) {
        // Replacement sub after rotation — explicit bind under current User.
        await enable(result.subscription);
        return;
      }
      await reconcile({ subscription: result.subscription });
    } catch {
      // Best-effort lifecycle — never surface unhandled rejections on focus.
    }
  });

  useEffect(() => {
    if (MOCKS) {
      return;
    }
    void registerPushServiceWorker();
    const onFocus = () => {
      void runReconcile();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void runReconcile();
      }
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  useEffect(() => {
    if (MOCKS || !vapid) {
      return;
    }
    void runReconcile();
  }, [vapid]);

  return null;
}
